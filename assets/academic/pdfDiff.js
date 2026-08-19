/// <reference path="./globals.d.ts" />
import { compareRasters, compareTextTokens, fullPageRegion, } from "./pdfDiffAlgorithm.mjs";
"use strict";
(function () {
    const maxRenderDimension = 1200;
    const maxRenderScale = 1.25;
    const maximumCachedPageResults = 64;
    const maximumConcurrentPageComparisons = 2;
    const maximumQueuedPages = 16;
    let config;
    let enabled = false;
    let modifiedDocumentReady = false;
    let modifiedFingerprint = "";
    let originalFingerprint = "";
    let originalIsEmptyRevision = false;
    let modifiedIsEmptyRevision = false;
    let originalLoadingTask = null;
    let originalDocument = null;
    let comparisonGeneration = 0;
    let pageGeneration = 0;
    let activePageComparisons = 0;
    const pageResults = new Map();
    const pendingPages = new Map();
    const queuedPages = new Map();
    let removedPageRange = null;
    let selectedChange = null;
    let statusElement = null;
    let scrollSyncFrame = null;
    let remoteScrollReleaseFrame = null;
    let applyingRemoteScroll = false;
    let lastSentScrollAnchor = null;
    window.addEventListener("load", () => {
        config = loadConfig();
        initializeStatus();
        window.addEventListener("message", event => {
            if (isDocumentLoadMessage(event.data)) {
                handleDocumentLoad(event.data);
            }
            else if (isDiffEnableMessage(event.data)) {
                void enableDiff(event.data);
            }
            else if (isDiffDisableMessage(event.data)) {
                disableDiff();
            }
            else if (isDiffApplyPageMessage(event.data)) {
                applyForwardedPage(event.data);
            }
            else if (isDiffRemovedPageRangeMessage(event.data)) {
                applyRemovedPageRange(event.data);
            }
            else if (isDiffNavigateMessage(event.data)) {
                navigateChange(event.data.direction);
            }
            else if (isDiffApplyScrollMessage(event.data)) {
                applySynchronizedScroll(event.data);
            }
        });
        window.PDFViewerApplication.initializedPromise.then(() => {
            initializeScrollSync();
            const eventBus = window.PDFViewerApplication.eventBus;
            eventBus.on("documentloaded", () => {
                modifiedDocumentReady = config.diffRole === "modified";
                if (config.diffRole === "modified") {
                    resetPageResults();
                    scheduleCurrentPage();
                }
                else {
                    applyCurrentPage();
                }
            });
            eventBus.on("pagerendered", (event) => {
                if (config.diffRole === "modified") {
                    schedulePage(event.pageNumber);
                }
                else {
                    applyPageResult(event.pageNumber);
                }
            });
            eventBus.on("pagechanging", (event) => {
                clearSelectedChange();
                if (config.diffRole === "modified") {
                    schedulePage(event.pageNumber);
                }
                else {
                    applyPageResult(event.pageNumber);
                }
                updateStatus();
            });
        });
    }, { once: true });
    function loadConfig() {
        const element = document.getElementById("pdf-preview-config");
        const value = element?.getAttribute("data-config");
        if (!value) {
            throw new Error("Could not load PDF diff configuration.");
        }
        return JSON.parse(value);
    }
    function isDocumentLoadMessage(value) {
        return isMessage(value, "document.load");
    }
    function isDiffEnableMessage(value) {
        return isMessage(value, "diff.setEnabled")
            && value.enabled === true
            && (value.role === "original"
                || value.role === "modified");
    }
    function isDiffDisableMessage(value) {
        return isMessage(value, "diff.setEnabled")
            && value.enabled === false;
    }
    function isDiffApplyPageMessage(value) {
        return isMessage(value, "diff.applyPage")
            && typeof value.pageNumber === "number"
            && Array.isArray(value.regions);
    }
    function isDiffRemovedPageRangeMessage(value) {
        return isMessage(value, "diff.setRemovedPageRange")
            && typeof value.fromPage === "number"
            && typeof value.toPage === "number";
    }
    function isDiffNavigateMessage(value) {
        return isMessage(value, "diff.navigate")
            && (value.direction === "next"
                || value.direction === "previous");
    }
    function isDiffApplyScrollMessage(value) {
        if (!isMessage(value, "diff.applyScroll")) {
            return false;
        }
        const message = value;
        return typeof message.pageNumber === "number"
            && Number.isSafeInteger(message.pageNumber)
            && message.pageNumber >= 1
            && typeof message.pageRatio === "number"
            && Number.isFinite(message.pageRatio)
            && message.pageRatio >= 0
            && message.pageRatio <= 1
            && typeof message.documentRatio === "number"
            && Number.isFinite(message.documentRatio)
            && message.documentRatio >= 0
            && message.documentRatio <= 1;
    }
    function isMessage(value, type) {
        return typeof value === "object"
            && value !== null
            && "type" in value
            && value.type === type;
    }
    function handleDocumentLoad(message) {
        pageGeneration += 1;
        modifiedFingerprint = message.fingerprint;
        modifiedDocumentReady = false;
        lastSentScrollAnchor = null;
        if (config.diffRole === "modified" || !enabled) {
            resetPageResults();
        }
        else {
            clearOverlays();
        }
        if (message.isEmptyRevision) {
            clearOverlays();
        }
        updateStatus();
    }
    async function enableDiff(message) {
        const currentComparisonGeneration = ++comparisonGeneration;
        pageGeneration += 1;
        enabled = true;
        resetPageResults();
        if (message.role === "original") {
            if (message.allPagesChanged) {
                removedPageRange = { fromPage: 1, toPage: Number.MAX_SAFE_INTEGER };
                applyCurrentPage();
            }
            updateStatus();
            return;
        }
        originalFingerprint = message.originalFingerprint;
        originalIsEmptyRevision = message.originalIsEmptyRevision;
        modifiedIsEmptyRevision = message.modifiedIsEmptyRevision;
        await disposeOriginalDocument();
        if (!enabled || comparisonGeneration !== currentComparisonGeneration) {
            return;
        }
        if (modifiedIsEmptyRevision) {
            updateStatus();
            return;
        }
        if (originalIsEmptyRevision) {
            scheduleCurrentPage();
            return;
        }
        const startedAt = performance.now();
        try {
            const loadingTask = pdfjsLib.getDocument({
                data: new Uint8Array(message.originalData),
                isEvalSupported: false,
                useWorkerFetch: false,
                cMapUrl: config.cMapUrl,
                cMapPacked: true,
                iccUrl: config.iccUrl,
                standardFontDataUrl: config.standardFontDataUrl,
                wasmUrl: config.wasmUrl
            });
            originalLoadingTask = loadingTask;
            const documentProxy = await loadingTask.promise;
            if (!enabled
                || comparisonGeneration !== currentComparisonGeneration
                || originalLoadingTask !== loadingTask) {
                await loadingTask.destroy();
                return;
            }
            originalDocument = documentProxy;
            const modifiedPages = window.PDFViewerApplication.pdfDocument?.numPages ?? 0;
            if (documentProxy.numPages > modifiedPages) {
                postExtensionMessage({
                    type: "diff.removedPageRange",
                    fromPage: modifiedPages + 1,
                    toPage: documentProxy.numPages
                });
            }
            scheduleCurrentPage();
        }
        catch (error) {
            if (comparisonGeneration !== currentComparisonGeneration) {
                return;
            }
            reportDebug("diffFailed", {
                fingerprint: modifiedFingerprint,
                originalFingerprint,
                durationMs: elapsedSince(startedAt),
                error: getErrorMessage(error)
            });
        }
    }
    function disableDiff() {
        comparisonGeneration += 1;
        pageGeneration += 1;
        enabled = false;
        modifiedIsEmptyRevision = false;
        resetPageResults();
        void disposeOriginalDocument();
        updateStatus();
    }
    async function disposeOriginalDocument() {
        const loadingTask = originalLoadingTask;
        originalLoadingTask = null;
        originalDocument = null;
        if (loadingTask) {
            const startedAt = performance.now();
            try {
                await loadingTask.destroy();
            }
            catch (error) {
                reportDebug("diffFailed", {
                    fingerprint: modifiedFingerprint,
                    originalFingerprint,
                    durationMs: elapsedSince(startedAt),
                    error: getErrorMessage(error)
                });
            }
        }
    }
    function resetPageResults() {
        pageResults.clear();
        pendingPages.clear();
        queuedPages.clear();
        removedPageRange = null;
        clearSelectedChange();
        clearOverlays();
        updateStatus();
    }
    function scheduleCurrentPage() {
        const pageNumber = window.PDFViewerApplication.pdfViewer?.currentPageNumber;
        if (typeof pageNumber === "number") {
            schedulePage(pageNumber);
        }
    }
    function applyCurrentPage() {
        const pageNumber = window.PDFViewerApplication.pdfViewer?.currentPageNumber;
        if (typeof pageNumber === "number") {
            applyPageResult(pageNumber);
        }
    }
    function schedulePage(pageNumber) {
        if (!enabled || !modifiedDocumentReady || (!originalDocument && !originalIsEmptyRevision)) {
            return;
        }
        const cached = pageResults.get(pageNumber);
        if (cached !== undefined) {
            pageResults.delete(pageNumber);
            pageResults.set(pageNumber, cached);
            applyPageResult(pageNumber);
            return;
        }
        if (pendingPages.has(pageNumber)) {
            return;
        }
        const currentGeneration = pageGeneration;
        queuedPages.delete(pageNumber);
        queuedPages.set(pageNumber, currentGeneration);
        updateStatus();
        while (queuedPages.size > maximumQueuedPages) {
            const oldestPage = queuedPages.keys().next().value;
            if (oldestPage === undefined) {
                break;
            }
            queuedPages.delete(oldestPage);
        }
        drainPageQueue();
    }
    function drainPageQueue() {
        while (activePageComparisons < maximumConcurrentPageComparisons && queuedPages.size > 0) {
            const next = queuedPages.entries().next().value;
            if (!next) {
                return;
            }
            const [pageNumber, currentGeneration] = next;
            queuedPages.delete(pageNumber);
            if (!enabled
                || !modifiedDocumentReady
                || pageGeneration !== currentGeneration
                || (!originalDocument && !originalIsEmptyRevision)) {
                continue;
            }
            activePageComparisons += 1;
            const task = computeAndApplyPage(pageNumber, currentGeneration);
            pendingPages.set(pageNumber, task);
            void task.finally(() => {
                activePageComparisons -= 1;
                if (pendingPages.get(pageNumber) === task) {
                    pendingPages.delete(pageNumber);
                }
                drainPageQueue();
            });
        }
    }
    async function computeAndApplyPage(pageNumber, currentGeneration) {
        const startedAt = performance.now();
        try {
            const result = await computePageDiff(pageNumber);
            if (!enabled || pageGeneration !== currentGeneration) {
                return;
            }
            rememberPageResult(pageNumber, result.modifiedRegions);
            applyPageResult(pageNumber);
            postExtensionMessage({
                type: "diff.pageResult",
                pageNumber,
                originalRegions: result.originalRegions
            });
            reportDebug("diffComputed", {
                fingerprint: modifiedFingerprint,
                originalFingerprint,
                pageNumber,
                durationMs: elapsedSince(startedAt),
                strategy: result.strategy,
                regions: result.originalRegions.length + result.modifiedRegions.length,
                changedPixels: result.changedPixels
            });
        }
        catch (error) {
            if (pageGeneration !== currentGeneration) {
                return;
            }
            reportDebug("diffFailed", {
                fingerprint: modifiedFingerprint,
                originalFingerprint,
                pageNumber,
                durationMs: elapsedSince(startedAt),
                error: getErrorMessage(error)
            });
        }
    }
    async function computePageDiff(pageNumber) {
        const modifiedDocument = window.PDFViewerApplication.pdfDocument;
        if (!modifiedDocument) {
            throw new Error("The modified PDF is not loaded.");
        }
        if (originalIsEmptyRevision || !originalDocument || pageNumber > originalDocument.numPages) {
            return {
                originalRegions: [],
                modifiedRegions: [fullPageRegion()],
                changedPixels: -1,
                strategy: "page"
            };
        }
        const [originalPage, modifiedPage] = await Promise.all([
            originalDocument.getPage(pageNumber),
            modifiedDocument.getPage(pageNumber)
        ]);
        const originalViewport = originalPage.getViewport({ scale: 1 });
        const modifiedViewport = modifiedPage.getViewport({ scale: 1 });
        if (Math.abs(originalViewport.width - modifiedViewport.width) > 0.5
            || Math.abs(originalViewport.height - modifiedViewport.height) > 0.5) {
            return {
                originalRegions: [fullPageRegion()],
                modifiedRegions: [fullPageRegion()],
                changedPixels: -1,
                strategy: "page"
            };
        }
        const largestDimension = Math.max(modifiedViewport.width, modifiedViewport.height);
        const scale = Math.min(maxRenderScale, maxRenderDimension / largestDimension);
        const textResult = await comparePageText(originalPage, modifiedPage, scale, pageNumber);
        if (textResult) {
            return textResult;
        }
        const [originalRaster, modifiedRaster] = await Promise.all([
            renderPage(originalPage, scale),
            renderPage(modifiedPage, scale)
        ]);
        return compareRasters(originalRaster, modifiedRaster);
    }
    function rememberPageResult(pageNumber, regions) {
        pageResults.delete(pageNumber);
        pageResults.set(pageNumber, regions);
        while (pageResults.size > maximumCachedPageResults) {
            const oldestPage = pageResults.keys().next().value;
            if (oldestPage === undefined) {
                return;
            }
            pageResults.delete(oldestPage);
        }
    }
    async function renderPage(page, scale) {
        const viewport = page.getViewport({ scale });
        const width = Math.max(1, Math.ceil(viewport.width));
        const height = Math.max(1, Math.ceil(viewport.height));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (!context) {
            throw new Error("Could not create a canvas for PDF comparison.");
        }
        await page.render({
            canvasContext: context,
            viewport,
            background: "rgb(255, 255, 255)"
        }).promise;
        const pixels = context.getImageData(0, 0, width, height).data;
        canvas.width = 0;
        canvas.height = 0;
        return { width, height, pixels };
    }
    async function comparePageText(originalPage, modifiedPage, scale, pageNumber) {
        const startedAt = performance.now();
        try {
            const [originalContent, modifiedContent] = await Promise.all([
                originalPage.getTextContent(),
                modifiedPage.getTextContent()
            ]);
            const originalViewport = originalPage.getViewport({ scale });
            const modifiedViewport = modifiedPage.getViewport({ scale });
            const originalTokens = collectTextTokens(originalContent.items, originalViewport);
            const modifiedTokens = collectTextTokens(modifiedContent.items, modifiedViewport);
            return compareTextTokens(originalTokens, modifiedTokens, originalViewport.width, originalViewport.height, modifiedViewport.width, modifiedViewport.height);
        }
        catch (error) {
            reportDebug("diffTextFallback", {
                fingerprint: modifiedFingerprint,
                originalFingerprint,
                pageNumber,
                durationMs: elapsedSince(startedAt),
                error: getErrorMessage(error)
            });
            return null;
        }
    }
    function collectTextTokens(items, viewport) {
        const tokens = [];
        for (const item of items) {
            if (typeof item.str !== "string" || !item.str.trim() || !Array.isArray(item.transform)) {
                continue;
            }
            const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
            const itemWidth = Math.abs(Number(item.width) * viewport.scale);
            const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]));
            const top = transform[5] - fontHeight;
            const bottom = transform[5] + fontHeight * 0.2;
            const matches = item.str.matchAll(/\S+/gu);
            for (const match of matches) {
                const start = match.index;
                const end = start + match[0].length;
                const left = transform[4] + itemWidth * start / item.str.length;
                const right = transform[4] + itemWidth * end / item.str.length;
                tokens.push({
                    text: match[0].normalize(),
                    left: Math.min(left, right),
                    top: Math.min(top, bottom),
                    right: Math.max(left, right),
                    bottom: Math.max(top, bottom),
                    changedPixels: 1
                });
            }
        }
        return tokens;
    }
    function applyForwardedPage(message) {
        if (config.diffRole !== "original") {
            return;
        }
        rememberPageResult(message.pageNumber, message.regions);
        applyPageResult(message.pageNumber);
    }
    function applyRemovedPageRange(message) {
        if (config.diffRole !== "original") {
            return;
        }
        removedPageRange = {
            fromPage: message.fromPage,
            toPage: message.toPage
        };
        applyCurrentPage();
    }
    function applyPageResult(pageNumber) {
        const regions = regionsForPage(pageNumber);
        if (regions !== undefined) {
            applyOverlay(pageNumber, regions);
        }
        updateStatus();
    }
    function regionsForPage(pageNumber) {
        if (removedPageRange
            && pageNumber >= removedPageRange.fromPage
            && pageNumber <= removedPageRange.toPage) {
            return [fullPageRegion()];
        }
        return pageResults.get(pageNumber);
    }
    function navigateChange(direction) {
        if (!enabled) {
            return;
        }
        const viewer = window.PDFViewerApplication.pdfViewer;
        const pageNumber = viewer?.currentPageNumber;
        if (!viewer || typeof pageNumber !== "number") {
            return;
        }
        const regions = regionsForPage(pageNumber);
        if (!regions || regions.length === 0) {
            updateStatus();
            return;
        }
        const previousIndex = selectedChange?.pageNumber === pageNumber
            ? selectedChange.index
            : direction === "next" ? -1 : 0;
        const index = direction === "next"
            ? (previousIndex + 1) % regions.length
            : (previousIndex - 1 + regions.length) % regions.length;
        selectedChange = { pageNumber, index };
        applyOverlay(pageNumber, regions);
        const pageView = viewer.getPageView(pageNumber - 1);
        const markers = pageView?.div.querySelectorAll(".academicPdfDiffRegion");
        const marker = markers?.[index];
        marker?.classList.add("academicPdfDiffRegion--selected");
        marker?.scrollIntoView({ block: "center", inline: "center" });
        updateStatus();
    }
    function clearSelectedChange() {
        selectedChange = null;
        document.querySelectorAll(".academicPdfDiffRegion--selected")
            .forEach(marker => marker.classList.remove("academicPdfDiffRegion--selected"));
    }
    function initializeStatus() {
        if (!config.diffRole) {
            return;
        }
        const toolbar = document.getElementById("toolbarViewerLeft");
        if (!toolbar) {
            return;
        }
        statusElement = document.createElement("span");
        statusElement.className = `academicPdfDiffStatus academicPdfDiffStatus--${config.diffRole}`;
        statusElement.setAttribute("role", "status");
        statusElement.setAttribute("aria-live", "polite");
        toolbar.appendChild(statusElement);
        updateStatus();
    }
    function updateStatus() {
        if (!statusElement || !config.diffRole) {
            return;
        }
        statusElement.classList.toggle("academicPdfDiffStatus--enabled", enabled);
        const label = config.diffLabel
            ?? (config.diffRole === "original" ? "Original" : "Modified");
        statusElement.textContent = `${label} · Highlights ${enabled ? "on" : "off"}`;
        statusElement.title = statusElement.textContent;
    }
    function postExtensionMessage(message) {
        window.dispatchEvent(new CustomEvent("academic-pdf-message", { detail: message }));
    }
    function initializeScrollSync() {
        if (!config.diffRole) {
            return;
        }
        window.PDFViewerApplication.pdfViewer.container.addEventListener("scroll", scheduleScrollSync, { passive: true });
    }
    function scheduleScrollSync() {
        if (applyingRemoteScroll || scrollSyncFrame !== null) {
            return;
        }
        scrollSyncFrame = window.requestAnimationFrame(() => {
            scrollSyncFrame = null;
            if (applyingRemoteScroll) {
                return;
            }
            const anchor = readScrollAnchor();
            if (!anchor || isSameScrollAnchor(anchor, lastSentScrollAnchor)) {
                return;
            }
            lastSentScrollAnchor = anchor;
            postExtensionMessage({ type: "diff.scroll", ...anchor });
        });
    }
    function readScrollAnchor() {
        const viewer = window.PDFViewerApplication.pdfViewer;
        const pageCount = viewer.pagesCount;
        if (pageCount < 1) {
            return null;
        }
        const scrollTop = viewer.container.scrollTop;
        let pageNumber = Math.min(Math.max(viewer.currentPageNumber, 1), pageCount);
        let pageView = viewer.getPageView(pageNumber - 1);
        if (!pageView) {
            return null;
        }
        while (pageNumber > 1 && pageView.div.offsetTop > scrollTop + 1) {
            const previousPage = viewer.getPageView(pageNumber - 2);
            if (!previousPage) {
                break;
            }
            pageNumber -= 1;
            pageView = previousPage;
        }
        while (pageNumber < pageCount) {
            const nextPage = viewer.getPageView(pageNumber);
            if (!nextPage || nextPage.div.offsetTop > scrollTop + 1) {
                break;
            }
            pageNumber += 1;
            pageView = nextPage;
        }
        const pageHeight = pageView.div.offsetHeight;
        if (pageHeight < 1) {
            return null;
        }
        return {
            pageNumber,
            pageRatio: clampUnit((scrollTop - pageView.div.offsetTop) / pageHeight),
            documentRatio: clampUnit(scrollTop / Math.max(1, viewer.container.scrollHeight - viewer.container.clientHeight))
        };
    }
    function isSameScrollAnchor(first, second) {
        return second !== null
            && first.pageNumber === second.pageNumber
            && Math.abs(first.pageRatio - second.pageRatio) < 0.0005
            && Math.abs(first.documentRatio - second.documentRatio) < 0.0005;
    }
    function applySynchronizedScroll(message) {
        if (!config.diffRole) {
            return;
        }
        const viewer = window.PDFViewerApplication.pdfViewer;
        if (viewer.pagesCount < 1) {
            return;
        }
        const container = viewer.container;
        const maximumScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        let targetScrollTop;
        if (message.pageNumber > viewer.pagesCount) {
            targetScrollTop = message.documentRatio * maximumScrollTop;
        }
        else {
            const pageView = viewer.getPageView(message.pageNumber - 1);
            if (!pageView || pageView.div.offsetHeight < 1) {
                return;
            }
            targetScrollTop = Math.min(maximumScrollTop, Math.max(0, pageView.div.offsetTop + message.pageRatio * pageView.div.offsetHeight));
        }
        if (Math.abs(container.scrollTop - targetScrollTop) < 0.5) {
            return;
        }
        applyingRemoteScroll = true;
        if (remoteScrollReleaseFrame !== null) {
            window.cancelAnimationFrame(remoteScrollReleaseFrame);
        }
        container.scrollTop = targetScrollTop;
        remoteScrollReleaseFrame = window.requestAnimationFrame(() => {
            remoteScrollReleaseFrame = window.requestAnimationFrame(() => {
                applyingRemoteScroll = false;
                remoteScrollReleaseFrame = null;
            });
        });
    }
    function clampUnit(value) {
        return Math.min(1, Math.max(0, value));
    }
    function applyOverlay(pageNumber, regions) {
        const pageView = window.PDFViewerApplication.pdfViewer?.getPageView(pageNumber - 1);
        const pageElement = pageView?.div;
        if (!pageElement) {
            return;
        }
        pageElement.querySelector(".academicPdfDiffLayer")?.remove();
        if (!enabled || regions.length === 0) {
            return;
        }
        const layer = document.createElement("div");
        layer.className = "academicPdfDiffLayer";
        layer.setAttribute("aria-hidden", "true");
        for (const [index, region] of regions.entries()) {
            const marker = document.createElement("div");
            marker.className = `academicPdfDiffRegion academicPdfDiffRegion--${config.diffRole ?? "modified"}`;
            if (selectedChange?.pageNumber === pageNumber && selectedChange.index === index) {
                marker.classList.add("academicPdfDiffRegion--selected");
            }
            marker.style.left = `${region.left * 100}%`;
            marker.style.top = `${region.top * 100}%`;
            marker.style.width = `${region.width * 100}%`;
            marker.style.height = `${region.height * 100}%`;
            layer.appendChild(marker);
        }
        pageElement.appendChild(layer);
    }
    function clearOverlays() {
        document.querySelectorAll(".academicPdfDiffLayer").forEach(layer => layer.remove());
    }
    function reportDebug(event, fields) {
        if (!config.debug) {
            return;
        }
        window.dispatchEvent(new CustomEvent("academic-pdf-debug", {
            detail: { type: "pdf.debug", event, ...fields }
        }));
    }
    function elapsedSince(startedAt) {
        return Math.round(performance.now() - startedAt);
    }
    function getErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
}());
