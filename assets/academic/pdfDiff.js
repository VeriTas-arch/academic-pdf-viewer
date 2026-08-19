/// <reference path="./globals.d.ts" />
import { compareRasters, compareTextTokens, findNextDiffPage, fullPageRegion, nextDiffRegionIndex, } from "./pdfDiffAlgorithm.mjs";
"use strict";
(function () {
    const maxRenderDimension = 1200;
    const maxRenderScale = 1.25;
    const maximumCachedPageResults = 64;
    const maximumConcurrentPageComparisons = 2;
    const eagerComparisonPageLimit = 16;
    const maximumQueuedPages = eagerComparisonPageLimit;
    const comparisonPrefetchRadius = 3;
    const pdfjsAdapter = window.academicPdfJsAdapter;
    let config;
    let enabled = false;
    let currentSessionId = 0;
    let modifiedDocumentReady = false;
    let modifiedFingerprint = "";
    let originalFingerprint = "";
    let originalIsEmptyRevision = false;
    let modifiedIsEmptyRevision = false;
    let originalLoadingTask = null;
    let originalDocument = null;
    let comparisonGeneration = 0;
    let pageGeneration = 0;
    let navigationGeneration = 0;
    let scanGeneration = 0;
    let activePageComparisons = 0;
    const pageResults = new Map();
    const counterpartPageResults = new Map();
    const pendingPages = new Map();
    const activePageTasks = new Set();
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
                disableDiff(event.data);
            }
            else if (isDiffApplyPageMessage(event.data)) {
                applyForwardedPage(event.data);
            }
            else if (isDiffRemovedPageRangeMessage(event.data)) {
                applyRemovedPageRange(event.data);
            }
            else if (isDiffNavigateMessage(event.data)) {
                navigateChange(event.data);
            }
            else if (isDiffScanForChangeMessage(event.data)) {
                scanForForwardedChange(event.data);
            }
            else if (isDiffRevealChangeMessage(event.data)) {
                applyForwardedNavigation(event.data);
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
                    scheduleComparisonPages();
                }
                else {
                    applyComparisonPages();
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
                navigationGeneration += 1;
                scanGeneration += 1;
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
            && isPositiveInteger(value.sessionId)
            && (value.role === "original"
                || value.role === "modified");
    }
    function isDiffDisableMessage(value) {
        return isMessage(value, "diff.setEnabled")
            && value.enabled === false
            && isPositiveInteger(value.sessionId);
    }
    function isDiffApplyPageMessage(value) {
        return isMessage(value, "diff.applyPage")
            && isPositiveInteger(value.sessionId)
            && typeof value.pageNumber === "number"
            && Array.isArray(value.regions);
    }
    function isDiffRemovedPageRangeMessage(value) {
        return isMessage(value, "diff.setRemovedPageRange")
            && isPositiveInteger(value.sessionId)
            && typeof value.fromPage === "number"
            && typeof value.toPage === "number";
    }
    function isDiffNavigateMessage(value) {
        return isMessage(value, "diff.navigate")
            && isPositiveInteger(value.sessionId)
            && (value.direction === "next"
                || value.direction === "previous");
    }
    function isDiffScanForChangeMessage(value) {
        return isMessage(value, "diff.scanForChange")
            && isPositiveInteger(value.sessionId)
            && isPositiveInteger(value.requestId)
            && (value.role === "original"
                || value.role === "modified")
            && (value.direction === "next"
                || value.direction === "previous")
            && isPositiveInteger(value.startPage);
    }
    function isDiffRevealChangeMessage(value) {
        if (!isMessage(value, "diff.revealChange")) {
            return false;
        }
        const message = value;
        return isPositiveInteger(message.sessionId)
            && isPositiveInteger(message.requestId)
            && isPositiveInteger(message.pageNumber)
            && typeof message.index === "number"
            && Number.isSafeInteger(message.index)
            && message.index >= 0
            && Array.isArray(message.regions)
            && message.index < message.regions.length;
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
    function isPositiveInteger(value) {
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
    }
    function handleDocumentLoad(message) {
        pageGeneration += 1;
        navigationGeneration += 1;
        scanGeneration += 1;
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
        if (message.sessionId < currentSessionId) {
            return;
        }
        currentSessionId = message.sessionId;
        const currentComparisonGeneration = ++comparisonGeneration;
        pageGeneration += 1;
        navigationGeneration += 1;
        scanGeneration += 1;
        enabled = true;
        resetPageResults();
        if (message.role === "original") {
            if (message.allPagesChanged) {
                removedPageRange = { fromPage: 1, toPage: Number.MAX_SAFE_INTEGER };
                applyComparisonPages();
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
            scheduleComparisonPages();
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
                    sessionId: currentSessionId,
                    fromPage: modifiedPages + 1,
                    toPage: documentProxy.numPages
                });
            }
            scheduleComparisonPages();
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
    function disableDiff(message) {
        if (message.sessionId < currentSessionId) {
            return;
        }
        currentSessionId = message.sessionId;
        comparisonGeneration += 1;
        pageGeneration += 1;
        navigationGeneration += 1;
        scanGeneration += 1;
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
        counterpartPageResults.clear();
        pendingPages.clear();
        queuedPages.clear();
        removedPageRange = null;
        clearSelectedChange();
        clearOverlays();
        updateStatus();
    }
    function scheduleComparisonPages(reapplyCached = true) {
        const viewer = pdfjsAdapter.getViewer();
        const container = pdfjsAdapter.getViewerContainer(viewer);
        if (!viewer) {
            return;
        }
        const range = comparisonPageRange(viewer, container);
        if (!range) {
            return;
        }
        for (let index = range.firstIndex; index <= range.lastIndex; index += 1) {
            const pageView = viewer.getPageView(index);
            if (pageView) {
                schedulePage(pageView.id, reapplyCached);
            }
        }
    }
    function comparisonPageRange(viewer, container) {
        if (viewer.pagesCount < 1) {
            return null;
        }
        const currentIndex = Math.min(viewer.pagesCount - 1, Math.max(0, viewer.currentPageNumber - 1));
        let firstIndex = viewer.pagesCount <= eagerComparisonPageLimit
            ? 0
            : Math.max(0, currentIndex - comparisonPrefetchRadius);
        let lastIndex = viewer.pagesCount <= eagerComparisonPageLimit
            ? viewer.pagesCount - 1
            : Math.min(viewer.pagesCount - 1, currentIndex + comparisonPrefetchRadius);
        if (container && viewer.pagesCount > eagerComparisonPageLimit) {
            const containerRect = container.getBoundingClientRect();
            for (let index = currentIndex - 1; index >= 0; index -= 1) {
                const pageView = viewer.getPageView(index);
                if (!pageView || pageView.div.getBoundingClientRect().bottom <= containerRect.top) {
                    break;
                }
                firstIndex = Math.min(firstIndex, index);
            }
            for (let index = currentIndex + 1; index < viewer.pagesCount; index += 1) {
                const pageView = viewer.getPageView(index);
                if (!pageView || pageView.div.getBoundingClientRect().top >= containerRect.bottom) {
                    break;
                }
                lastIndex = Math.max(lastIndex, index);
            }
        }
        return { firstIndex, lastIndex };
    }
    function applyComparisonPages(onlyMissing = false) {
        const viewer = pdfjsAdapter.getViewer();
        const container = pdfjsAdapter.getViewerContainer(viewer);
        if (!viewer) {
            return;
        }
        const range = comparisonPageRange(viewer, container);
        if (!range) {
            return;
        }
        for (let index = range.firstIndex; index <= range.lastIndex; index += 1) {
            const pageView = viewer.getPageView(index);
            if (!pageView
                || onlyMissing && pageView.div.querySelector(".academicPdfDiffLayer")) {
                continue;
            }
            applyPageResult(pageView.id);
        }
    }
    function schedulePage(pageNumber, reapplyCached = true) {
        if (!enabled || !modifiedDocumentReady || (!originalDocument && !originalIsEmptyRevision)) {
            return;
        }
        const cached = pageResults.get(pageNumber);
        if (cached !== undefined) {
            if (!reapplyCached) {
                return;
            }
            pageResults.delete(pageNumber);
            pageResults.set(pageNumber, cached);
            const counterpart = counterpartPageResults.get(pageNumber);
            if (counterpart !== undefined) {
                counterpartPageResults.delete(pageNumber);
                counterpartPageResults.set(pageNumber, counterpart);
                postExtensionMessage({
                    type: "diff.pageResult",
                    sessionId: currentSessionId,
                    pageNumber,
                    originalRegions: counterpart
                });
            }
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
            startPageComparison(pageNumber, currentGeneration);
        }
    }
    function startPageComparison(pageNumber, currentGeneration) {
        activePageComparisons += 1;
        const task = computeAndApplyPage(pageNumber, currentGeneration);
        pendingPages.set(pageNumber, task);
        activePageTasks.add(task);
        void task.finally(() => {
            activePageComparisons -= 1;
            activePageTasks.delete(task);
            if (pendingPages.get(pageNumber) === task) {
                pendingPages.delete(pageNumber);
            }
            drainPageQueue();
        });
        return task;
    }
    async function computeAndApplyPage(pageNumber, currentGeneration) {
        const startedAt = performance.now();
        try {
            const result = await computePageDiff(pageNumber);
            if (!enabled || pageGeneration !== currentGeneration) {
                return undefined;
            }
            rememberComputedPageResult(pageNumber, result);
            applyPageResult(pageNumber);
            postExtensionMessage({
                type: "diff.pageResult",
                sessionId: currentSessionId,
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
            return result;
        }
        catch (error) {
            if (pageGeneration !== currentGeneration) {
                return undefined;
            }
            reportDebug("diffFailed", {
                fingerprint: modifiedFingerprint,
                originalFingerprint,
                pageNumber,
                durationMs: elapsedSince(startedAt),
                error: getErrorMessage(error)
            });
            return undefined;
        }
    }
    async function computePageDiff(pageNumber) {
        const modifiedDocument = window.PDFViewerApplication.pdfDocument;
        if (!modifiedDocument) {
            throw new Error("The modified PDF is not loaded.");
        }
        if (pageNumber > modifiedDocument.numPages) {
            return {
                originalRegions: [fullPageRegion()],
                modifiedRegions: [],
                changedPixels: -1,
                strategy: "page"
            };
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
    function rememberComputedPageResult(pageNumber, result) {
        pageResults.delete(pageNumber);
        counterpartPageResults.delete(pageNumber);
        pageResults.set(pageNumber, result.modifiedRegions);
        counterpartPageResults.set(pageNumber, result.originalRegions);
        while (pageResults.size > maximumCachedPageResults) {
            const oldestPage = pageResults.keys().next().value;
            if (oldestPage === undefined) {
                return;
            }
            pageResults.delete(oldestPage);
            counterpartPageResults.delete(oldestPage);
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
        if (config.diffRole !== "original" || message.sessionId !== currentSessionId) {
            return;
        }
        rememberPageResult(message.pageNumber, message.regions);
        applyPageResult(message.pageNumber);
    }
    function applyRemovedPageRange(message) {
        if (config.diffRole !== "original" || message.sessionId !== currentSessionId) {
            return;
        }
        removedPageRange = {
            fromPage: message.fromPage,
            toPage: message.toPage
        };
        applyComparisonPages();
    }
    function applyPageResult(pageNumber) {
        const regions = regionsForPage(pageNumber);
        if (regions !== undefined) {
            applyOverlay(pageNumber, regions);
        }
        if (selectedChange?.pageNumber === pageNumber) {
            const selectedIndex = selectedChange.index;
            window.requestAnimationFrame(() => {
                if (selectedChange?.pageNumber !== pageNumber
                    || selectedChange.index !== selectedIndex) {
                    return;
                }
                const pageView = window.PDFViewerApplication.pdfViewer?.getPageView(pageNumber - 1);
                const markers = pageView?.div.querySelectorAll(".academicPdfDiffRegion");
                markers?.[selectedIndex]?.scrollIntoView({ block: "center", inline: "center" });
            });
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
    function navigateChange(message) {
        if (!enabled || message.sessionId !== currentSessionId || !config.diffRole) {
            return;
        }
        const viewer = window.PDFViewerApplication.pdfViewer;
        const pageNumber = viewer?.currentPageNumber;
        if (!viewer || typeof pageNumber !== "number") {
            return;
        }
        const requestId = ++navigationGeneration;
        scanGeneration += 1;
        const regions = regionsForPage(pageNumber);
        const selectedIndex = selectedChange?.pageNumber === pageNumber
            ? selectedChange.index
            : undefined;
        const localIndex = nextDiffRegionIndex(regions?.length ?? 0, selectedIndex, message.direction);
        if (localIndex !== undefined && regions) {
            revealChange(pageNumber, localIndex, regions);
            return;
        }
        const step = message.direction === "next" ? 1 : -1;
        const startPage = regions === undefined ? pageNumber : pageNumber + step;
        if (config.diffRole === "original") {
            const unresolvedPage = navigateKnownOriginalPages(startPage, message.direction);
            if (unresolvedPage === undefined) {
                return;
            }
            postExtensionMessage({
                type: "diff.navigationRequest",
                sessionId: currentSessionId,
                requestId,
                role: "original",
                direction: message.direction,
                startPage: unresolvedPage
            });
            return;
        }
        void scanForChange({
            sessionId: currentSessionId,
            requestId,
            role: "modified",
            direction: message.direction,
            startPage
        }, false);
    }
    function navigateKnownOriginalPages(startPage, direction) {
        const viewer = window.PDFViewerApplication.pdfViewer;
        const step = direction === "next" ? 1 : -1;
        for (let pageNumber = startPage; pageNumber >= 1 && pageNumber <= viewer.pagesCount; pageNumber += step) {
            const regions = regionsForPage(pageNumber);
            if (regions === undefined) {
                return pageNumber;
            }
            if (regions.length > 0) {
                revealChange(pageNumber, direction === "next" ? 0 : regions.length - 1, regions);
                return undefined;
            }
        }
        return undefined;
    }
    function scanForForwardedChange(message) {
        if (config.diffRole !== "modified" || message.sessionId !== currentSessionId) {
            return;
        }
        void scanForChange(message, true);
    }
    async function scanForChange(request, forwardResult) {
        const currentScanGeneration = ++scanGeneration;
        const modifiedDocument = window.PDFViewerApplication.pdfDocument;
        const lastPage = request.role === "original"
            ? originalDocument?.numPages ?? 0
            : modifiedDocument?.numPages ?? 0;
        const target = await findNextDiffPage(request.startPage, lastPage, request.direction, async (pageNumber) => {
            const result = await ensurePageComparison(pageNumber, request.sessionId, currentScanGeneration);
            if (!result
                || !isCurrentScan(request.sessionId, currentScanGeneration)
                || (!forwardResult && navigationGeneration !== request.requestId)) {
                return undefined;
            }
            return request.role === "original"
                ? result.originalRegions
                : result.modifiedRegions;
        });
        if (!target
            || !isCurrentScan(request.sessionId, currentScanGeneration)
            || (!forwardResult && navigationGeneration !== request.requestId)) {
            return;
        }
        if (forwardResult) {
            postExtensionMessage({
                type: "diff.navigationResult",
                sessionId: request.sessionId,
                requestId: request.requestId,
                role: request.role,
                pageNumber: target.pageNumber,
                index: target.index,
                regions: target.regions
            });
        }
        else {
            revealChange(target.pageNumber, target.index, target.regions);
        }
    }
    async function ensurePageComparison(pageNumber, sessionId, currentScanGeneration) {
        const cached = cachedComparison(pageNumber);
        if (cached) {
            return cached;
        }
        const pending = pendingPages.get(pageNumber);
        if (pending) {
            await pending;
            return isCurrentScan(sessionId, currentScanGeneration)
                ? cachedComparison(pageNumber)
                : undefined;
        }
        queuedPages.delete(pageNumber);
        while (activePageComparisons >= maximumConcurrentPageComparisons) {
            const activeTasks = [...activePageTasks];
            if (activeTasks.length === 0) {
                return undefined;
            }
            await Promise.race(activeTasks);
            if (!isCurrentScan(sessionId, currentScanGeneration)) {
                return undefined;
            }
            const completed = cachedComparison(pageNumber);
            if (completed) {
                return completed;
            }
        }
        if (!isCurrentScan(sessionId, currentScanGeneration)) {
            return undefined;
        }
        const result = await startPageComparison(pageNumber, pageGeneration);
        return result
            ? {
                originalRegions: result.originalRegions,
                modifiedRegions: result.modifiedRegions
            }
            : undefined;
    }
    function cachedComparison(pageNumber) {
        const modifiedRegions = pageResults.get(pageNumber);
        const originalRegions = counterpartPageResults.get(pageNumber);
        return modifiedRegions !== undefined && originalRegions !== undefined
            ? { originalRegions, modifiedRegions }
            : undefined;
    }
    function isCurrentScan(sessionId, currentScanGeneration) {
        return enabled
            && currentSessionId === sessionId
            && scanGeneration === currentScanGeneration;
    }
    function applyForwardedNavigation(message) {
        if (config.diffRole !== "original"
            || message.sessionId !== currentSessionId
            || message.requestId !== navigationGeneration) {
            return;
        }
        rememberPageResult(message.pageNumber, message.regions);
        revealChange(message.pageNumber, message.index, message.regions);
    }
    function revealChange(pageNumber, index, regions) {
        const viewer = window.PDFViewerApplication.pdfViewer;
        if (index < 0 || index >= regions.length || pageNumber > viewer.pagesCount) {
            return;
        }
        if (viewer.currentPageNumber !== pageNumber) {
            viewer.currentPageNumber = pageNumber;
        }
        selectedChange = { pageNumber, index };
        applyPageResult(pageNumber);
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
        const toolbar = pdfjsAdapter.getToolbarHost();
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
        if (scrollSyncFrame !== null) {
            return;
        }
        scrollSyncFrame = window.requestAnimationFrame(() => {
            scrollSyncFrame = null;
            if (config.diffRole === "modified") {
                scheduleComparisonPages(false);
            }
            else if (config.diffRole === "original") {
                applyComparisonPages(true);
            }
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
