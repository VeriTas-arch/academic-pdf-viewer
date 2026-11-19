"use strict";

(function () {
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

    type DocumentLoadMessage = Extract<AcademicExtensionToWebviewMessage, { type: "document.load" | "document.loadRange" }>;
    type DocumentStartMessage = DocumentLoadMessage | Extract<AcademicExtensionToWebviewMessage, { type: "document.loadError" }>;
    type SyncTexForwardMessage = Extract<AcademicExtensionToWebviewMessage, { type: "synctex.forward" }>;
    type SyncTexForwardIdentity = Pick<SyncTexForwardMessage, "requestId" | "loadId">;
    type SyncTexTargetBox = NonNullable<SyncTexForwardMessage["targetBox"]>;

    function configureViewerOptions(targetWindow: ViewerWindow, config: AcademicViewerConfiguration): boolean {
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

    async function restoreViewerState(
        application: PdfJsApplication,
        state: ViewerState | null,
        isCurrentLoad: () => boolean,
    ): Promise<void> {
        const viewer = application.pdfViewer;
        const container = viewer?.container;
        if (!viewer || !container || !state || !isCurrentLoad()) {
            return;
        }

        if (state.sidebar) {
            window.academicPdfJsAdapter.restoreSidebarState(state.sidebar);
        }

        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (!isCurrentLoad()) {
            return;
        }
        if (state.scaleValue) {
            viewer.currentScaleValue = state.scaleValue;
        } else if (Number.isFinite(state.scale) && state.scale > 0) {
            viewer.currentScaleValue = String(state.scale);
        }
        if (Number.isInteger(state.pageNumber)) {
            viewer.currentPageNumber = Math.min(state.pageNumber, viewer.pagesCount);
        }
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (isCurrentLoad()) {
            container.scrollLeft = state.scrollLeft;
            container.scrollTop = state.scrollTop;
        }
    }

    let syncTexTargetMarker: HTMLElement | null = null;
    let syncTexTargetTimer: number | null = null;

    function clearSyncTexTarget(): void {
        syncTexTargetMarker?.remove();
        syncTexTargetMarker = null;
        if (syncTexTargetTimer !== null) {
            window.clearTimeout(syncTexTargetTimer);
            syncTexTargetTimer = null;
        }
    }

    interface SyncTexViewportBox {
        left: number;
        top: number;
        width: number;
        height: number;
    }

    function toSyncTexViewportBox(
        pageView: PdfJsPageView,
        viewBox: number[],
        userUnit: number,
        targetBox: SyncTexTargetBox,
    ): SyncTexViewportBox | undefined {
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
        ].map(([x, y]) => pageView.viewport.convertToViewportPoint(
            viewBox[0] + x / userUnit,
            viewBox[3] - y / userUnit,
        ));
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

    function showSyncTexTarget(
        pageView: PdfJsPageView,
        viewportX: number,
        viewportY: number,
        targetBox?: SyncTexViewportBox,
    ): void {
        clearSyncTexTarget();
        const marker = document.createElement("div");
        marker.className = "academicPdfSyncTexTarget";
        marker.setAttribute("aria-hidden", "true");
        marker.style.position = "absolute";
        marker.dataset.synctexTarget = targetBox ? "box" : "point";
        if (targetBox) {
            const verticalMargin = 3;
            const top = Math.max(0, targetBox.top - verticalMargin);
            const bottom = Math.min(
                pageView.viewport.height,
                targetBox.top + targetBox.height + verticalMargin,
            );
            marker.style.left = `${targetBox.left / pageView.viewport.width * 100}%`;
            marker.style.top = `${top / pageView.viewport.height * 100}%`;
            marker.style.width = `${targetBox.width / pageView.viewport.width * 100}%`;
            marker.style.height = `${(bottom - top) / pageView.viewport.height * 100}%`;
        } else {
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
    async function applySyncTexForward(
        message: SyncTexForwardMessage,
        application: PdfJsApplication,
        isCurrentLoad: () => boolean,
    ): Promise<boolean> {
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
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
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

    function isSidebarView(value: unknown): value is AcademicSidebarView {
        return value === "pages"
            || value === "outline"
            || value === "attachments"
            || value === "layers";
    }

    const value = document.getElementById("pdf-preview-config")?.getAttribute("data-config");
    if (!value) {
        throw new Error("Could not load the PDF viewer configuration.");
    }
    const config = window.academicViewerConfiguration = JSON.parse(value) as AcademicViewerConfiguration;
    const firstPageMeasure = "Academic PDF Viewer: first page";
    const pdfjsAdapter = window.academicPdfJsAdapter;
    const { post, subscribe } = window.academicExtensionMessages;
    const releaseUnopenedRange = (message: DocumentStartMessage | null | undefined): void => {
        if (message?.type === "document.loadRange") {
            post({ type: "document.rangeClose", loadId: message.loadId });
        }
    };
    let handleHostMessage: ((message: AcademicExtensionToWebviewMessage) => void) | undefined;
    let earlyLoad: DocumentStartMessage | undefined;
    subscribe(message => {
        if (handleHostMessage) {
            handleHostMessage(message);
        } else if (message.type === "document.load" || message.type === "document.loadRange"
            || message.type === "document.loadError") {
            if (!earlyLoad || message.loadId > earlyLoad.loadId) {
                releaseUnopenedRange(earlyLoad);
                earlyLoad = message;
            } else if (message.loadId < earlyLoad.loadId) {
                releaseUnopenedRange(message);
            }
        }
    });
    let workerBlobUrl: string | null = null;
    const prepareWorkerSource = async (): Promise<void> => {
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
        } catch (error) {
            console.warn("Could not start the bundled PDF worker. Falling back to PDF.js's main-thread worker.", error);
            await import(localWorkerSrc);
        }
    };
    const workerSourceReady = prepareWorkerSource().catch((error: unknown) => ({ error }));
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

    async function initializeViewer(): Promise<void> {
        const application = pdfjsAdapter.getApplication();
        if (!application) {
            throw new Error("PDF.js viewer application is unavailable.");
        }
        const workerFailure = await workerSourceReady;
        if (workerFailure) {
            throw workerFailure.error;
        }
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
        let firstPageStart: number | undefined;
        let defaultSidebar: AcademicSidebarView = isSidebarView(config.defaultSidebar)
            ? config.defaultSidebar
            : "pages";

        await application.initializedPromise;

        application.eventBus.on<{ source: PdfJsPageView }>("annotationlayerrendered", event => {
            pdfjsAdapter.scaleLinkBorders(event.source);
        });
        application.eventBus.on<{ error?: unknown; cssTransform?: boolean; isDetailView?: boolean }>("pagerendered", event => {
            if (firstPageStart !== undefined && !event.error && !event.cssTransform && !event.isDetailView) {
                performance.measure(firstPageMeasure, {
                    start: firstPageStart, detail: latestDocumentLoadId,
                });
                firstPageStart = undefined;
            }
        });
        application.eventBus.on("documentinit", () => {
            pdfjsAdapter.setSidebarView(defaultSidebar);
        });

        let latestDocumentLoadId = 0;
        let completedDocumentLoadId = 0;
        let completedDocumentAvailable = false;
        let pendingDocumentLoad: DocumentLoadMessage | null = null;
        let documentLoadDrain: Promise<void> | null = null;
        let documentLoadStartFrame: number | null = null;
        let rangeTransport: ReturnType<Window["createAcademicPdfRangeTransport"]> | undefined;
        let rangeClosing: Promise<void> | undefined;
        let cancelRangeWait: (() => void) | undefined;
        let replacementView: ViewerState | null = null;
        const closeRangedDocument = (readFailed = false): void => {
            if (rangeClosing) {
                if (readFailed) {
                    // close() may already be waiting for a save on the failed source.
                    void application.pdfLoadingTask?.destroy().catch(error => console.error(error));
                }
                return;
            }
            if (!rangeTransport) {
                return;
            }
            const closing = rangeTransport;
            cancelRangeWait?.();
            if (readFailed) {
                application.pdfDocument?.annotationStorage.resetModified();
            }
            // PDF.js saves edited forms before destroying the task and its transport.
            rangeClosing = application.close().catch(error => {
                console.error("Could not close the PDF range loading task.", error);
            }).finally(() => {
                closing.range.abort();
                rangeTransport = undefined;
            });
        };
        window.addEventListener("pagehide", () => rangeTransport?.range.abort(), { once: true });
        application.eventBus.on<{ query: unknown }>("find", event => {
            rangeTransport?.setSearchPrefetch(typeof event.query === "string" && event.query.length > 0);
        });
        application.eventBus.on("findbarclose", () => rangeTransport?.setSearchPrefetch(false));
        let pendingSyncTexForward: SyncTexForwardMessage | null = null;
        let syncTexForwardDrain: Promise<void> | null = null;

        const isSameSyncTexForward = (
            first: SyncTexForwardIdentity | null,
            second: SyncTexForwardIdentity,
        ): boolean => first?.requestId === second.requestId && first.loadId === second.loadId;
        const postSyncTexForwardResult = (
            message: SyncTexForwardMessage,
            status: "applied" | "rejected",
        ): void => {
            post({ type: "synctex.forwardResult", requestId: message.requestId, loadId: message.loadId, status });
        };
        const rejectPendingSyncTexForward = (): void => {
            if (!pendingSyncTexForward) {
                return;
            }
            const message = pendingSyncTexForward;
            pendingSyncTexForward = null;
            postSyncTexForwardResult(message, "rejected");
        };
        const drainSyncTexForward = (): void => {
            if (syncTexForwardDrain
                || !pendingSyncTexForward
                || pendingSyncTexForward.loadId !== completedDocumentLoadId) {
                return;
            }

            const message = pendingSyncTexForward;
            const drain = (async (): Promise<void> => {
                let applied = false;
                if (completedDocumentAvailable) {
                    try {
                        applied = await applySyncTexForward(
                            message,
                            application,
                            () => isSameSyncTexForward(pendingSyncTexForward, message)
                                && latestDocumentLoadId === message.loadId
                                && completedDocumentLoadId === message.loadId
                                && completedDocumentAvailable,
                        );
                    } catch (error) {
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
        const completeDocumentLoad = (message: DocumentLoadMessage, available: boolean): void => {
            if (message.loadId !== latestDocumentLoadId) {
                return;
            }
            completedDocumentLoadId = message.loadId;
            completedDocumentAvailable = available;
            window.dispatchEvent(new CustomEvent("academic-pdf-document-loaded", {
                detail: { loadId: message.loadId, available },
            }));
            drainSyncTexForward();
        };
        const queueSyncTexForward = (message: SyncTexForwardMessage): void => {
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

        const isLatestDocumentLoad = (message: DocumentLoadMessage): boolean => (
            message.loadId === latestDocumentLoadId
        );
        const processDocumentLoad = async (message: DocumentLoadMessage): Promise<void> => {
            const startedAt = performance.now();
            if (!isLatestDocumentLoad(message)) {
                releaseUnopenedRange(message);
                return;
            }
            const preservedState = message.preserveView ? replacementView ?? captureViewerState(application) : null;
            replacementView = null;
            if (rangeClosing) {
                await rangeClosing;
                rangeClosing = undefined;
            }
            if (!isLatestDocumentLoad(message)) {
                releaseUnopenedRange(message);
                return;
            }
            if (message.type === "document.load" && message.isEmptyRevision) {
                if (application.pdfLoadingTask) {
                    await application.close();
                }
                if (!isLatestDocumentLoad(message)) {
                    return;
                }
                showDocumentState("This file does not exist in this revision.");
                completeDocumentLoad(message, false);
                return;
            }

            showDocumentState(null);
            const oldLoad = application.load;
            application.load = function (pdfDocument: PdfJsDocument): unknown {
                if (isLatestDocumentLoad(message)) {
                    firstPageStart = startedAt;
                }
                pdfjsAdapter.setDocumentFingerprint(pdfDocument, message.fingerprint);
                return oldLoad.call(this, pdfDocument);
            };

            let resolveDocumentInit!: (value: Promise<void>) => void;
            const documentInitPromise = new Promise<void>(resolve => { resolveDocumentInit = resolve; });
            // Init can reject before application.open() settles.
            void documentInitPromise.catch(() => undefined);
            const onDocumentInit = (): void => {
                application.eventBus.off("documentinit", onDocumentInit);
                resolveDocumentInit(restoreViewerState(application, preservedState, () => isLatestDocumentLoad(message)));
            };
            application.eventBus.on("documentinit", onDocumentInit);

            let input: Record<string, unknown> = { data: new Uint8Array(message.data) };
            let interrupted: Promise<boolean> | undefined;
            const waitForLoadStep = (promise: Promise<unknown>): Promise<boolean> => {
                const completed = promise.then(() => true);
                return interrupted ? Promise.race([completed, interrupted]) : completed;
            };
            try {
                if (message.type === "document.loadRange") {
                    interrupted = new Promise(resolve => { cancelRangeWait = () => resolve(false); });
                    rangeTransport = window.createAcademicPdfRangeTransport(message, error => {
                        if (isLatestDocumentLoad(message)) {
                            showDocumentState("Unable to read the PDF. Use PDF: Reload to try again.");
                            console.error("Could not read the PDF range.", error);
                            completeDocumentLoad(message, false);
                        }
                        closeRangedDocument(true);
                    });
                    input = { range: rangeTransport.range, rangeChunkSize: 64 * 1024, disableStream: true, disableAutoFetch: true };
                }
                if (!await waitForLoadStep(application.open({ ...input, ...loadOptions }))) {
                    return;
                }
                if (!isLatestDocumentLoad(message) || !await waitForLoadStep(documentInitPromise) || !isLatestDocumentLoad(message)) {
                    return;
                }
                if (!await waitForLoadStep(application.pdfViewer.pagesPromise)) {
                    return;
                }
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                if (!isLatestDocumentLoad(message)) {
                    return;
                }
                // Heterogeneous pages can make PDF.js correct its initial view
                // after documentinit, so reassert the preserved state once settled.
                await restoreViewerState(
                    application,
                    preservedState,
                    () => isLatestDocumentLoad(message),
                );
                if (!isLatestDocumentLoad(message)) {
                    return;
                }
                completeDocumentLoad(message, true);
            } catch (error) {
                if (isLatestDocumentLoad(message)) {
                    firstPageStart = undefined;
                }
                if (message.type === "document.loadRange") {
                    closeRangedDocument();
                }
                throw error;
            } finally {
                cancelRangeWait = undefined;
                application.eventBus.off("documentinit", onDocumentInit);
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
                    completeDocumentLoad(message, false);
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
        handleHostMessage = message => {
            if (message.type === "synctex.forward") {
                queueSyncTexForward(message);
                return;
            }
            if (message.type === "synctex.forwardCancel") {
                if (isSameSyncTexForward(pendingSyncTexForward, message)) {
                    rejectPendingSyncTexForward();
                }
                return;
            }
            if (message.type === "sidebar.configure") {
                defaultSidebar = message.defaultSidebar;
                if (application.pdfDocument) {
                    pdfjsAdapter.setSidebarView(defaultSidebar);
                }
                return;
            }
            if ((message.type !== "document.load" && message.type !== "document.loadRange"
                && message.type !== "document.loadError")) {
                return;
            }
            if (message.loadId <= latestDocumentLoadId) {
                if (message.loadId < latestDocumentLoadId) {
                    releaseUnopenedRange(message);
                }
                return;
            }
            releaseUnopenedRange(pendingDocumentLoad);
            if (rangeTransport && message.type !== "document.loadError" && message.preserveView) {
                replacementView = captureViewerState(application) ?? replacementView;
            }
            closeRangedDocument();
            latestDocumentLoadId = message.loadId;
            firstPageStart = undefined;
            performance.clearMeasures(firstPageMeasure);
            if (message.type === "document.loadError") {
                pendingDocumentLoad = null;
                showDocumentState("Unable to open the PDF. Use PDF: Reload to try again.");
                return;
            }
            clearSyncTexTarget();
            if (pendingSyncTexForward && pendingSyncTexForward.loadId < latestDocumentLoadId) {
                rejectPendingSyncTexForward();
            }
            pendingDocumentLoad = message;
            scheduleDocumentLoadDrain();
        };

        if (earlyLoad) {
            handleHostMessage(earlyLoad);
            earlyLoad = undefined;
        }

        window.dispatchEvent(new CustomEvent("academic-pdf-viewer-ready"));
    }

    window.addEventListener("load", () => {
        void initializeViewer().catch(error => {
            releaseUnopenedRange(earlyLoad);
            earlyLoad = undefined;
            handleHostMessage = message => {
                if (message.type === "document.loadRange") {
                    releaseUnopenedRange(message);
                }
            };
            showDocumentState("Unable to start the PDF viewer. Reopen the editor to try again.");
            console.error("Failed to initialize the PDF viewer.", error);
        });
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
}());
