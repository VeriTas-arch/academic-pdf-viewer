"use strict";
(function () {
    function loadConfig() {
        const element = document.getElementById("pdf-preview-config");
        const value = element?.getAttribute("data-config");
        if (!value) {
            throw new Error("Could not load configuration.");
        }
        return JSON.parse(value);
    }
    function configureViewerOptions(targetWindow, config) {
        const options = targetWindow.PDFViewerApplicationOptions;
        if (!options) {
            return false;
        }
        options.set("disablePreferences", true);
        options.set("defaultUrl", "");
        options.set("disableHistory", true);
        options.set("enableScripting", false);
        options.set("cMapUrl", config.cMapUrl);
        options.set("iccUrl", config.iccUrl);
        options.set("imageResourcesPath", config.imageResourcesPath);
        options.set("standardFontDataUrl", config.standardFontDataUrl);
        options.set("wasmUrl", config.wasmUrl);
        options.set("workerSrc", config.workerSrc);
        options.set("cursorToolOnLoad", 0);
        options.set("defaultZoomValue", "auto");
        options.set("scrollModeOnLoad", 0);
        options.set("spreadModeOnLoad", 0);
        options.set("sidebarViewOnLoad", 0);
        return true;
    }
    function captureViewerState(application) {
        const viewer = application.pdfViewer;
        const container = viewer?.container;
        if (!viewer || !container || !application.pdfDocument) {
            return null;
        }
        return {
            pageNumber: viewer.currentPageNumber,
            scale: viewer.currentScale,
            scaleValue: viewer.currentScaleValue,
            scrollLeft: container.scrollLeft,
            scrollTop: container.scrollTop,
            sidebar: window.academicPdfJsAdapter.getSidebarState()
        };
    }
    function restoreViewerState(application, state, isCurrentLoad) {
        const viewer = application.pdfViewer;
        const container = viewer?.container;
        if (!viewer || !container || !state || !isCurrentLoad()) {
            return Promise.resolve();
        }
        if (state.sidebar) {
            window.academicPdfJsAdapter.restoreSidebarState(state.sidebar);
        }
        return new Promise(resolve => requestAnimationFrame(() => {
            if (isCurrentLoad()) {
                if (typeof state.scaleValue === "string" && state.scaleValue.length > 0) {
                    viewer.currentScaleValue = state.scaleValue;
                }
                else if (Number.isFinite(state.scale) && state.scale > 0) {
                    viewer.currentScaleValue = String(state.scale);
                }
                if (Number.isInteger(state.pageNumber)) {
                    viewer.currentPageNumber = Math.min(state.pageNumber, viewer.pagesCount);
                }
            }
            requestAnimationFrame(() => {
                if (isCurrentLoad()) {
                    container.scrollLeft = state.scrollLeft;
                    container.scrollTop = state.scrollTop;
                }
                resolve();
            });
        }));
    }
    function isDocumentLoadMessage(value) {
        if (typeof value !== "object" || value === null) {
            return false;
        }
        const message = value;
        return message.type === "document.load"
            && typeof message.loadId === "number"
            && Number.isSafeInteger(message.loadId)
            && message.loadId >= 1
            && message.data instanceof ArrayBuffer
            && typeof message.isEmptyRevision === "boolean"
            && typeof message.fingerprint === "string"
            && typeof message.preserveView === "boolean";
    }
    function isSidebarConfigureMessage(value) {
        if (typeof value !== "object" || value === null) {
            return false;
        }
        const message = value;
        return message.type === "sidebar.configure"
            && isSidebarView(message.defaultSidebar);
    }
    function isSyncTexForwardMessage(value) {
        if (typeof value !== "object" || value === null) {
            return false;
        }
        const message = value;
        return message.type === "synctex.forward"
            && isSyncTexRequestId(message.requestId)
            && isSyncTexLoadId(message.loadId)
            && typeof message.pageNumber === "number"
            && Number.isSafeInteger(message.pageNumber)
            && message.pageNumber >= 1
            && typeof message.x === "number"
            && Number.isFinite(message.x)
            && typeof message.y === "number"
            && Number.isFinite(message.y)
            && isSyncTexTargetBox(message.targetBox);
    }
    function isSyncTexTargetBox(value) {
        if (value === undefined) {
            return true;
        }
        if (typeof value !== "object" || value === null) {
            return false;
        }
        const box = value;
        return typeof box.x === "number"
            && Number.isFinite(box.x)
            && typeof box.y === "number"
            && Number.isFinite(box.y)
            && typeof box.width === "number"
            && Number.isFinite(box.width)
            && box.width > 0
            && typeof box.height === "number"
            && Number.isFinite(box.height)
            && box.height > 0;
    }
    function isSyncTexForwardCancelMessage(value) {
        if (typeof value !== "object" || value === null) {
            return false;
        }
        const message = value;
        return message.type === "synctex.forwardCancel"
            && isSyncTexRequestId(message.requestId)
            && isSyncTexLoadId(message.loadId);
    }
    function isSyncTexRequestId(value) {
        return typeof value === "string" && value.length > 0 && value.length <= 64;
    }
    function isSyncTexLoadId(value) {
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
    }
    let syncTexTargetMarker = null;
    let syncTexTargetTimer = null;
    function clearSyncTexTarget() {
        syncTexTargetMarker?.remove();
        syncTexTargetMarker = null;
        if (syncTexTargetTimer !== null) {
            window.clearTimeout(syncTexTargetTimer);
            syncTexTargetTimer = null;
        }
    }
    function toSyncTexViewportBox(pageView, viewBox, userUnit, targetBox) {
        const right = targetBox.x + targetBox.width;
        const bottom = targetBox.y + targetBox.height;
        if (!Number.isFinite(right) || !Number.isFinite(bottom)) {
            return undefined;
        }
        const viewportPoints = [
            [targetBox.x, targetBox.y],
            [right, targetBox.y],
            [targetBox.x, bottom],
            [right, bottom],
        ].map(([x, y]) => pageView.viewport.convertToViewportPoint(viewBox[0] + x / userUnit, viewBox[3] - y / userUnit));
        if (!viewportPoints.every(point => point.length >= 2 && point.slice(0, 2).every(Number.isFinite))) {
            return undefined;
        }
        const xCoordinates = viewportPoints.map(point => point[0]);
        const yCoordinates = viewportPoints.map(point => point[1]);
        const left = Math.min(...xCoordinates);
        const top = Math.min(...yCoordinates);
        const width = Math.max(...xCoordinates) - left;
        const height = Math.max(...yCoordinates) - top;
        return width > 0 && height > 0 ? { left, top, width, height } : undefined;
    }
    function showSyncTexTarget(pageView, viewportX, viewportY, targetBox) {
        clearSyncTexTarget();
        const marker = document.createElement("div");
        marker.className = "academicPdfSyncTexTarget";
        marker.setAttribute("aria-hidden", "true");
        marker.style.position = "absolute";
        marker.dataset.synctexTarget = targetBox ? "box" : "point";
        if (targetBox) {
            const verticalMargin = 3;
            const top = Math.max(0, targetBox.top - verticalMargin);
            const bottom = Math.min(pageView.viewport.height, targetBox.top + targetBox.height + verticalMargin);
            marker.style.left = `${targetBox.left / pageView.viewport.width * 100}%`;
            marker.style.top = `${top / pageView.viewport.height * 100}%`;
            marker.style.width = `${targetBox.width / pageView.viewport.width * 100}%`;
            marker.style.height = `${(bottom - top) / pageView.viewport.height * 100}%`;
        }
        else {
            marker.style.left = `${viewportX / pageView.viewport.width * 100}%`;
            marker.style.top = `${viewportY / pageView.viewport.height * 100}%`;
            marker.style.width = "32px";
            marker.style.height = "18px";
            marker.style.transform = "translate(-50%, -50%)";
        }
        marker.style.boxSizing = "border-box";
        marker.style.border = "2px solid var(--vscode-editorInfo-foreground, #3794ff)";
        marker.style.borderRadius = "4px";
        marker.style.background = "rgba(55, 148, 255, 0.1)";
        marker.style.boxShadow = "0 0 0 3px rgba(55, 148, 255, 0.1), 0 0 8px rgba(55, 148, 255, 0.35)";
        marker.style.opacity = "0.65";
        marker.style.pointerEvents = "none";
        marker.style.zIndex = "20";
        pageView.div.appendChild(marker);
        marker.animate([
            { opacity: 0.3 },
            { opacity: 0.75 },
            { opacity: 0.65 },
        ], {
            duration: 700,
            easing: "ease-out",
            iterations: 2,
        });
        syncTexTargetMarker = marker;
        syncTexTargetTimer = window.setTimeout(() => {
            if (syncTexTargetMarker === marker) {
                marker.remove();
                syncTexTargetMarker = null;
            }
            syncTexTargetTimer = null;
        }, 4000);
    }
    /** Navigates to a SyncTeX location without changing the current zoom. */
    async function applySyncTexForward(message, application, isCurrentLoad) {
        await application.initializedPromise;
        const viewer = application.pdfViewer;
        if (!viewer || !application.pdfDocument || !isCurrentLoad()) {
            return false;
        }
        const pdfDocument = application.pdfDocument;
        await viewer.pagesPromise;
        if (!isCurrentLoad()
            || application.pdfDocument !== pdfDocument
            || message.pageNumber > pdfDocument.numPages
            || message.pageNumber > viewer.pagesCount) {
            return false;
        }
        const pageView = viewer.getPageView(message.pageNumber - 1);
        if (!pageView) {
            return false;
        }
        let pageViewUpdated = false;
        if (!pageView.pdfPage) {
            const pdfPage = await pdfDocument.getPage(message.pageNumber);
            if (!isCurrentLoad() || application.pdfDocument !== pdfDocument) {
                return false;
            }
            if (!pageView.pdfPage) {
                pageView.setPdfPage(pdfPage);
                pageViewUpdated = true;
            }
        }
        if (pageViewUpdated) {
            await new Promise(resolve => requestAnimationFrame(() => resolve()));
        }
        const viewBox = pageView.viewport.viewBox;
        if (!viewBox
            || viewBox.length < 4
            || !viewBox.slice(0, 4).every(Number.isFinite)) {
            return false;
        }
        const userUnit = Number.isFinite(pageView.viewport.userUnit) && pageView.viewport.userUnit > 0
            ? pageView.viewport.userUnit
            : 1;
        const pdfX = viewBox[0] + message.x / userUnit;
        const pdfY = viewBox[3] - message.y / userUnit;
        const [viewportX, viewportY] = pageView.viewport.convertToViewportPoint(pdfX, pdfY);
        const viewportTargetBox = message.targetBox
            ? toSyncTexViewportBox(pageView, viewBox, userUnit, message.targetBox)
            : undefined;
        if (!Number.isFinite(pdfX)
            || !Number.isFinite(pdfY)
            || !Number.isFinite(viewportX)
            || !Number.isFinite(viewportY)
            || !Number.isFinite(pageView.viewport.width)
            || pageView.viewport.width <= 0
            || !Number.isFinite(pageView.viewport.height)
            || pageView.viewport.height <= 0
            || !isCurrentLoad()
            || application.pdfDocument !== pdfDocument) {
            return false;
        }
        viewer.scrollPageIntoView({
            pageNumber: message.pageNumber,
            destArray: [
                null,
                { name: "XYZ" },
                pdfX,
                pdfY,
                null,
            ],
            allowNegativeOffset: true,
            ignoreDestinationZoom: true,
            center: "both",
        });
        // Prevent a following auto-zoom resize from restoring PDF.js's stale location.
        viewer.update();
        showSyncTexTarget(pageView, viewportX, viewportY, viewportTargetBox);
        return true;
    }
    function isSidebarView(value) {
        return value === "pages"
            || value === "outline"
            || value === "attachments"
            || value === "layers";
    }
    const config = loadConfig();
    const pdfjsAdapter = window.academicPdfJsAdapter;
    const reportDebug = (event, fields = {}) => {
        if (!config.debug) {
            return;
        }
        window.dispatchEvent(new CustomEvent("academic-pdf-debug", {
            detail: { type: "pdf.debug", event, ...fields }
        }));
    };
    const elapsedSince = (startedAt) => Math.round(performance.now() - startedAt);
    const errorMessage = (error) => error instanceof Error ? error.message : String(error);
    let workerBlobUrl = null;
    const prepareWorkerSource = async () => {
        const startedAt = performance.now();
        const localWorkerSrc = config.workerSrc;
        try {
            const response = await fetch(localWorkerSrc);
            if (!response.ok) {
                throw new Error(`Could not read the bundled PDF worker (${response.status}).`);
            }
            const source = await response.arrayBuffer();
            workerBlobUrl = URL.createObjectURL(new Blob([source], {
                type: "text/javascript"
            }));
            config.workerSrc = workerBlobUrl;
            reportDebug("workerSourcePrepared", {
                durationMs: elapsedSince(startedAt),
                sizeBytes: source.byteLength
            });
        }
        catch (error) {
            reportDebug("workerSourceFallback", {
                durationMs: elapsedSince(startedAt),
                error: errorMessage(error)
            });
            await import(localWorkerSrc);
        }
    };
    const workerSourceReady = prepareWorkerSource();
    window.addEventListener("pagehide", () => {
        if (workerBlobUrl) {
            URL.revokeObjectURL(workerBlobUrl);
            workerBlobUrl = null;
        }
    }, { once: true });
    const configureOnViewerLoaded = (event) => {
        const detail = event.detail;
        configureViewerOptions(detail?.source ?? window, config);
    };
    document.addEventListener("webviewerloaded", configureOnViewerLoaded, { once: true });
    try {
        if (parent.document !== document) {
            parent.document.addEventListener("webviewerloaded", configureOnViewerLoaded, { once: true });
        }
    }
    catch {
        // Cross-origin embedding dispatches the event on this document instead.
    }
    window.addEventListener("load", async () => {
        const application = pdfjsAdapter.getApplication();
        if (!application) {
            throw new Error("PDF.js viewer application is unavailable.");
        }
        const initializedAt = performance.now();
        await workerSourceReady;
        if (!configureViewerOptions(window, config)) {
            throw new Error("PDF.js viewer options are unavailable.");
        }
        const loadOptions = {
            isEvalSupported: false,
            useWorkerFetch: false,
            cMapUrl: config.cMapUrl,
            cMapPacked: true,
            iccUrl: config.iccUrl,
            standardFontDataUrl: config.standardFontDataUrl,
            wasmUrl: config.wasmUrl
        };
        let pendingFirstPageRender = null;
        let defaultSidebar = isSidebarView(config.defaultSidebar)
            ? config.defaultSidebar
            : "pages";
        reportDebug("viewerInitializing", {
            workerSource: workerBlobUrl ? "blob" : "mainThreadFallback"
        });
        await application.initializedPromise;
        reportDebug("viewerInitialized", {
            durationMs: elapsedSince(initializedAt),
            workerSource: workerBlobUrl ? "blob" : "mainThreadFallback"
        });
        application.eventBus.on("pagerendered", event => {
            if (!pendingFirstPageRender?.opened) {
                return;
            }
            const pending = pendingFirstPageRender;
            pendingFirstPageRender = null;
            reportDebug("firstPageRendered", {
                fingerprint: pending.fingerprint,
                durationMs: elapsedSince(pending.startedAt),
                pages: application.pdfDocument?.numPages,
                pageNumber: event.pageNumber
            });
        });
        application.eventBus.on("documentinit", () => {
            pdfjsAdapter.setSidebarView(defaultSidebar);
        });
        let latestDocumentLoadId = 0;
        let completedDocumentLoadId = 0;
        let completedDocumentAvailable = false;
        let pendingDocumentLoad = null;
        let documentLoadDrain = null;
        let documentLoadStartFrame = null;
        let pendingSyncTexForward = null;
        let syncTexForwardDrain = null;
        const isSameSyncTexForward = (first, second) => first?.requestId === second.requestId && first.loadId === second.loadId;
        const postSyncTexForwardResult = (message, status) => {
            window.dispatchEvent(new CustomEvent("academic-pdf-message", {
                detail: {
                    type: "synctex.forwardResult",
                    requestId: message.requestId,
                    loadId: message.loadId,
                    status,
                },
            }));
        };
        const rejectPendingSyncTexForward = () => {
            if (!pendingSyncTexForward) {
                return;
            }
            const message = pendingSyncTexForward;
            pendingSyncTexForward = null;
            postSyncTexForwardResult(message, "rejected");
        };
        const drainSyncTexForward = () => {
            if (syncTexForwardDrain
                || !pendingSyncTexForward
                || pendingSyncTexForward.loadId !== completedDocumentLoadId) {
                return;
            }
            const message = pendingSyncTexForward;
            const drain = (async () => {
                let applied = false;
                if (completedDocumentAvailable) {
                    try {
                        applied = await applySyncTexForward(message, application, () => isSameSyncTexForward(pendingSyncTexForward, message)
                            && latestDocumentLoadId === message.loadId
                            && completedDocumentLoadId === message.loadId
                            && completedDocumentAvailable);
                    }
                    catch (error) {
                        console.error("Failed to apply SyncTeX location.", error);
                    }
                }
                if (!isSameSyncTexForward(pendingSyncTexForward, message)) {
                    return;
                }
                pendingSyncTexForward = null;
                postSyncTexForwardResult(message, applied ? "applied" : "rejected");
            })();
            syncTexForwardDrain = drain;
            void drain.finally(() => {
                if (syncTexForwardDrain !== drain) {
                    return;
                }
                syncTexForwardDrain = null;
                drainSyncTexForward();
            });
        };
        const completeDocumentLoad = (message, available) => {
            if (message.loadId !== latestDocumentLoadId) {
                return;
            }
            completedDocumentLoadId = message.loadId;
            completedDocumentAvailable = available;
            drainSyncTexForward();
        };
        const queueSyncTexForward = (message) => {
            if (message.loadId < latestDocumentLoadId) {
                postSyncTexForwardResult(message, "rejected");
                return;
            }
            if (!isSameSyncTexForward(pendingSyncTexForward, message)) {
                rejectPendingSyncTexForward();
            }
            pendingSyncTexForward = message;
            drainSyncTexForward();
        };
        const isLatestDocumentLoad = (message) => (message.loadId === latestDocumentLoadId);
        const processDocumentLoad = async (message) => {
            const startedAt = performance.now();
            const fingerprint = message.fingerprint;
            await application.initializedPromise;
            if (!isLatestDocumentLoad(message)) {
                return;
            }
            if (message.isEmptyRevision) {
                pendingFirstPageRender = null;
                if (application.pdfLoadingTask) {
                    await application.close();
                }
                if (!isLatestDocumentLoad(message)) {
                    return;
                }
                showDocumentState("This file does not exist in this revision.");
                reportDebug("emptyRevision", {
                    fingerprint,
                    durationMs: elapsedSince(startedAt)
                });
                completeDocumentLoad(message, false);
                return;
            }
            const data = new Uint8Array(message.data);
            showDocumentState(null);
            const oldLoad = application.load;
            application.load = function (pdfDocument) {
                pdfjsAdapter.setDocumentFingerprint(pdfDocument, fingerprint);
                return oldLoad.call(this, pdfDocument);
            };
            const preservedState = message.preserveView ? captureViewerState(application) : null;
            let documentInitPending = true;
            let resolveDocumentInit = () => { };
            const documentInitPromise = new Promise(resolve => {
                resolveDocumentInit = resolve;
            });
            const onDocumentInit = () => {
                application.eventBus.off("documentinit", onDocumentInit);
                documentInitPending = false;
                // Restore promptly to avoid flashing PDF.js's default view.
                void restoreViewerState(application, preservedState, () => isLatestDocumentLoad(message)).then(resolveDocumentInit);
            };
            application.eventBus.on("documentinit", onDocumentInit);
            const cancelPendingDocumentInit = () => {
                if (!documentInitPending) {
                    return;
                }
                application.eventBus.off("documentinit", onDocumentInit);
                documentInitPending = false;
            };
            const pendingRender = { fingerprint, startedAt, opened: false };
            pendingFirstPageRender = pendingRender;
            try {
                await application.open({ data, ...loadOptions });
                if (!isLatestDocumentLoad(message)) {
                    cancelPendingDocumentInit();
                    if (pendingFirstPageRender === pendingRender) {
                        pendingFirstPageRender = null;
                    }
                    return;
                }
                pendingRender.opened = true;
                reportDebug("opened", {
                    fingerprint,
                    durationMs: elapsedSince(startedAt),
                    pages: application.pdfDocument?.numPages
                });
                await documentInitPromise;
                if (!isLatestDocumentLoad(message)) {
                    return;
                }
                await application.pdfViewer.pagesPromise;
                await new Promise(resolve => requestAnimationFrame(() => resolve()));
                if (!isLatestDocumentLoad(message)) {
                    return;
                }
                // Heterogeneous pages can make PDF.js correct its initial view
                // after documentinit, so reassert the preserved state once settled.
                await restoreViewerState(application, preservedState, () => isLatestDocumentLoad(message));
                if (!isLatestDocumentLoad(message)) {
                    return;
                }
                completeDocumentLoad(message, true);
            }
            catch (error) {
                cancelPendingDocumentInit();
                if (pendingFirstPageRender === pendingRender) {
                    pendingFirstPageRender = null;
                }
                throw error;
            }
            finally {
                application.load = oldLoad;
            }
        };
        const drainDocumentLoads = async () => {
            while (pendingDocumentLoad) {
                const message = pendingDocumentLoad;
                pendingDocumentLoad = null;
                try {
                    await processDocumentLoad(message);
                }
                catch (error) {
                    if (!isLatestDocumentLoad(message)) {
                        continue;
                    }
                    console.error("Failed to load PDF document.", error);
                    reportDebug("failed", {
                        fingerprint: message.fingerprint,
                        error: errorMessage(error)
                    });
                    completeDocumentLoad(message, false);
                }
            }
        };
        const startDocumentLoadDrain = () => {
            if (documentLoadDrain) {
                return;
            }
            const drain = drainDocumentLoads();
            documentLoadDrain = drain;
            void drain.finally(() => {
                if (documentLoadDrain !== drain) {
                    return;
                }
                documentLoadDrain = null;
                if (pendingDocumentLoad) {
                    scheduleDocumentLoadDrain();
                }
            });
        };
        const scheduleDocumentLoadDrain = () => {
            if (documentLoadDrain || documentLoadStartFrame !== null) {
                return;
            }
            documentLoadStartFrame = requestAnimationFrame(() => {
                documentLoadStartFrame = null;
                startDocumentLoadDrain();
            });
        };
        window.addEventListener("message", (event) => {
            if (typeof event.data === "object"
                && event.data !== null
                && event.data.type === "synctex.configure") {
                window.dispatchEvent(new CustomEvent("academic-pdf-synctex-configure", {
                    detail: event.data.mode,
                }));
                return;
            }
            if (isSyncTexForwardMessage(event.data)) {
                queueSyncTexForward(event.data);
                return;
            }
            if (isSyncTexForwardCancelMessage(event.data)) {
                if (isSameSyncTexForward(pendingSyncTexForward, event.data)) {
                    rejectPendingSyncTexForward();
                }
                return;
            }
            if (isSidebarConfigureMessage(event.data)) {
                defaultSidebar = event.data.defaultSidebar;
                if (application.pdfDocument) {
                    pdfjsAdapter.setSidebarView(defaultSidebar);
                }
                return;
            }
            if (!isDocumentLoadMessage(event.data)
                || event.data.loadId <= latestDocumentLoadId) {
                return;
            }
            latestDocumentLoadId = event.data.loadId;
            clearSyncTexTarget();
            if (pendingSyncTexForward && pendingSyncTexForward.loadId < latestDocumentLoadId) {
                rejectPendingSyncTexForward();
            }
            pendingDocumentLoad = event.data;
            scheduleDocumentLoadDrain();
        });
        window.dispatchEvent(new CustomEvent("academic-pdf-viewer-ready"));
    }, { once: true });
    function showDocumentState(message) {
        let state = document.getElementById("academicPdfDocumentState");
        if (!state) {
            state = document.createElement("div");
            state.id = "academicPdfDocumentState";
            state.setAttribute("role", "status");
            state.hidden = true;
            document.body.appendChild(state);
        }
        if (message === null) {
            state.hidden = true;
            document.body.classList.remove("academicPdfDocumentUnavailable");
            return;
        }
        state.textContent = message;
        state.hidden = false;
        document.body.classList.add("academicPdfDocumentUnavailable");
    }
    window.addEventListener("unhandledrejection", event => {
        reportDebug("unhandledRejection", {
            error: errorMessage(event.reason)
        });
    });
    window.onerror = function (message, source, line, column, error) {
        reportDebug("windowError", {
            error: error ? errorMessage(error) : String(message),
            source: source || "",
            line: line || 0,
            column: column || 0
        });
        const errorBody = document.createElement("body");
        errorBody.innerText = "An error occurred while loading the file. Please open it again.";
        document.body = errorBody;
    };
}());
