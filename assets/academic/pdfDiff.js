/// <reference path="./globals.d.ts" />
"use strict";
(function () {
    const maxRenderDimension = 1200;
    const maxRenderScale = 1.25;
    const colorDeltaThreshold = 60;
    const minimumChangedPixelsPerRegion = 3;
    const minimumTextMatchRatio = 0.5;
    const maximumTextTokensPerPage = 1500;
    const maximumRunsPerPage = 20000;
    const maximumComponentsToMerge = 1000;
    const maximumRegionsPerPage = 200;
    const horizontalMergeDistance = 6;
    const verticalMergeDistance = 3;
    const regionPadding = 2;
    let config;
    let enabled = false;
    let modifiedDocumentReady = false;
    let modifiedFingerprint = "";
    let originalFingerprint = "";
    let originalIsEmptyRevision = false;
    let originalLoadingTask = null;
    let originalDocument = null;
    let comparisonGeneration = 0;
    let pageGeneration = 0;
    const pageResults = new Map();
    const pendingPages = new Map();
    window.addEventListener("load", () => {
        config = loadConfig();
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
        });
        window.PDFViewerApplication.initializedPromise.then(() => {
            const eventBus = window.PDFViewerApplication.eventBus;
            eventBus.on("documentloaded", () => {
                modifiedDocumentReady = true;
                resetPageResults();
                scheduleCurrentPage();
            });
            eventBus.on("pagerendered", (event) => {
                schedulePage(event.pageNumber);
            });
            eventBus.on("pagechanging", (event) => {
                schedulePage(event.pageNumber);
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
            && value.enabled === true;
    }
    function isDiffDisableMessage(value) {
        return isMessage(value, "diff.setEnabled")
            && value.enabled === false;
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
        resetPageResults();
        if (message.isEmptyRevision) {
            clearOverlays();
        }
    }
    async function enableDiff(message) {
        const currentComparisonGeneration = ++comparisonGeneration;
        pageGeneration += 1;
        enabled = true;
        originalFingerprint = message.originalFingerprint;
        originalIsEmptyRevision = message.originalIsEmptyRevision;
        resetPageResults();
        await disposeOriginalDocument();
        if (!enabled || comparisonGeneration !== currentComparisonGeneration) {
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
        resetPageResults();
        void disposeOriginalDocument();
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
        clearOverlays();
    }
    function scheduleCurrentPage() {
        const pageNumber = window.PDFViewerApplication.pdfViewer?.currentPageNumber;
        if (typeof pageNumber === "number") {
            schedulePage(pageNumber);
        }
    }
    function schedulePage(pageNumber) {
        if (!enabled || !modifiedDocumentReady || (!originalDocument && !originalIsEmptyRevision)) {
            return;
        }
        const cached = pageResults.get(pageNumber);
        if (cached) {
            applyOverlay(pageNumber, cached);
            return;
        }
        if (pendingPages.has(pageNumber)) {
            return;
        }
        const currentGeneration = pageGeneration;
        const task = computeAndApplyPage(pageNumber, currentGeneration);
        pendingPages.set(pageNumber, task);
        void task.finally(() => {
            if (pendingPages.get(pageNumber) === task) {
                pendingPages.delete(pageNumber);
            }
        });
    }
    async function computeAndApplyPage(pageNumber, currentGeneration) {
        const startedAt = performance.now();
        try {
            const result = await computePageDiff(pageNumber);
            if (!enabled || pageGeneration !== currentGeneration) {
                return;
            }
            pageResults.set(pageNumber, result.regions);
            applyOverlay(pageNumber, result.regions);
            reportDebug("diffComputed", {
                fingerprint: modifiedFingerprint,
                originalFingerprint,
                pageNumber,
                durationMs: elapsedSince(startedAt),
                strategy: result.strategy,
                regions: result.regions.length,
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
            return { regions: [fullPageRegion()], changedPixels: -1, strategy: "page" };
        }
        const [originalPage, modifiedPage] = await Promise.all([
            originalDocument.getPage(pageNumber),
            modifiedDocument.getPage(pageNumber)
        ]);
        const originalViewport = originalPage.getViewport({ scale: 1 });
        const modifiedViewport = modifiedPage.getViewport({ scale: 1 });
        if (Math.abs(originalViewport.width - modifiedViewport.width) > 0.5
            || Math.abs(originalViewport.height - modifiedViewport.height) > 0.5) {
            return { regions: [fullPageRegion()], changedPixels: -1, strategy: "page" };
        }
        const largestDimension = Math.max(modifiedViewport.width, modifiedViewport.height);
        const scale = Math.min(maxRenderScale, maxRenderDimension / largestDimension);
        const textRegions = await comparePageText(originalPage, modifiedPage, scale, pageNumber);
        if (textRegions) {
            return { regions: textRegions, changedPixels: -1, strategy: "text" };
        }
        const [originalRaster, modifiedRaster] = await Promise.all([
            renderPage(originalPage, scale),
            renderPage(modifiedPage, scale)
        ]);
        return compareRasters(originalRaster, modifiedRaster);
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
            if (originalTokens.length === 0
                || modifiedTokens.length === 0
                || originalTokens.length > maximumTextTokensPerPage
                || modifiedTokens.length > maximumTextTokensPerPage
                || textTokensEqual(originalTokens, modifiedTokens)) {
                return null;
            }
            const matches = findTextTokenMatches(originalTokens, modifiedTokens);
            if (matches.length / Math.min(originalTokens.length, modifiedTokens.length)
                < minimumTextMatchRatio) {
                return null;
            }
            let regions = collectChangedTextRegions(originalTokens, modifiedTokens, matches);
            regions = mergeNearbyRegions(regions);
            if (regions.length > maximumRegionsPerPage) {
                regions = [boundingPixelRegion(regions)];
            }
            return regions.map(region => toNormalizedRegion(region, modifiedViewport.width, modifiedViewport.height));
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
    function textTokensEqual(original, modified) {
        return original.length === modified.length
            && original.every((token, index) => token.text === modified[index].text);
    }
    function findTextTokenMatches(original, modified) {
        const lengths = Array.from({ length: original.length + 1 }, () => new Uint16Array(modified.length + 1));
        for (let originalIndex = 1; originalIndex <= original.length; originalIndex += 1) {
            for (let modifiedIndex = 1; modifiedIndex <= modified.length; modifiedIndex += 1) {
                lengths[originalIndex][modifiedIndex] = original[originalIndex - 1].text
                    === modified[modifiedIndex - 1].text
                    ? lengths[originalIndex - 1][modifiedIndex - 1] + 1
                    : Math.max(lengths[originalIndex - 1][modifiedIndex], lengths[originalIndex][modifiedIndex - 1]);
            }
        }
        const matches = [];
        let originalIndex = original.length;
        let modifiedIndex = modified.length;
        while (originalIndex > 0 && modifiedIndex > 0) {
            if (original[originalIndex - 1].text === modified[modifiedIndex - 1].text) {
                matches.push({ original: originalIndex - 1, modified: modifiedIndex - 1 });
                originalIndex -= 1;
                modifiedIndex -= 1;
            }
            else if (lengths[originalIndex - 1][modifiedIndex]
                >= lengths[originalIndex][modifiedIndex - 1]) {
                originalIndex -= 1;
            }
            else {
                modifiedIndex -= 1;
            }
        }
        return matches.reverse();
    }
    function collectChangedTextRegions(original, modified, matches) {
        const regions = [];
        let originalStart = 0;
        let modifiedStart = 0;
        for (let index = 0; index <= matches.length; index += 1) {
            const match = matches[index];
            const originalEnd = match?.original ?? original.length;
            const modifiedEnd = match?.modified ?? modified.length;
            const changedTokens = modifiedStart < modifiedEnd
                ? modified.slice(modifiedStart, modifiedEnd)
                : original.slice(originalStart, originalEnd);
            regions.push(...changedTokens.map(token => ({
                left: token.left,
                top: token.top,
                right: token.right,
                bottom: token.bottom,
                changedPixels: 1
            })));
            if (match) {
                originalStart = match.original + 1;
                modifiedStart = match.modified + 1;
            }
        }
        return regions;
    }
    function compareRasters(original, modified) {
        if (original.width !== modified.width || original.height !== modified.height) {
            return { regions: [fullPageRegion()], changedPixels: -1, strategy: "page" };
        }
        const components = [];
        let previousRuns = [];
        let changedPixels = 0;
        let totalRuns = 0;
        for (let y = 0; y < modified.height; y += 1) {
            const currentRuns = collectChangedRuns(original, modified, y);
            changedPixels += currentRuns.reduce((sum, run) => sum + run.changedPixels, 0);
            totalRuns += currentRuns.length;
            if (totalRuns > maximumRunsPerPage) {
                return { regions: [fullPageRegion()], changedPixels: -1, strategy: "page" };
            }
            connectRuns(currentRuns, previousRuns, y, components);
            previousRuns = currentRuns;
        }
        if (changedPixels === 0) {
            return { regions: [], changedPixels, strategy: "raster" };
        }
        let pixelRegions = components
            .filter((component, index) => findComponent(components, index) === index
            && component.changedPixels >= minimumChangedPixelsPerRegion)
            .map(component => ({
            left: component.left,
            top: component.top,
            right: component.right,
            bottom: component.bottom,
            changedPixels: component.changedPixels
        }));
        if (pixelRegions.length === 0) {
            return { regions: [], changedPixels, strategy: "raster" };
        }
        pixelRegions = pixelRegions.length <= maximumComponentsToMerge
            ? mergeNearbyRegions(pixelRegions)
            : [boundingPixelRegion(pixelRegions)];
        if (pixelRegions.length > maximumRegionsPerPage) {
            pixelRegions = [boundingPixelRegion(pixelRegions)];
        }
        return {
            regions: pixelRegions.map(region => toNormalizedRegion(region, modified.width, modified.height)),
            changedPixels,
            strategy: "raster"
        };
    }
    function collectChangedRuns(original, modified, row) {
        const runs = [];
        let runStart = -1;
        let runPixels = 0;
        for (let x = 0; x <= modified.width; x += 1) {
            let changed = false;
            if (x < modified.width) {
                const pixel = (row * modified.width + x) * 4;
                const delta = Math.abs(original.pixels[pixel] - modified.pixels[pixel])
                    + Math.abs(original.pixels[pixel + 1] - modified.pixels[pixel + 1])
                    + Math.abs(original.pixels[pixel + 2] - modified.pixels[pixel + 2]);
                changed = delta > colorDeltaThreshold;
            }
            if (changed) {
                if (runStart < 0) {
                    runStart = x;
                }
                runPixels += 1;
            }
            else if (runStart >= 0) {
                runs.push({
                    left: runStart,
                    right: x,
                    changedPixels: runPixels,
                    component: -1
                });
                runStart = -1;
                runPixels = 0;
            }
        }
        return runs;
    }
    function connectRuns(currentRuns, previousRuns, row, components) {
        let firstPrevious = 0;
        for (const run of currentRuns) {
            while (firstPrevious < previousRuns.length
                && previousRuns[firstPrevious].right < run.left) {
                firstPrevious += 1;
            }
            let component = -1;
            for (let index = firstPrevious; index < previousRuns.length && previousRuns[index].left <= run.right; index += 1) {
                const previousComponent = findComponent(components, previousRuns[index].component);
                component = component < 0
                    ? previousComponent
                    : unionComponents(components, component, previousComponent);
            }
            if (component < 0) {
                component = createComponent(components, run, row);
            }
            else {
                addRunToComponent(components, component, run, row);
            }
            run.component = findComponent(components, component);
        }
    }
    function createComponent(components, run, row) {
        const index = components.length;
        components.push({
            parent: index,
            left: run.left,
            top: row,
            right: run.right,
            bottom: row + 1,
            changedPixels: run.changedPixels
        });
        return index;
    }
    function addRunToComponent(components, component, run, row) {
        const root = findComponent(components, component);
        const region = components[root];
        region.left = Math.min(region.left, run.left);
        region.top = Math.min(region.top, row);
        region.right = Math.max(region.right, run.right);
        region.bottom = Math.max(region.bottom, row + 1);
        region.changedPixels += run.changedPixels;
    }
    function findComponent(components, component) {
        let root = component;
        while (components[root].parent !== root) {
            root = components[root].parent;
        }
        while (components[component].parent !== component) {
            const parent = components[component].parent;
            components[component].parent = root;
            component = parent;
        }
        return root;
    }
    function unionComponents(components, first, second) {
        const firstRoot = findComponent(components, first);
        const secondRoot = findComponent(components, second);
        if (firstRoot === secondRoot) {
            return firstRoot;
        }
        const target = components[firstRoot];
        const source = components[secondRoot];
        source.parent = firstRoot;
        target.left = Math.min(target.left, source.left);
        target.top = Math.min(target.top, source.top);
        target.right = Math.max(target.right, source.right);
        target.bottom = Math.max(target.bottom, source.bottom);
        target.changedPixels += source.changedPixels;
        return firstRoot;
    }
    function mergeNearbyRegions(regions) {
        const merged = [];
        const sorted = [...regions].sort((first, second) => first.top - second.top || first.left - second.left);
        for (const region of sorted) {
            let current = region;
            let mergedAnother;
            do {
                mergedAnother = false;
                for (let index = 0; index < merged.length; index += 1) {
                    if (!shouldMergeRegions(merged[index], current)) {
                        continue;
                    }
                    current = unionPixelRegions(merged[index], current);
                    merged.splice(index, 1);
                    mergedAnother = true;
                    break;
                }
            } while (mergedAnother);
            merged.push(current);
        }
        return merged.sort((first, second) => first.top - second.top || first.left - second.left);
    }
    function shouldMergeRegions(first, second) {
        const horizontalGap = intervalGap(first.left, first.right, second.left, second.right);
        const verticalGap = intervalGap(first.top, first.bottom, second.top, second.bottom);
        const verticalOverlap = intervalOverlap(first.top, first.bottom, second.top, second.bottom);
        const horizontalOverlap = intervalOverlap(first.left, first.right, second.left, second.right);
        const minimumHeight = Math.min(first.bottom - first.top, second.bottom - second.top);
        const minimumWidth = Math.min(first.right - first.left, second.right - second.left);
        const sameLine = verticalOverlap >= minimumHeight * 0.6
            && horizontalGap <= horizontalMergeDistance;
        const sameGlyph = horizontalOverlap >= minimumWidth * 0.5
            && verticalGap <= verticalMergeDistance;
        return horizontalGap === 0 && verticalGap === 0 || sameLine || sameGlyph;
    }
    function intervalGap(firstStart, firstEnd, secondStart, secondEnd) {
        return Math.max(0, Math.max(firstStart, secondStart) - Math.min(firstEnd, secondEnd));
    }
    function intervalOverlap(firstStart, firstEnd, secondStart, secondEnd) {
        return Math.max(0, Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart));
    }
    function unionPixelRegions(first, second) {
        return {
            left: Math.min(first.left, second.left),
            top: Math.min(first.top, second.top),
            right: Math.max(first.right, second.right),
            bottom: Math.max(first.bottom, second.bottom),
            changedPixels: first.changedPixels + second.changedPixels
        };
    }
    function boundingPixelRegion(regions) {
        return regions.reduce((result, region) => unionPixelRegions(result, region));
    }
    function toNormalizedRegion(region, pageWidth, pageHeight) {
        const paddedLeft = Math.max(0, region.left - regionPadding);
        const paddedTop = Math.max(0, region.top - regionPadding);
        const paddedRight = Math.min(pageWidth, region.right + regionPadding);
        const paddedBottom = Math.min(pageHeight, region.bottom + regionPadding);
        return {
            left: paddedLeft / pageWidth,
            top: paddedTop / pageHeight,
            width: (paddedRight - paddedLeft) / pageWidth,
            height: (paddedBottom - paddedTop) / pageHeight
        };
    }
    function fullPageRegion() {
        return { left: 0.01, top: 0.01, width: 0.98, height: 0.98 };
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
        for (const region of regions) {
            const marker = document.createElement("div");
            marker.className = "academicPdfDiffRegion";
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
