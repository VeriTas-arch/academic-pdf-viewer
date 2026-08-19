/// <reference path="./globals.d.ts" />

import {
    compareRasters,
    compareTextTokens,
    findNextDiffPage,
    fullPageRegion,
    nextDiffRegionIndex,
    type DiffRegion,
    type DiffChangeKind,
    type DiffStrategy,
    type PageDiffResult,
    type RasterPage,
    type TextToken,
} from "./pdfDiffAlgorithm.mjs";
import {
    PageComparisonScheduler,
    type ScheduledPageComparison,
} from "./pdfDiffScheduler.mjs";

"use strict";

(function () {
    interface ViewerConfig {
        cMapUrl: string;
        debug: boolean;
        iccUrl: string;
        standardFontDataUrl: string;
        wasmUrl: string;
        diffRole?: "original" | "modified";
        diffLabel?: string;
    }

    interface OriginalDiffEnableMessage {
        type: "diff.setEnabled";
        enabled: true;
        sessionId: number;
        role: "original";
        allPagesChanged: boolean;
    }

    interface ModifiedDiffEnableMessage {
        type: "diff.setEnabled";
        enabled: true;
        sessionId: number;
        role: "modified";
        originalData: ArrayBuffer;
        originalFingerprint: string;
        originalIsEmptyRevision: boolean;
        modifiedIsEmptyRevision: boolean;
    }

    type DiffEnableMessage = OriginalDiffEnableMessage | ModifiedDiffEnableMessage;

    interface DiffDisableMessage {
        type: "diff.setEnabled";
        enabled: false;
        sessionId: number;
    }

    interface DocumentLoadMessage {
        type: "document.load";
        fingerprint: string;
        isEmptyRevision: boolean;
    }

    interface DiffApplyPageMessage {
        type: "diff.applyPage";
        sessionId: number;
        pageNumber: number;
        changes: DiffSideChange[];
    }

    interface DiffRemovedPageRangeMessage {
        type: "diff.setRemovedPageRange";
        sessionId: number;
        fromPage: number;
        toPage: number;
    }

    interface DiffNavigateMessage {
        type: "diff.navigate";
        sessionId: number;
        direction: "next" | "previous";
    }

    interface DiffScanForChangeMessage {
        type: "diff.scanForChange";
        sessionId: number;
        requestId: number;
        role: "original" | "modified";
        direction: "next" | "previous";
        startPage: number;
    }

    interface DiffRevealChangeMessage {
        type: "diff.revealChange";
        sessionId: number;
        requestId: number;
        pageNumber: number;
        index: number;
        changes: DiffSideChange[];
    }

    interface DiffApplyScrollMessage {
        type: "diff.applyScroll";
        pageNumber: number;
        pageRatio: number;
        documentRatio: number;
    }

    interface DiffScrollAnchor {
        pageNumber: number;
        pageRatio: number;
        documentRatio: number;
    }

    interface DiffSideChange {
        id: string;
        kind: DiffChangeKind;
        regions: DiffRegion[];
        strategy: DiffStrategy;
    }

    const maxRenderDimension = 1200;
    const maxRenderScale = 1.25;
    const maximumCachedPageResults = 64;
    const maximumConcurrentPageComparisons = 2;
    const eagerComparisonPageLimit = 16;
    const maximumQueuedPages = eagerComparisonPageLimit;
    const comparisonPrefetchRadius = 3;
    const pdfjsAdapter = window.academicPdfJsAdapter;
    const pageScheduler = new PageComparisonScheduler(
        maximumConcurrentPageComparisons,
        maximumQueuedPages
    );

    let config: ViewerConfig;
    let enabled = false;
    let currentSessionId = 0;
    let modifiedDocumentReady = false;
    let modifiedFingerprint = "";
    let originalFingerprint = "";
    let originalIsEmptyRevision = false;
    let modifiedIsEmptyRevision = false;
    let originalLoadingTask: PdfJsLoadingTask | null = null;
    let originalDocument: PdfJsDocument | null = null;
    let comparisonGeneration = 0;
    let navigationGeneration = 0;
    let scanGeneration = 0;
    const pageResults = new Map<number, DiffSideChange[]>();
    const counterpartPageResults = new Map<number, DiffSideChange[]>();
    const pendingPages = new Map<number, Promise<PageDiffResult | undefined>>();
    const activePageTasks = new Set<Promise<PageDiffResult | undefined>>();
    let removedPageRange: { fromPage: number; toPage: number } | null = null;
    let selectedChange: { pageNumber: number; index: number } | null = null;
    let selectedMarkers: HTMLElement[] = [];
    let statusElement: HTMLElement | null = null;
    let scrollSyncFrame: number | null = null;
    let comparisonScheduleFrame: number | null = null;
    let comparisonReapplyCacheRequest: boolean = false;
    let pageComparisonApplyFrame: number | null = null;
    let applyOnlyMissingRequest: boolean | null = null;
    let comparisonDrainFrame: number | null = null;
    let remoteScrollReleaseFrame: number | null = null;
    let applyingRemoteScroll = false;
    let lastSentScrollAnchor: DiffScrollAnchor | null = null;
    let textMetricsContext: CanvasRenderingContext2D | null | undefined;
    const pageDiffLayers = new Map<number, HTMLElement>();

    window.addEventListener("load", () => {
        config = loadConfig();
        initializeStatus();
        window.addEventListener("message", event => {
            if (isDocumentLoadMessage(event.data)) {
                handleDocumentLoad(event.data);
            } else if (isDiffEnableMessage(event.data)) {
                void enableDiff(event.data);
            } else if (isDiffDisableMessage(event.data)) {
                disableDiff(event.data);
            } else if (isDiffApplyPageMessage(event.data)) {
                applyForwardedPage(event.data);
            } else if (isDiffRemovedPageRangeMessage(event.data)) {
                applyRemovedPageRange(event.data);
            } else if (isDiffNavigateMessage(event.data)) {
                navigateChange(event.data);
            } else if (isDiffScanForChangeMessage(event.data)) {
                scanForForwardedChange(event.data);
            } else if (isDiffRevealChangeMessage(event.data)) {
                applyForwardedNavigation(event.data);
            } else if (isDiffApplyScrollMessage(event.data)) {
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
                    requestScheduledComparisonPages();
                } else {
                    requestApplyComparisonPages(false);
                }
            });
            eventBus.on("pagerendered", (event: { pageNumber: number }) => {
                if (config.diffRole === "modified") {
                    schedulePage(event.pageNumber);
                } else {
                    applyPageResult(event.pageNumber);
                }
            });
            eventBus.on("pagechanging", (event: { pageNumber: number }) => {
                navigationGeneration += 1;
                scanGeneration += 1;
                clearSelectedChange();
                if (config.diffRole === "modified") {
                    schedulePage(event.pageNumber);
                } else {
                    applyPageResult(event.pageNumber);
                }
                updateStatus();
            });
        });
    }, { once: true });

    function loadConfig(): ViewerConfig {
        const element = document.getElementById("pdf-preview-config");
        const value = element?.getAttribute("data-config");
        if (!value) {
            throw new Error("Could not load PDF diff configuration.");
        }
        return JSON.parse(value) as ViewerConfig;
    }

    function isDocumentLoadMessage(value: unknown): value is DocumentLoadMessage {
        return isMessage(value, "document.load");
    }

    function isDiffEnableMessage(value: unknown): value is DiffEnableMessage {
        return isMessage(value, "diff.setEnabled")
            && (value as { enabled?: unknown }).enabled === true
            && isPositiveInteger((value as { sessionId?: unknown }).sessionId)
            && ((value as { role?: unknown }).role === "original"
                || (value as { role?: unknown }).role === "modified");
    }

    function isDiffDisableMessage(value: unknown): value is DiffDisableMessage {
        return isMessage(value, "diff.setEnabled")
            && (value as { enabled?: unknown }).enabled === false
            && isPositiveInteger((value as { sessionId?: unknown }).sessionId);
    }

    function isDiffApplyPageMessage(value: unknown): value is DiffApplyPageMessage {
        return isMessage(value, "diff.applyPage")
            && isPositiveInteger((value as { sessionId?: unknown }).sessionId)
            && typeof (value as { pageNumber?: unknown }).pageNumber === "number"
            && Array.isArray((value as { changes?: unknown }).changes);
    }

    function isDiffRemovedPageRangeMessage(value: unknown): value is DiffRemovedPageRangeMessage {
        return isMessage(value, "diff.setRemovedPageRange")
            && isPositiveInteger((value as { sessionId?: unknown }).sessionId)
            && typeof (value as { fromPage?: unknown }).fromPage === "number"
            && typeof (value as { toPage?: unknown }).toPage === "number";
    }

    function isDiffNavigateMessage(value: unknown): value is DiffNavigateMessage {
        return isMessage(value, "diff.navigate")
            && isPositiveInteger((value as { sessionId?: unknown }).sessionId)
            && ((value as { direction?: unknown }).direction === "next"
                || (value as { direction?: unknown }).direction === "previous");
    }

    function isDiffScanForChangeMessage(value: unknown): value is DiffScanForChangeMessage {
        return isMessage(value, "diff.scanForChange")
            && isPositiveInteger((value as { sessionId?: unknown }).sessionId)
            && isPositiveInteger((value as { requestId?: unknown }).requestId)
            && ((value as { role?: unknown }).role === "original"
                || (value as { role?: unknown }).role === "modified")
            && ((value as { direction?: unknown }).direction === "next"
                || (value as { direction?: unknown }).direction === "previous")
            && isPositiveInteger((value as { startPage?: unknown }).startPage);
    }

    function isDiffRevealChangeMessage(value: unknown): value is DiffRevealChangeMessage {
        if (!isMessage(value, "diff.revealChange")) {
            return false;
        }
        const message = value as {
            sessionId?: unknown;
            requestId?: unknown;
            pageNumber?: unknown;
            index?: unknown;
            changes?: unknown;
        };
        return isPositiveInteger(message.sessionId)
            && isPositiveInteger(message.requestId)
            && isPositiveInteger(message.pageNumber)
            && typeof message.index === "number"
            && Number.isSafeInteger(message.index)
            && message.index >= 0
            && Array.isArray(message.changes)
            && message.index < message.changes.length;
    }

    function isDiffApplyScrollMessage(value: unknown): value is DiffApplyScrollMessage {
        if (!isMessage(value, "diff.applyScroll")) {
            return false;
        }
        const message = value as {
            pageNumber?: unknown;
            pageRatio?: unknown;
            documentRatio?: unknown;
        };
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

    function isMessage(value: unknown, type: string): value is { type: string } {
        return typeof value === "object"
            && value !== null
            && "type" in value
            && (value as { type: unknown }).type === type;
    }

    function isPositiveInteger(value: unknown): value is number {
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
    }

    function handleDocumentLoad(message: DocumentLoadMessage): void {
        pageScheduler.invalidate();
        navigationGeneration += 1;
        scanGeneration += 1;
        modifiedFingerprint = message.fingerprint;
        modifiedDocumentReady = false;
        lastSentScrollAnchor = null;
        if (config.diffRole === "modified" || !enabled) {
            resetPageResults();
        } else {
            clearOverlays();
        }
        if (message.isEmptyRevision) {
            clearOverlays();
        }
        updateStatus();
    }

    async function enableDiff(message: DiffEnableMessage): Promise<void> {
        if (message.sessionId < currentSessionId) {
            return;
        }
        currentSessionId = message.sessionId;
        const currentComparisonGeneration = ++comparisonGeneration;
        pageScheduler.invalidate();
        navigationGeneration += 1;
        scanGeneration += 1;
        enabled = true;
        resetPageResults();
        if (message.role === "original") {
            if (message.allPagesChanged) {
                removedPageRange = { fromPage: 1, toPage: Number.MAX_SAFE_INTEGER };
                requestApplyComparisonPages(false);
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
            requestScheduledComparisonPages();
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
            requestScheduledComparisonPages();
        } catch (error) {
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

    function disableDiff(message: DiffDisableMessage): void {
        if (message.sessionId < currentSessionId) {
            return;
        }
        currentSessionId = message.sessionId;
        comparisonGeneration += 1;
        pageScheduler.invalidate();
        navigationGeneration += 1;
        scanGeneration += 1;
        enabled = false;
        modifiedIsEmptyRevision = false;
        resetPageResults();
        void disposeOriginalDocument();
        updateStatus();
    }

    async function disposeOriginalDocument(): Promise<void> {
        const loadingTask = originalLoadingTask;
        originalLoadingTask = null;
        originalDocument = null;
        if (loadingTask) {
            const startedAt = performance.now();
            try {
                await loadingTask.destroy();
            } catch (error) {
                reportDebug("diffFailed", {
                    fingerprint: modifiedFingerprint,
                    originalFingerprint,
                    durationMs: elapsedSince(startedAt),
                    error: getErrorMessage(error)
                });
            }
        }
    }

    function resetPageResults(): void {
        pageResults.clear();
        counterpartPageResults.clear();
        pendingPages.clear();
        pageScheduler.clearQueued();
        removedPageRange = null;
        clearSelectedChange();
        clearOverlays();
        if (comparisonScheduleFrame !== null) {
            window.cancelAnimationFrame(comparisonScheduleFrame);
            comparisonScheduleFrame = null;
        }
        comparisonReapplyCacheRequest = false;
        if (pageComparisonApplyFrame !== null) {
            window.cancelAnimationFrame(pageComparisonApplyFrame);
            pageComparisonApplyFrame = null;
        }
        applyOnlyMissingRequest = null;
        if (comparisonDrainFrame !== null) {
            window.cancelAnimationFrame(comparisonDrainFrame);
            comparisonDrainFrame = null;
        }
        updateStatus();
    }

    function requestScheduledComparisonPages(reapplyCached = true): void {
        comparisonReapplyCacheRequest = comparisonReapplyCacheRequest || reapplyCached;
        if (comparisonScheduleFrame !== null) {
            return;
        }
        comparisonScheduleFrame = window.requestAnimationFrame(() => {
            comparisonScheduleFrame = null;
            const requestReapplyCached = comparisonReapplyCacheRequest;
            comparisonReapplyCacheRequest = false;
            scheduleComparisonPages(requestReapplyCached);
        });
    }

    function requestApplyComparisonPages(onlyMissing: boolean): void {
        applyOnlyMissingRequest = applyOnlyMissingRequest === null
            ? onlyMissing
            : applyOnlyMissingRequest && onlyMissing;
        if (pageComparisonApplyFrame !== null) {
            return;
        }
        pageComparisonApplyFrame = window.requestAnimationFrame(() => {
            pageComparisonApplyFrame = null;
            const requestOnlyMissing = applyOnlyMissingRequest ?? false;
            applyOnlyMissingRequest = null;
            applyComparisonPages(requestOnlyMissing);
        });
    }

    function scheduleComparisonPages(reapplyCached = true): void {
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

    function comparisonPageRange(
        viewer: PdfJsViewer,
        container: HTMLElement | null
    ): { firstIndex: number; lastIndex: number } | null {
        if (viewer.pagesCount < 1) {
            return null;
        }
        const currentIndex = Math.min(
            viewer.pagesCount - 1,
            Math.max(0, viewer.currentPageNumber - 1)
        );
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

    function applyComparisonPages(onlyMissing = false): void {
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
                || (onlyMissing && (pageDiffLayers.get(pageView.id)?.isConnected ?? false))) {
                continue;
            }
            applyPageResult(pageView.id);
        }
    }

    function schedulePage(pageNumber: number, reapplyCached = true): void {
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
                    originalChanges: counterpart
                });
            }
            applyPageResult(pageNumber);
            return;
        }
        if (pendingPages.has(pageNumber)) {
            return;
        }

        pageScheduler.enqueue(pageNumber);
        updateStatus();
        requestDrainPageQueue();
    }

    function requestDrainPageQueue(): void {
        if (comparisonDrainFrame !== null) {
            return;
        }
        comparisonDrainFrame = window.requestAnimationFrame(() => {
            comparisonDrainFrame = null;
            drainPageQueue();
        });
    }

    function drainPageQueue(): void {
        while (!pageScheduler.atCapacity && pageScheduler.queuedCount > 0) {
            const scheduled = pageScheduler.startNext();
            if (!scheduled) {
                return;
            }
            if (!enabled
                || !modifiedDocumentReady
                || !pageScheduler.isCurrent(scheduled.generation)
                || (!originalDocument && !originalIsEmptyRevision)) {
                pageScheduler.complete();
                continue;
            }

            startPageComparison(scheduled);
        }
    }

    function startPageComparison(scheduled: ScheduledPageComparison): Promise<PageDiffResult | undefined> {
        const { pageNumber, generation } = scheduled;
        const task = computeAndApplyPage(pageNumber, generation);
        pendingPages.set(pageNumber, task);
        activePageTasks.add(task);
        void task.finally(() => {
            pageScheduler.complete();
            activePageTasks.delete(task);
            if (pendingPages.get(pageNumber) === task) {
                pendingPages.delete(pageNumber);
            }
            requestDrainPageQueue();
        });
        return task;
    }

    async function computeAndApplyPage(
        pageNumber: number,
        currentGeneration: number
    ): Promise<PageDiffResult | undefined> {
        const startedAt = performance.now();
        try {
            const result = await computePageDiff(pageNumber);
            if (!enabled || !pageScheduler.isCurrent(currentGeneration)) {
                return undefined;
            }
            rememberComputedPageResult(pageNumber, result);
            applyPageResult(pageNumber);
            postExtensionMessage({
                type: "diff.pageResult",
                sessionId: currentSessionId,
                pageNumber,
                originalChanges: counterpartPageResults.get(pageNumber) ?? []
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
        } catch (error) {
            if (!pageScheduler.isCurrent(currentGeneration)) {
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

    async function computePageDiff(pageNumber: number): Promise<PageDiffResult> {
        const modifiedDocument = window.PDFViewerApplication.pdfDocument;
        if (!modifiedDocument) {
            throw new Error("The modified PDF is not loaded.");
        }
        if (pageNumber > modifiedDocument.numPages) {
            return pageChangeResult("delete");
        }
        if (originalIsEmptyRevision || !originalDocument || pageNumber > originalDocument.numPages) {
            return pageChangeResult("insert");
        }

        const [originalPage, modifiedPage] = await Promise.all([
            originalDocument.getPage(pageNumber),
            modifiedDocument.getPage(pageNumber)
        ]);
        const originalViewport = originalPage.getViewport({ scale: 1 });
        const modifiedViewport = modifiedPage.getViewport({ scale: 1 });
        if (Math.abs(originalViewport.width - modifiedViewport.width) > 0.5
            || Math.abs(originalViewport.height - modifiedViewport.height) > 0.5) {
            return pageChangeResult("replace");
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

    function pageChangeResult(kind: DiffChangeKind): PageDiffResult {
        const region = fullPageRegion();
        const originalRegions = kind === "insert" ? [] : [region];
        const modifiedRegions = kind === "delete" ? [] : [region];
        return {
            changes: [{
                id: "page-1",
                kind,
                originalRegions,
                modifiedRegions,
                strategy: "page"
            }],
            originalRegions,
            modifiedRegions,
            changedPixels: -1,
            strategy: "page"
        };
    }

    function rememberPageResult(pageNumber: number, changes: DiffSideChange[]): void {
        rememberBoundedMapEntry(pageResults, pageNumber, changes);
    }

    function rememberComputedPageResult(pageNumber: number, result: PageDiffResult): void {
        rememberPairedBoundedMapEntries(
            pageResults,
            counterpartPageResults,
            pageNumber,
            sideChanges(pageNumber, result, "modified"),
            sideChanges(pageNumber, result, "original")
        );
    }

    function rememberBoundedMapEntry<T>(cache: Map<number, T>, pageNumber: number, changes: T): void {
        cache.delete(pageNumber);
        cache.set(pageNumber, changes);
        while (cache.size > maximumCachedPageResults) {
            const oldestPage = cache.keys().next().value;
            if (oldestPage === undefined) {
                return;
            }
            cache.delete(oldestPage);
        }
    }

    function rememberPairedBoundedMapEntries<T, U>(
        primaryCache: Map<number, T>,
        secondaryCache: Map<number, U>,
        pageNumber: number,
        primaryChanges: T,
        secondaryChanges: U
    ): void {
        primaryCache.delete(pageNumber);
        secondaryCache.delete(pageNumber);
        primaryCache.set(pageNumber, primaryChanges);
        secondaryCache.set(pageNumber, secondaryChanges);
        while (primaryCache.size > maximumCachedPageResults) {
            const oldestPage = primaryCache.keys().next().value;
            if (oldestPage === undefined) {
                return;
            }
            primaryCache.delete(oldestPage);
            secondaryCache.delete(oldestPage);
        }
    }

    function sideChanges(
        pageNumber: number,
        result: PageDiffResult,
        side: "original" | "modified"
    ): DiffSideChange[] {
        return result.changes
            .map(change => ({
                id: `${pageNumber}:${change.id}`,
                kind: change.kind,
                regions: side === "original" ? change.originalRegions : change.modifiedRegions,
                strategy: change.strategy
            }))
            .filter(change => change.regions.length > 0);
    }

    async function renderPage(page: PdfJsPage, scale: number): Promise<RasterPage> {
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

    async function comparePageText(
        originalPage: PdfJsPage,
        modifiedPage: PdfJsPage,
        scale: number,
        pageNumber: number
    ): Promise<PageDiffResult | null> {
        const startedAt = performance.now();
        try {
            const [originalContent, modifiedContent] = await Promise.all([
                originalPage.getTextContent(),
                modifiedPage.getTextContent()
            ]);
            const originalViewport = originalPage.getViewport({ scale });
            const modifiedViewport = modifiedPage.getViewport({ scale });
            const originalTokens = collectTextTokens(originalContent, originalViewport);
            const modifiedTokens = collectTextTokens(modifiedContent, modifiedViewport);
            return compareTextTokens(
                originalTokens,
                modifiedTokens,
                originalViewport.width,
                originalViewport.height,
                modifiedViewport.width,
                modifiedViewport.height
            );
        } catch (error) {
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

    function collectTextTokens(content: PdfJsTextContent, viewport: PdfJsViewport): TextToken[] {
        const tokens: TextToken[] = [];
        for (const item of content.items) {
            if (typeof item.str !== "string" || !item.str.trim() || !Array.isArray(item.transform)) {
                continue;
            }

            const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
            const itemWidth = Math.abs(Number(item.width) * viewport.scale);
            const fontHeight = Math.max(1, Math.hypot(transform[2], transform[3]));
            const style = item.fontName ? content.styles?.[item.fontName] : undefined;
            const ascentRatio = style?.ascent
                ?? (style?.descent !== undefined ? 1 + style.descent : 0.8);
            const fallbackTop = -fontHeight * ascentRatio;
            const fallbackBottom = fallbackTop + fontHeight;
            const context = getTextMetricsContext();
            const fontFamily = style?.fontFamily?.trim();
            if (context && fontFamily) {
                context.font = `${fontHeight}px ${fontFamily}`;
            }
            const measuredWidth = context && fontFamily
                ? context.measureText(item.str).width
                : 0;
            const matches = item.str.matchAll(/\S+/gu);
            for (const match of matches) {
                const start = match.index;
                const end = start + match[0].length;
                let leftRatio = start / item.str.length;
                let rightRatio = end / item.str.length;
                let topOffset = fallbackTop;
                let bottomOffset = fallbackBottom;
                if (context && measuredWidth > 0) {
                    const prefixWidth = context.measureText(item.str.slice(0, start)).width;
                    const tokenMetrics = context.measureText(match[0]);
                    const inkLeft = prefixWidth - tokenMetrics.actualBoundingBoxLeft;
                    const inkRight = prefixWidth + tokenMetrics.actualBoundingBoxRight;
                    if (Number.isFinite(inkLeft) && Number.isFinite(inkRight) && inkRight > inkLeft) {
                        leftRatio = inkLeft / measuredWidth;
                        rightRatio = inkRight / measuredWidth;
                    } else if (tokenMetrics.width > 0) {
                        leftRatio = prefixWidth / measuredWidth;
                        rightRatio = (prefixWidth + tokenMetrics.width) / measuredWidth;
                    }
                    const inkTop = -tokenMetrics.actualBoundingBoxAscent;
                    const inkBottom = tokenMetrics.actualBoundingBoxDescent;
                    if (Number.isFinite(inkTop) && Number.isFinite(inkBottom) && inkBottom > inkTop) {
                        topOffset = inkTop;
                        bottomOffset = inkBottom;
                    }
                }
                const left = transform[4] + itemWidth * leftRatio;
                const right = transform[4] + itemWidth * rightRatio;
                const top = transform[5] + topOffset;
                const bottom = transform[5] + bottomOffset;
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

    function getTextMetricsContext(): CanvasRenderingContext2D | null {
        if (textMetricsContext === undefined) {
            textMetricsContext = document.createElement("canvas").getContext("2d");
        }
        return textMetricsContext;
    }

    function applyForwardedPage(message: DiffApplyPageMessage): void {
        if (config.diffRole !== "original" || message.sessionId !== currentSessionId) {
            return;
        }
        rememberPageResult(message.pageNumber, message.changes);
        applyPageResult(message.pageNumber);
    }

    function applyRemovedPageRange(message: DiffRemovedPageRangeMessage): void {
        if (config.diffRole !== "original" || message.sessionId !== currentSessionId) {
            return;
        }
        removedPageRange = {
            fromPage: message.fromPage,
            toPage: message.toPage
        };
        requestApplyComparisonPages(false);
    }

    function applyPageResult(pageNumber: number): void {
        const changes = changesForPage(pageNumber);
        if (changes !== undefined) {
            applyOverlay(pageNumber, changes);
        }
        if (selectedChange?.pageNumber === pageNumber) {
            const selectedIndex = selectedChange.index;
            window.requestAnimationFrame(() => {
                if (selectedChange?.pageNumber !== pageNumber
                    || selectedChange.index !== selectedIndex) {
                    return;
                }
                const selectedIndexKey = String(selectedIndex);
            if (selectedMarkers.length > 0
                && selectedMarkers[0].dataset.pageNumber === String(pageNumber)
                && selectedMarkers[0].dataset.changeIndex === selectedIndexKey) {
                selectedMarkers[0].scrollIntoView({ block: "center", inline: "center" });
                return;
            }
            const pageView = window.PDFViewerApplication.pdfViewer?.getPageView(pageNumber - 1);
            const marker = pageView?.div.querySelector<HTMLElement>(
                `.academicPdfDiffRegion[data-change-index="${selectedIndexKey}"]`
                );
                marker?.scrollIntoView({ block: "center", inline: "center" });
            });
        }
        updateStatus();
    }

    function changesForPage(pageNumber: number): DiffSideChange[] | undefined {
        if (removedPageRange
            && pageNumber >= removedPageRange.fromPage
            && pageNumber <= removedPageRange.toPage) {
            return [{
                id: `${pageNumber}:page-1`,
                kind: "delete",
                regions: [fullPageRegion()],
                strategy: "page"
            }];
        }
        return pageResults.get(pageNumber);
    }

    function navigateChange(message: DiffNavigateMessage): void {
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
        const changes = changesForPage(pageNumber);
        const selectedIndex = selectedChange?.pageNumber === pageNumber
            ? selectedChange.index
            : undefined;
        const localIndex = nextDiffRegionIndex(changes?.length ?? 0, selectedIndex, message.direction);
        if (localIndex !== undefined && changes) {
            revealChange(pageNumber, localIndex, changes);
            return;
        }

        const step = message.direction === "next" ? 1 : -1;
        const startPage = changes === undefined ? pageNumber : pageNumber + step;
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

    function navigateKnownOriginalPages(
        startPage: number,
        direction: "next" | "previous"
    ): number | undefined {
        const viewer = window.PDFViewerApplication.pdfViewer;
        const step = direction === "next" ? 1 : -1;
        for (let pageNumber = startPage;
            pageNumber >= 1 && pageNumber <= viewer.pagesCount;
            pageNumber += step) {
            const changes = changesForPage(pageNumber);
            if (changes === undefined) {
                return pageNumber;
            }
            if (changes.length > 0) {
                revealChange(
                    pageNumber,
                    direction === "next" ? 0 : changes.length - 1,
                    changes
                );
                return undefined;
            }
        }
        return undefined;
    }

    function scanForForwardedChange(message: DiffScanForChangeMessage): void {
        if (config.diffRole !== "modified" || message.sessionId !== currentSessionId) {
            return;
        }
        void scanForChange(message, true);
    }

    async function scanForChange(
        request: Omit<DiffScanForChangeMessage, "type">,
        forwardResult: boolean
    ): Promise<void> {
        const currentScanGeneration = ++scanGeneration;
        const modifiedDocument = window.PDFViewerApplication.pdfDocument;
        const lastPage = request.role === "original"
            ? originalDocument?.numPages ?? 0
            : modifiedDocument?.numPages ?? 0;
        const target = await findNextDiffPage(
            request.startPage,
            lastPage,
            request.direction,
            async pageNumber => {
                const result = await ensurePageComparison(
                    pageNumber,
                    request.sessionId,
                    currentScanGeneration
                );
                if (!result
                    || !isCurrentScan(request.sessionId, currentScanGeneration)
                    || (!forwardResult && navigationGeneration !== request.requestId)) {
                    return undefined;
                }
                return request.role === "original"
                    ? result.originalChanges
                    : result.modifiedChanges;
            }
        );
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
                changes: target.regions
            });
        } else {
            revealChange(target.pageNumber, target.index, target.regions);
        }
    }

    async function ensurePageComparison(
        pageNumber: number,
        sessionId: number,
        currentScanGeneration: number
    ): Promise<{
        originalChanges: DiffSideChange[];
        modifiedChanges: DiffSideChange[];
    } | undefined> {
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

        pageScheduler.removeQueued(pageNumber);
        while (pageScheduler.atCapacity) {
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
        const scheduled = pageScheduler.startImmediately(pageNumber);
        if (!scheduled) {
            return undefined;
        }
        const result = await startPageComparison(scheduled);
        return result ? cachedComparison(pageNumber) : undefined;
    }

    function cachedComparison(
        pageNumber: number
    ): { originalChanges: DiffSideChange[]; modifiedChanges: DiffSideChange[] } | undefined {
        const modifiedChanges = pageResults.get(pageNumber);
        const originalChanges = counterpartPageResults.get(pageNumber);
        return modifiedChanges !== undefined && originalChanges !== undefined
            ? { originalChanges, modifiedChanges }
            : undefined;
    }

    function isCurrentScan(sessionId: number, currentScanGeneration: number): boolean {
        return enabled
            && currentSessionId === sessionId
            && scanGeneration === currentScanGeneration;
    }

    function applyForwardedNavigation(message: DiffRevealChangeMessage): void {
        if (config.diffRole !== "original"
            || message.sessionId !== currentSessionId
            || message.requestId !== navigationGeneration) {
            return;
        }
        rememberPageResult(message.pageNumber, message.changes);
        revealChange(message.pageNumber, message.index, message.changes);
    }

    function revealChange(pageNumber: number, index: number, changes: DiffSideChange[]): void {
        const viewer = window.PDFViewerApplication.pdfViewer;
        if (index < 0 || index >= changes.length || pageNumber > viewer.pagesCount) {
            return;
        }
        if (viewer.currentPageNumber !== pageNumber) {
            viewer.currentPageNumber = pageNumber;
        }
        selectedChange = { pageNumber, index };
        applyPageResult(pageNumber);
    }

    function clearSelectedChange(): void {
        selectedChange = null;
        clearSelectedMarker();
    }

    function initializeStatus(): void {
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

    function updateStatus(): void {
        if (!statusElement || !config.diffRole) {
            return;
        }
        statusElement.classList.toggle("academicPdfDiffStatus--enabled", enabled);
        const label = config.diffLabel
            ?? (config.diffRole === "original" ? "Original" : "Modified");
        statusElement.textContent = `${label} · Highlights ${enabled ? "on" : "off"}`;
        statusElement.title = statusElement.textContent;
    }

    function postExtensionMessage(message: Record<string, unknown>): void {
        window.dispatchEvent(new CustomEvent("academic-pdf-message", { detail: message }));
    }

    function initializeScrollSync(): void {
        if (!config.diffRole) {
            return;
        }
        window.PDFViewerApplication.pdfViewer.container.addEventListener(
            "scroll",
            scheduleScrollSync,
            { passive: true }
        );
    }

    function scheduleScrollSync(): void {
        if (scrollSyncFrame !== null) {
            return;
        }
        scrollSyncFrame = window.requestAnimationFrame(() => {
            scrollSyncFrame = null;
            if (config.diffRole === "modified") {
                requestScheduledComparisonPages(false);
            } else if (config.diffRole === "original") {
                requestApplyComparisonPages(true);
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

    function readScrollAnchor(): DiffScrollAnchor | null {
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
            documentRatio: clampUnit(
                scrollTop / Math.max(1, viewer.container.scrollHeight - viewer.container.clientHeight)
            )
        };
    }

    function isSameScrollAnchor(
        first: DiffScrollAnchor,
        second: DiffScrollAnchor | null
    ): boolean {
        return second !== null
            && first.pageNumber === second.pageNumber
            && Math.abs(first.pageRatio - second.pageRatio) < 0.0005
            && Math.abs(first.documentRatio - second.documentRatio) < 0.0005;
    }

    function applySynchronizedScroll(message: DiffApplyScrollMessage): void {
        if (!config.diffRole) {
            return;
        }
        const viewer = window.PDFViewerApplication.pdfViewer;
        if (viewer.pagesCount < 1) {
            return;
        }

        const container = viewer.container;
        const maximumScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
        let targetScrollTop: number;
        if (message.pageNumber > viewer.pagesCount) {
            targetScrollTop = message.documentRatio * maximumScrollTop;
        } else {
            const pageView = viewer.getPageView(message.pageNumber - 1);
            if (!pageView || pageView.div.offsetHeight < 1) {
                return;
            }
            targetScrollTop = Math.min(
                maximumScrollTop,
                Math.max(
                    0,
                    pageView.div.offsetTop + message.pageRatio * pageView.div.offsetHeight
                )
            );
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

    function clampUnit(value: number): number {
        return Math.min(1, Math.max(0, value));
    }

    function applyOverlay(pageNumber: number, changes: DiffSideChange[]): void {
        const pageView = window.PDFViewerApplication.pdfViewer?.getPageView(pageNumber - 1);
        const pageElement = pageView?.div as HTMLElement | undefined;
        if (!pageElement) {
            return;
        }
        if (selectedChange?.pageNumber === pageNumber) {
            clearSelectedMarker();
        }

        const existingLayer = pageDiffLayers.get(pageNumber);
        if (existingLayer) {
            existingLayer.remove();
        }
        pageDiffLayers.delete(pageNumber);

        if (!enabled || changes.length === 0) {
            if (selectedChange?.pageNumber === pageNumber) {
                clearSelectedMarker();
            }
            return;
        }

        const layer = document.createElement("div");
        layer.className = "academicPdfDiffLayer";
        layer.setAttribute("aria-hidden", "true");
        for (const [index, change] of changes.entries()) {
            for (const region of change.regions) {
                const marker = document.createElement("div");
                marker.className = `academicPdfDiffRegion academicPdfDiffRegion--${config.diffRole ?? "modified"}`;
                marker.dataset.changeId = change.id;
                marker.dataset.pageNumber = String(pageNumber);
                marker.dataset.changeIndex = String(index);
                if (selectedChange?.pageNumber === pageNumber && selectedChange.index === index) {
                    marker.classList.add("academicPdfDiffRegion--selected");
                    selectedMarkers.push(marker);
                }
                marker.style.left = `${region.left * 100}%`;
                marker.style.top = `${region.top * 100}%`;
                marker.style.width = `${region.width * 100}%`;
                marker.style.height = `${region.height * 100}%`;
                layer.appendChild(marker);
            }
        }
        pageElement.appendChild(layer);
        pageDiffLayers.set(pageNumber, layer);
    }

    function clearOverlays(): void {
        for (const layer of pageDiffLayers.values()) {
            layer.remove();
        }
        pageDiffLayers.clear();
        clearSelectedMarker();
    }

    function clearSelectedMarker(): void {
        if (selectedMarkers.length === 0) {
            return;
        }
        for (const marker of selectedMarkers) {
            marker.classList.remove("academicPdfDiffRegion--selected");
        }
        selectedMarkers = [];
    }

    function reportDebug(event: string, fields: Record<string, unknown>): void {
        if (!config.debug) {
            return;
        }
        window.dispatchEvent(new CustomEvent("academic-pdf-debug", {
            detail: { type: "pdf.debug", event, ...fields }
        }));
    }

    function elapsedSince(startedAt: number): number {
        return Math.round(performance.now() - startedAt);
    }

    function getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}());
