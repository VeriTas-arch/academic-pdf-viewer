"use strict";

(function () {
    interface ViewerConfig {
        cMapUrl: string;
        debug: boolean;
        iccUrl: string;
        imageResourcesPath: string;
        standardFontDataUrl: string;
        wasmUrl: string;
        workerSrc: string;
        defaultSidebar?: unknown;
        syncTexMode?: 'off' | 'doubleclick' | 'rightclick';
    }

    interface ViewerOptions {
        set(name: string, value: unknown): void;
    }

    interface ViewerWindow {
        PDFViewerApplicationOptions?: ViewerOptions;
    }

    interface ViewerState {
        pageNumber: number;
        scale: number;
        scaleValue: string;
        scrollLeft: number;
        scrollTop: number;
        sidebar: AcademicSidebarState | null;
    }

    interface DocumentLoadMessage {
        type: "document.load";
        loadId: number;
        data: ArrayBuffer;
        isEmptyRevision: boolean;
        fingerprint: string;
        preserveView: boolean;
    }

    interface SidebarConfigureMessage {
        type: "sidebar.configure";
        defaultSidebar: AcademicSidebarView;
    }

    type SyncTexForwardMessage = {
        type: "synctex.forward";
        pageNumber: number;
        x: number;
        y: number;
    };

    interface PendingFirstPageRender {
        fingerprint: string;
        startedAt: number;
        opened: boolean;
    }

    function loadConfig(): ViewerConfig {
        const element = document.getElementById("pdf-preview-config");
        const value = element?.getAttribute("data-config");
        if (!value) {
            throw new Error("Could not load configuration.");
        }
        return JSON.parse(value) as ViewerConfig;
    }

    function configureViewerOptions(targetWindow: ViewerWindow, config: ViewerConfig): boolean {
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

    function captureViewerState(application: PdfJsApplication): ViewerState | null {
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

    function restoreViewerState(
        application: PdfJsApplication,
        state: ViewerState | null,
        isCurrentLoad: () => boolean,
    ): void {
        const viewer = application.pdfViewer;
        const container = viewer?.container;
        if (!viewer || !container || !state || !isCurrentLoad()) {
            return;
        }

        if (state.sidebar) {
            window.academicPdfJsAdapter.restoreSidebarState(state.sidebar);
        }

        requestAnimationFrame(() => {
            if (!isCurrentLoad()) {
                return;
            }
            if (typeof state.scaleValue === "string" && state.scaleValue.length > 0) {
                viewer.currentScaleValue = state.scaleValue;
            } else if (Number.isFinite(state.scale) && state.scale > 0) {
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

    function isDocumentLoadMessage(value: unknown): value is DocumentLoadMessage {
        if (typeof value !== "object" || value === null) {
            return false;
        }
        const message = value as Record<string, unknown>;
        return message.type === "document.load"
            && typeof message.loadId === "number"
            && Number.isSafeInteger(message.loadId)
            && message.loadId >= 1
            && message.data instanceof ArrayBuffer
            && typeof message.isEmptyRevision === "boolean"
            && typeof message.fingerprint === "string"
            && typeof message.preserveView === "boolean";
    }

    function isSidebarConfigureMessage(value: unknown): value is SidebarConfigureMessage {
        if (typeof value !== "object" || value === null) {
            return false;
        }
        const message = value as Record<string, unknown>;
        return message.type === "sidebar.configure"
            && isSidebarView(message.defaultSidebar);
    }

    /** Navigates to a SyncTeX location without changing the current zoom. */
    function applySyncTexForward(message: SyncTexForwardMessage, application: PdfJsApplication): void {
        const viewer = application.pdfViewer;
        if (!viewer || message.pageNumber > viewer.pagesCount) {
            return;
        }

        void viewer.pagesPromise.then(() => {
            if (message.pageNumber > viewer.pagesCount) {
                return;
            }
            const pageView = viewer.getPageView(message.pageNumber - 1);
            const pageHeight = pageView?.viewport.viewBox[3];
            if (typeof pageHeight !== "number" || !Number.isFinite(pageHeight)) {
                return;
            }
            viewer.scrollPageIntoView({
                pageNumber: message.pageNumber,
                destArray: [
                    null,
                    { name: "XYZ" },
                    message.x,
                    pageHeight - message.y,
                    null,
                ],
                allowNegativeOffset: true,
                ignoreDestinationZoom: true,
            });
        });
    }

    function isSidebarView(value: unknown): value is AcademicSidebarView {
        return value === "pages"
            || value === "outline"
            || value === "attachments"
            || value === "layers";
    }

    const config = loadConfig();
    const pdfjsAdapter = window.academicPdfJsAdapter;
    const reportDebug = (event: string, fields: Record<string, unknown> = {}): void => {
        if (!config.debug) {
            return;
        }
        window.dispatchEvent(new CustomEvent("academic-pdf-debug", {
            detail: { type: "pdf.debug", event, ...fields }
        }));
    };
    const elapsedSince = (startedAt: number): number => Math.round(performance.now() - startedAt);
    const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
    let workerBlobUrl: string | null = null;
    const prepareWorkerSource = async (): Promise<void> => {
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
        } catch (error) {
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
    const configureOnViewerLoaded = (event: Event): void => {
        const detail = (event as CustomEvent<{ source?: ViewerWindow }>).detail;
        configureViewerOptions(detail?.source ?? window, config);
    };
    document.addEventListener("webviewerloaded", configureOnViewerLoaded, { once: true });
    try {
        if (parent.document !== document) {
            parent.document.addEventListener("webviewerloaded", configureOnViewerLoaded, { once: true });
        }
    } catch {
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
        } as const;
        let pendingFirstPageRender: PendingFirstPageRender | null = null;
        let defaultSidebar: AcademicSidebarView = isSidebarView(config.defaultSidebar)
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

        application.eventBus.on<{ pageNumber: number }>("pagerendered", event => {
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
        let pendingDocumentLoad: DocumentLoadMessage | null = null;
        let documentLoadDrain: Promise<void> | null = null;
        let documentLoadStartFrame: number | null = null;

        const isLatestDocumentLoad = (message: DocumentLoadMessage): boolean => (
            message.loadId === latestDocumentLoadId
        );
        const processDocumentLoad = async (message: DocumentLoadMessage): Promise<void> => {
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
            application.load = function (pdfDocument: PdfJsDocument): unknown {
                pdfjsAdapter.setDocumentFingerprint(pdfDocument, fingerprint);
                return oldLoad.call(this, pdfDocument);
            };

            const preservedState = message.preserveView ? captureViewerState(application) : null;
            let restorePending = false;
            const restoreOnDocumentInit = (): void => {
                application.eventBus.off("documentinit", restoreOnDocumentInit);
                restorePending = false;
                restoreViewerState(
                    application,
                    preservedState,
                    () => isLatestDocumentLoad(message),
                );
            };
            if (preservedState) {
                restorePending = true;
                application.eventBus.on("documentinit", restoreOnDocumentInit);
            }
            const cancelPendingRestore = (): void => {
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
            } catch (error) {
                cancelPendingRestore();
                if (pendingFirstPageRender === pendingRender) {
                    pendingFirstPageRender = null;
                }
                throw error;
            } finally {
                application.load = oldLoad;
            }
        };
        const drainDocumentLoads = async (): Promise<void> => {
            while (pendingDocumentLoad) {
                const message = pendingDocumentLoad;
                pendingDocumentLoad = null;
                try {
                    await processDocumentLoad(message);
                } catch (error) {
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
        const startDocumentLoadDrain = (): void => {
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
        const scheduleDocumentLoadDrain = (): void => {
            if (documentLoadDrain || documentLoadStartFrame !== null) {
                return;
            }
            documentLoadStartFrame = requestAnimationFrame(() => {
                documentLoadStartFrame = null;
                startDocumentLoadDrain();
            });
        };
        window.addEventListener("message", (event: MessageEvent<unknown>) => {
            if (typeof event.data === "object"
                && event.data !== null
                && (event.data as { type?: unknown }).type === "synctex.configure") {
                window.dispatchEvent(new CustomEvent("academic-pdf-synctex-configure", {
                    detail: (event.data as { mode?: unknown }).mode,
                }));
                return;
            }
            if (typeof event.data === "object"
                && event.data !== null
                && (event.data as { type?: unknown }).type === "synctex.forward") {
                applySyncTexForward(event.data as SyncTexForwardMessage, application);
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
            pendingDocumentLoad = event.data;
            scheduleDocumentLoadDrain();
        });

        window.dispatchEvent(new CustomEvent("academic-pdf-viewer-ready"));
    }, { once: true });

    function showDocumentState(message: string | null): void {
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

    window.onerror = function (message, source, line, column, error): void {
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
