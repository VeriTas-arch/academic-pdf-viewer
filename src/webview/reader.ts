/// <reference path="./globals.d.ts" />

"use strict";

(function () {
    type NavigationDirection = "back" | "forward";

    interface NavigationPoint {
        pageNumber: number;
        scrollTop: number;
        scrollLeft: number;
        scale: number;
        pdfLeft: number | null;
        pdfTop: number | null;
    }

    interface SyncTexTextHint {
        context: string;
        offset: number;
    }

    interface SyncTexPointer extends Partial<SyncTexTextHint> {
        pageNumber: number;
        x: number;
        y: number;
    }

    const { post, subscribe } = window.academicExtensionMessages;
    const pdfjsAdapter = window.academicPdfJsAdapter;
    const config = window.academicViewerConfiguration;
    if (!config.diffRole) {
        post({ type: "webview.documentReady" });
    }
    let mouseNavigationEnabled = config.mouseNavigationEnabled !== false;
    let mouseButtonMapping: AcademicMouseButtonMapping = config.mouseButtonMapping === "swapped" ? "swapped" : "standard";
    let syncTexMode: "off" | "doubleclick" | "rightclick" = "off";
    window.addEventListener("academic-pdf-viewer-ready", () => {
        post({ type: "webview.ready" });
    }, { once: true });
    window.addEventListener("keydown", handleViewerShortcutBoundary, true);
    window.addEventListener("mousedown", handleMouseNavigation, true);
    window.addEventListener("dblclick", handleSyncTexDoubleClick, true);
    window.addEventListener("contextmenu", handleSyncTexContextMenu, true);
    configureSyncTexMode(config.syncTexMode === "off" || config.syncTexMode === "rightclick" ? config.syncTexMode : "doubleclick");
    subscribe(message => {
        if (message.type === "synctex.configure") {
            configureSyncTexMode(message.mode);
        }
    });
    window.addEventListener("mouseup", consumeMouseNavigation, true);
    window.addEventListener("auxclick", consumeMouseNavigation, true);
    const pressedNavigationKeys = {
        back: false,
        forward: false
    };
    const minScale = 0.1;
    const maxScale = 10;
    const wheelZoomBase = 1.1;
    let pendingWheelZoomDelta = 0;
    let pendingWheelZoomPoint: WheelZoomPoint | null = null;
    let pendingWheelZoomAnimationFrame: number | null = null;
    const patchedLinkServices = new WeakSet<PdfJsLinkService>();

    interface WheelZoomPoint {
        clientX: number;
        clientY: number;
    }

    class NavigationHistory {
        _onNavigate: (location: NavigationPoint) => void;
        _backStack: NavigationPoint[];
        _forwardStack: NavigationPoint[];

        constructor(onNavigate: (location: NavigationPoint) => void) {
            this._onNavigate = onNavigate;
            this._backStack = [];
            this._forwardStack = [];
        }

        reset() {
            this._backStack = [];
            this._forwardStack = [];
        }

        pushDeparture(location: NavigationPoint | null): void {
            if (!location || locationsEqual(this._backStack[this._backStack.length - 1], location)) {
                return;
            }
            this._backStack.push(location);
            this._forwardStack = [];
        }

        go(direction: NavigationDirection, currentLocation: NavigationPoint | null): void {
            const from = direction === "back" ? this._backStack : this._forwardStack;
            const to = direction === "back" ? this._forwardStack : this._backStack;
            const destination = from.pop();
            if (!destination) {
                return;
            }
            if (currentLocation && !locationsEqual(to.at(-1), currentLocation)) {
                to.push(currentLocation);
            }
            this._onNavigate(destination);
        }
    }

    function normalizeLocation(location: NavigationPoint | null): NavigationPoint | null {
        if (!location) {
            return null;
        }
        const pdfLeft = typeof location.pdfLeft === "number" && Number.isFinite(location.pdfLeft)
            ? Math.round(location.pdfLeft)
            : null;
        const pdfTop = typeof location.pdfTop === "number" && Number.isFinite(location.pdfTop)
            ? Math.round(location.pdfTop)
            : null;
        return {
            pageNumber: location.pageNumber,
            scrollTop: Math.round(location.scrollTop),
            scrollLeft: Math.round(location.scrollLeft),
            scale: Math.round(location.scale * 10000) / 10000,
            pdfLeft,
            pdfTop
        };
    }

    function locationsEqual(a: NavigationPoint | undefined | null, b: NavigationPoint | undefined | null): boolean {
        if (!a || !b) {
            return false;
        }
        return a.pageNumber === b.pageNumber
            && a.scrollTop === b.scrollTop
            && a.scrollLeft === b.scrollLeft
            && Math.abs(a.scale - b.scale) < 0.0001
            && a.pdfLeft === b.pdfLeft
            && a.pdfTop === b.pdfTop;
    }

    function captureLocation(): NavigationPoint | null {
        const viewer = pdfjsAdapter.getViewer();
        if (!viewer) {
            return null;
        }

        const { container } = viewer;
        const pdfLocation = pdfjsAdapter.getPdfLocation(viewer);

        return normalizeLocation({
            pageNumber: viewer.currentPageNumber,
            scrollTop: container.scrollTop,
            scrollLeft: container.scrollLeft,
            scale: viewer.currentScale,
            pdfLeft: pdfLocation.left,
            pdfTop: pdfLocation.top
        });
    }

    function restoreLocation(location: NavigationPoint): void {
        const viewer = pdfjsAdapter.getViewer();
        if (!viewer) {
            return;
        }

        restoring = true;
        const app = pdfjsAdapter.getApplication();
        const pdfLeft = typeof location.pdfLeft === "number" && Number.isFinite(location.pdfLeft) ? location.pdfLeft : 0;
        const pdfTop = typeof location.pdfTop === "number" && Number.isFinite(location.pdfTop) ? location.pdfTop : 0;
        if (canRestoreWithPdfDestination(location, viewer)) {
            viewer.scrollPageIntoView({
                pageNumber: location.pageNumber,
                destArray: [
                    null,
                    { name: "XYZ" },
                    pdfLeft,
                    pdfTop,
                    location.scale
                ],
                allowNegativeOffset: true,
                ignoreDestinationZoom: false
            });
            finishRestore(viewer.container, location);
            return;
        }

        viewer.currentScaleValue = String(location.scale);
        if (app && app.pdfLinkService) {
            app.pdfLinkService.goToPage(location.pageNumber);
        }
        finishRestore(viewer.container, location);
    }

    function canRestoreWithPdfDestination(location: NavigationPoint, viewer: PdfJsViewer): boolean {
        const hasPdfPosition = typeof location.pdfLeft === "number"
            && Number.isFinite(location.pdfLeft)
            && typeof location.pdfTop === "number"
            && Number.isFinite(location.pdfTop);
        return Number.isFinite(location.pageNumber)
            && hasPdfPosition
            && Number.isFinite(location.scale)
            && typeof viewer.scrollPageIntoView === "function";
    }

    function finishRestore(container: HTMLElement, location: NavigationPoint): void {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                container.scrollTop = location.scrollTop;
                container.scrollLeft = location.scrollLeft;
                restoring = false;
            });
        });
    }

    function recordDeparture(): void {
        if (restoring || !history) {
            return;
        }
        history.pushDeparture(captureLocation());
    }

    function patchExplicitNavigation(app: PdfJsApplication): void {
        const linkService = app.pdfLinkService;
        if (linkService && !patchedLinkServices.has(linkService)) {
            const goToDestination = linkService.goToDestination.bind(linkService);
            linkService.goToDestination = function (...args: unknown[]) {
                recordDeparture();
                return goToDestination(...args);
            };

            const goToPage = linkService.goToPage.bind(linkService);
            linkService.goToPage = function (...args: unknown[]) {
                recordDeparture();
                return goToPage(...args);
            };

            const setHash = linkService.setHash.bind(linkService);
            linkService.setHash = function (...args: unknown[]) {
                recordDeparture();
                return setHash(...args);
            };

            patchedLinkServices.add(linkService);
        }

        const viewer = app.pdfViewer;
        pdfjsAdapter.interceptPageNumberChanges(viewer, (pageNumber, resetCurrentPageView) => {
            if (resetCurrentPageView && pageNumber !== viewer.currentPageNumber) {
                recordDeparture();
            }
        });
    }

    function handleNavigationMessage(data: AcademicExtensionToWebviewMessage): void {
        if (data.type === "navigation.configure") {
            mouseNavigationEnabled = data.mouseButtonsEnabled;
            mouseButtonMapping = data.mouseButtonMapping;
        } else if (data.type === "navigation.back" || data.type === "navigation.forward") {
            const direction = data.type === "navigation.back" ? "back" : "forward";
            if (!pressedNavigationKeys[direction]) {
                history?.go(direction, captureLocation());
            }
        }
    }

    function handleViewerShortcutBoundary(event: KeyboardEvent): void {
        const key = event.key.toLowerCase();
        const primaryModifier = event.ctrlKey || event.metaKey;
        if (primaryModifier && !event.altKey && key === "p") {
            if (!event.repeat) {
                post({
                    type: event.shiftKey ? "workbench.showCommands" : "workbench.quickOpen"
                });
            }
            consumeShortcut(event);
            return;
        }
        if (primaryModifier && !event.altKey && !event.shiftKey && key === "o") {
            if (!event.repeat) {
                post({ type: "workbench.openFile" });
            }
            consumeShortcut(event);
            return;
        }
        if (!primaryModifier && !event.altKey && key === "r" && !isEditableKeyboardTarget(event.target)) {
            consumeShortcut(event);
        }
    }

    function handleMouseNavigation(event: MouseEvent): void {
        if (!mouseNavigationEnabled) {
            return;
        }
        const direction = mouseNavigationDirection(event);
        if (!direction) {
            return;
        }
        consumeMouseEvent(event);
        post({ type: "navigation.request", direction });
    }

    const syncTexPageContext = JSON.stringify({ webviewSection: "pdfPage" });

    function setSyncTexPageContexts(): void {
        const viewer = pdfjsAdapter.getViewer();
        if (!viewer) {
            return;
        }
        for (let index = 0; index < viewer.pagesCount; index++) {
            viewer.getPageView(index)?.div.setAttribute("data-vscode-context", syncTexPageContext);
        }
    }

    function isInteractivePointerTarget(target: EventTarget | null): boolean {
        return target instanceof Element
            && target.closest(
                "a, button, input, textarea, select, option, [contenteditable]:not([contenteditable='false'])",
            ) !== null;
    }

    function getSyncTexTextHint(
        event: MouseEvent,
        pageView: PdfJsPageView,
    ): SyncTexTextHint | undefined {
        const textElement = document.elementsFromPoint(event.clientX, event.clientY)
            .map(element => element.closest(".textLayer span"))
            .find((element): element is HTMLElement => (
                element instanceof HTMLElement && pageView.div.contains(element)
            ));
        if (!textElement) {
            return undefined;
        }

        const caretDocument = document as Document & {
            caretPositionFromPoint?: (
                x: number,
                y: number,
            ) => { offsetNode: Node; offset: number } | null;
            caretRangeFromPoint?: (x: number, y: number) => Range | null;
        };
        const caretPosition = caretDocument.caretPositionFromPoint?.(event.clientX, event.clientY);
        const caretRange = caretPosition
            ? undefined
            : caretDocument.caretRangeFromPoint?.(event.clientX, event.clientY);
        const offsetNode = caretPosition?.offsetNode ?? caretRange?.startContainer;
        const offset = caretPosition?.offset ?? caretRange?.startOffset;
        if (!offsetNode || offset === undefined || !textElement.contains(offsetNode)) {
            return undefined;
        }

        const context = textElement.textContent ?? "";
        if (context.length === 0 || context.trim().length === 0 || /[\0\r\n]/.test(context)) {
            return undefined;
        }
        const range = document.createRange();
        range.selectNodeContents(textElement);
        try {
            range.setEnd(offsetNode, offset);
        } catch {
            return undefined;
        }
        const fullOffset = range.toString().length;
        if (fullOffset < 0 || fullOffset > context.length) {
            return undefined;
        }

        const maximumContextLength = 256;
        const initialStart = Math.max(0, fullOffset - Math.floor(maximumContextLength / 2));
        const start = Math.min(initialStart, Math.max(0, context.length - maximumContextLength));
        return {
            context: context.slice(start, start + maximumContextLength),
            offset: fullOffset - start,
        };
    }

    /** Resolves the PDF position under a pointer event. */
    function getSyncTexPointer(event: MouseEvent): SyncTexPointer | undefined {
        const viewer = pdfjsAdapter.getViewer();
        if (!viewer || isInteractivePointerTarget(event.target)) {
            return undefined;
        }

        for (const element of event.composedPath()) {
            if (!(element instanceof HTMLElement)) {
                continue;
            }
            const pageNumber = Number(element.dataset.pageNumber);
            if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > viewer.pagesCount) {
                continue;
            }
            const pageView = viewer.getPageView(pageNumber - 1);
            if (!pageView || pageView.div !== element) {
                continue;
            }
            pageView.div.setAttribute("data-vscode-context", syncTexPageContext);
            const bounds = pageView.div.getBoundingClientRect();
            const viewportX = event.clientX - bounds.left - pageView.div.clientLeft;
            const viewportY = event.clientY - bounds.top - pageView.div.clientTop;
            if (viewportX < 0
                || viewportX > pageView.div.clientWidth
                || viewportY < 0
                || viewportY > pageView.div.clientHeight) {
                continue;
            }

            const [x, pdfY] = pageView.viewport.convertToPdfPoint(
                viewportX,
                viewportY,
            );
            const viewBox = pageView.viewport.viewBox;
            if (viewBox.length < 4 || !viewBox.slice(0, 4).every(Number.isFinite)) {
                continue;
            }
            const userUnit = Number.isFinite(pageView.viewport.userUnit) && pageView.viewport.userUnit > 0
                ? pageView.viewport.userUnit
                : 1;
            const syncTexX = (x - viewBox[0]) * userUnit;
            const syncTexY = (viewBox[3] - pdfY) * userUnit;
            if (!Number.isFinite(syncTexX) || !Number.isFinite(syncTexY)) {
                continue;
            }

            const textHint = getSyncTexTextHint(event, pageView);
            return textHint
                ? { pageNumber: pageView.id, x: syncTexX, y: syncTexY, ...textHint }
                : { pageNumber: pageView.id, x: syncTexX, y: syncTexY };
        }
        return undefined;
    }

    /** Sends the PDF position for the configured inverse SyncTeX trigger. */
    function handleSyncTexPointer(event: MouseEvent, trigger: "doubleClick" | "rightClick"): void {
        if (event.button !== (trigger === "doubleClick" ? 0 : 2)) {
            return;
        }
        const point = getSyncTexPointer(event);
        if (point) {
            post({ type: "synctex.inverse", ...point, trigger });
        }
    }

    function configureSyncTexMode(mode: "off" | "doubleclick" | "rightclick"): void {
        syncTexMode = mode;
        post({ type: "synctex.inverseClear" });
    }

    function handleSyncTexDoubleClick(event: MouseEvent): void {
        if (syncTexMode !== "doubleclick") {
            return;
        }
        handleSyncTexPointer(event, "doubleClick");
    }

    function handleSyncTexContextMenu(event: MouseEvent): void {
        post({ type: "synctex.inverseClear" });
        if (syncTexMode !== "rightclick") {
            return;
        }
        handleSyncTexPointer(event, "rightClick");
    }

    function consumeMouseNavigation(event: MouseEvent): void {
        if (mouseNavigationEnabled && mouseNavigationDirection(event)) {
            consumeMouseEvent(event);
        }
    }

    function mouseNavigationDirection(event: MouseEvent): NavigationDirection | undefined {
        if (event.button === 3) {
            return mouseButtonMapping === "standard" ? "back" : "forward";
        }
        if (event.button === 4) {
            return mouseButtonMapping === "standard" ? "forward" : "back";
        }
        return undefined;
    }

    function consumeMouseEvent(event: MouseEvent): void {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function consumeShortcut(event: KeyboardEvent): void {
        event.preventDefault();
        event.stopImmediatePropagation();
    }

    function isEditableKeyboardTarget(target: EventTarget | null): boolean {
        return target instanceof HTMLElement
            && (target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || target instanceof HTMLSelectElement
                || target.isContentEditable);
    }

    function handleKeyDown(event: KeyboardEvent): void {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }
        const direction = event.key === "ArrowLeft" ? "back" : event.key === "ArrowRight" ? "forward" : undefined;
        if (!direction) {
            return;
        }
        event.preventDefault();
        if (!event.repeat && !pressedNavigationKeys[direction]) {
            pressedNavigationKeys[direction] = true;
            history?.go(direction, captureLocation());
        }
    }

    function handleKeyUp(event: KeyboardEvent): void {
        if (event.key === "ArrowLeft") {
            releaseNavigationKey("back");
        } else if (event.key === "ArrowRight") {
            releaseNavigationKey("forward");
        } else if (event.key === "Alt") {
            releaseNavigationKey("back");
            releaseNavigationKey("forward");
        }
    }

    function releaseNavigationKey(direction: NavigationDirection): void {
        if (!pressedNavigationKeys[direction]) {
            return;
        }
        pressedNavigationKeys[direction] = false;
        post({
            type: "navigation.keyUp",
            direction
        });
    }

    function handleWheel(event: WheelEvent): void {
        if (event.target instanceof Element
            && event.target.closest(".academic-citation-popup.is-open")) {
            return;
        }
        const app = pdfjsAdapter.getApplication();
        const viewer = app && app.pdfViewer;
        if (!viewer || viewer.isInPresentationMode) {
            return;
        }

        const isZoomWheel =
            event.ctrlKey && app.supportsMouseWheelZoomCtrlKey
            || event.metaKey && app.supportsMouseWheelZoomMetaKey;
        if (!isZoomWheel) {
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();
        window.dispatchEvent(new CustomEvent("academic-pdf-wheel-zoom"));

        if (document.visibilityState === "hidden") {
            return;
        }

        pendingWheelZoomDelta += getWheelZoomDelta(event);
        pendingWheelZoomPoint = {
            clientX: event.clientX,
            clientY: event.clientY
        };

        if (pendingWheelZoomAnimationFrame === null) {
            pendingWheelZoomAnimationFrame = requestAnimationFrame(applyPendingWheelZoom);
        }
    }

    function getWheelZoomDelta(event: WheelEvent): number {
        const delta = normalizeWheelEventDirection(event);
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE || event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
            return Math.abs(delta) >= 1
                ? Math.sign(delta)
                : delta;
        }

        const pixelsPerLineScale = 30;
        return delta / pixelsPerLineScale;
    }

    function normalizeWheelEventDirection(event: WheelEvent): number {
        let delta = Math.hypot(event.deltaX, event.deltaY);
        const angle = Math.atan2(event.deltaY, event.deltaX);
        if (-0.25 * Math.PI < angle && angle < 0.75 * Math.PI) {
            delta = -delta;
        }
        return delta;
    }

    function applyPendingWheelZoom(): void {
        pendingWheelZoomAnimationFrame = null;
        const delta = pendingWheelZoomDelta;
        const point = pendingWheelZoomPoint;
        pendingWheelZoomDelta = 0;
        pendingWheelZoomPoint = null;

        if (!point || Math.abs(delta) < 0.001) {
            return;
        }

        const viewer = pdfjsAdapter.getViewer();
        if (!viewer || viewer.isInPresentationMode || document.visibilityState === "hidden") {
            return;
        }

        const previousScale = viewer.currentScale;
        const nextScale = roundScale(clamp(previousScale * Math.pow(wheelZoomBase, delta), minScale, maxScale));
        if (Math.abs(nextScale - previousScale) < 0.0001) {
            return;
        }

        viewer.currentScaleValue = String(nextScale);
        preserveZoomCenter(viewer, point, previousScale, viewer.currentScale);
    }

    function roundScale(scale: number): number {
        return Math.round(scale * 10000) / 10000;
    }

    function clamp(value: number, min: number, max: number): number {
        return Math.min(Math.max(value, min), max);
    }

    function preserveZoomCenter(viewer: PdfJsViewer, point: WheelZoomPoint, previousScale: number, currentScale: number): void {
        const container = viewer.container;
        if (!container || !previousScale) {
            return;
        }
        const scaleCorrectionFactor = currentScale / previousScale - 1;
        const rect = container.getBoundingClientRect();
        const dx = point.clientX - rect.left;
        const dy = point.clientY - rect.top;
        container.scrollLeft += dx * scaleCorrectionFactor;
        container.scrollTop += dy * scaleCorrectionFactor;
    }

    let history: NavigationHistory | null = null;
    let restoring = false;

    async function initialize(app: PdfJsApplication): Promise<void> {
        await app.initializedPromise;
        history = new NavigationHistory(restoreLocation);
        patchExplicitNavigation(app);
        setSyncTexPageContexts();

        app.eventBus.on("pagesinit", setSyncTexPageContexts);

        app.eventBus.on("documentloaded", () => {
            history?.reset();
            patchExplicitNavigation(app);
        });

        subscribe(handleNavigationMessage);
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("keyup", handleKeyUp, true);
        window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    }

    let initializationStarted = false;
    function startInitialization(): void {
        const app = pdfjsAdapter.getApplication();
        if (initializationStarted || !app) {
            return;
        }
        initializationStarted = true;
        void initialize(app).catch(error => {
            console.error("Failed to initialize Academic PDF navigation layer.", error);
        });
    }

    startInitialization();
    document.addEventListener("webviewerloaded", startInitialization, { once: true });
    window.addEventListener("load", startInitialization, { once: true });
}());
