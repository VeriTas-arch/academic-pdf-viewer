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
            scrollTop: container.scrollTop
        };
    }
    function restoreViewerState(application, state, isCurrentLoad) {
        const viewer = application.pdfViewer;
        const container = viewer?.container;
        if (!viewer || !container || !state) {
            return;
        }
        requestAnimationFrame(() => {
            if (!isCurrentLoad()) {
                return;
            }
            if (typeof state.scaleValue === "string" && state.scaleValue.length > 0) {
                viewer.currentScaleValue = state.scaleValue;
            }
            else if (Number.isFinite(state.scale) && state.scale > 0) {
                viewer.currentScaleValue = String(state.scale);
            }
            if (Number.isInteger(state.pageNumber)) {
                viewer.currentPageNumber = Math.min(state.pageNumber, viewer.pagesCount);
            }
            requestAnimationFrame(() => {
                if (!isCurrentLoad()) {
                    return;
                }
                container.scrollLeft = state.scrollLeft;
                container.scrollTop = state.scrollTop;
            });
        });
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
        let latestDocumentLoadId = 0;
        let pendingDocumentLoad = null;
        let documentLoadDrain = null;
        let documentLoadStartFrame = null;
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
            let restorePending = false;
            const restoreOnDocumentInit = () => {
                application.eventBus.off("documentinit", restoreOnDocumentInit);
                restorePending = false;
                restoreViewerState(application, preservedState, () => isLatestDocumentLoad(message));
            };
            if (preservedState) {
                restorePending = true;
                application.eventBus.on("documentinit", restoreOnDocumentInit);
            }
            const cancelPendingRestore = () => {
                if (!restorePending) {
                    return;
                }
                application.eventBus.off("documentinit", restoreOnDocumentInit);
                restorePending = false;
            };
            const pendingRender = { fingerprint, startedAt, opened: false };
            pendingFirstPageRender = pendingRender;
            try {
                await application.open({ data, ...loadOptions });
                if (!isLatestDocumentLoad(message)) {
                    cancelPendingRestore();
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
            }
            catch (error) {
                cancelPendingRestore();
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
            if (!isDocumentLoadMessage(event.data)
                || event.data.loadId <= latestDocumentLoadId) {
                return;
            }
            latestDocumentLoadId = event.data.loadId;
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
