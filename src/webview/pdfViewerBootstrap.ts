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
        scrollLeft: number;
        scrollTop: number;
    }

    interface DocumentLoadMessage {
        type: "document.load";
        data: ArrayBuffer;
        isEmptyRevision: boolean;
        fingerprint: string;
        preserveView: boolean;
    }

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
            scrollLeft: container.scrollLeft,
            scrollTop: container.scrollTop
        };
    }

    function restoreViewerState(application: PdfJsApplication, state: ViewerState | null): void {
        const viewer = application.pdfViewer;
        const container = viewer?.container;
        if (!viewer || !container || !state) {
            return;
        }

        if (Number.isFinite(state.scale) && state.scale > 0) {
            viewer.currentScaleValue = String(state.scale);
        }
        if (Number.isInteger(state.pageNumber)) {
            viewer.currentPageNumber = Math.min(state.pageNumber, viewer.pagesCount);
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
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
            && message.data instanceof ArrayBuffer
            && typeof message.isEmptyRevision === "boolean"
            && typeof message.fingerprint === "string"
            && typeof message.preserveView === "boolean";
    }

    const config = loadConfig();
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
        const application = window.PDFViewerApplication;
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

        window.addEventListener("message", async (event: MessageEvent<unknown>) => {
            if (!isDocumentLoadMessage(event.data)) {
                return;
            }

            const message = event.data;
            const startedAt = performance.now();
            const fingerprint = message.fingerprint;
            await application.initializedPromise;
            if (message.isEmptyRevision) {
                pendingFirstPageRender = null;
                if (application.pdfLoadingTask) {
                    await application.close();
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
                if (pdfDocument?._pdfInfo) {
                    pdfDocument._pdfInfo.fingerprints = [fingerprint];
                }
                return oldLoad.call(this, pdfDocument);
            };

            const preservedState = message.preserveView ? captureViewerState(application) : null;
            let restorePending = false;
            const restoreOnDocumentInit = (): void => {
                application.eventBus.off("documentinit", restoreOnDocumentInit);
                restorePending = false;
                restoreViewerState(application, preservedState);
            };
            if (preservedState) {
                restorePending = true;
                application.eventBus.on("documentinit", restoreOnDocumentInit);
            }

            const pendingRender = { fingerprint, startedAt, opened: false };
            pendingFirstPageRender = pendingRender;
            try {
                await application.open({ data, ...loadOptions });
                pendingRender.opened = true;
                reportDebug("opened", {
                    fingerprint,
                    durationMs: elapsedSince(startedAt),
                    pages: application.pdfDocument?.numPages
                });
            } catch (error) {
                if (restorePending) {
                    application.eventBus.off("documentinit", restoreOnDocumentInit);
                }
                if (pendingFirstPageRender === pendingRender) {
                    pendingFirstPageRender = null;
                }
                console.error("Failed to load PDF document.", error);
                reportDebug("failed", {
                    fingerprint,
                    durationMs: elapsedSince(startedAt),
                    error: errorMessage(error)
                });
            } finally {
                application.load = oldLoad;
            }
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
