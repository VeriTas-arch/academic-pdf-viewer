/// <reference path="./globals.d.ts" />
"use strict";
(function () {
    const vscode = acquireVsCodeApi();
    const pdfjsAdapter = window.academicPdfJsAdapter;
    const initialMouseNavigation = readMouseNavigationConfig();
    let mouseNavigationEnabled = initialMouseNavigation.enabled;
    let mouseButtonMapping = initialMouseNavigation.mapping;
    window.addEventListener("academic-pdf-viewer-ready", () => {
        vscode.postMessage({ type: "webview.ready" });
    }, { once: true });
    window.addEventListener("academic-pdf-debug", event => {
        vscode.postMessage(event.detail);
    });
    window.addEventListener("academic-pdf-message", event => {
        vscode.postMessage(event.detail);
    });
    window.addEventListener("keydown", handleViewerShortcutBoundary, true);
    window.addEventListener("mousedown", handleMouseNavigation, true);
    configureSyncTexMode(readSyncTexConfig());
    window.addEventListener("academic-pdf-synctex-configure", event => {
        const mode = event.detail;
        if (mode === "off" || mode === "doubleclick" || mode === "rightclick") {
            configureSyncTexMode(mode);
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
    let pendingWheelZoomPoint = null;
    let pendingWheelZoomAnimationFrame = null;
    const patchedLinkServices = new WeakSet();
    class NavigationHistory {
        _onNavigate;
        _backStack;
        _forwardStack;
        constructor(onNavigate) {
            this._onNavigate = onNavigate;
            this._backStack = [];
            this._forwardStack = [];
        }
        reset() {
            this._backStack = [];
            this._forwardStack = [];
        }
        pushDeparture(location) {
            if (!location || locationsEqual(this._backStack[this._backStack.length - 1], location)) {
                return;
            }
            this._backStack.push(location);
            this._forwardStack = [];
        }
        back(currentLocation) {
            if (this._backStack.length === 0) {
                return;
            }
            if (currentLocation && !locationsEqual(this._forwardStack[this._forwardStack.length - 1], currentLocation)) {
                this._forwardStack.push(currentLocation);
            }
            const destination = this._backStack.pop();
            if (destination) {
                this._onNavigate(destination);
            }
        }
        forward(currentLocation) {
            if (this._forwardStack.length === 0) {
                return;
            }
            if (currentLocation && !locationsEqual(this._backStack[this._backStack.length - 1], currentLocation)) {
                this._backStack.push(currentLocation);
            }
            const destination = this._forwardStack.pop();
            if (destination) {
                this._onNavigate(destination);
            }
        }
    }
    function normalizeLocation(location) {
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
    function locationsEqual(a, b) {
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
    function getViewer() {
        return pdfjsAdapter.getViewer();
    }
    function getContainer() {
        return pdfjsAdapter.getViewerContainer();
    }
    function captureLocation() {
        const viewer = getViewer();
        const container = getContainer();
        if (!viewer || !container) {
            return null;
        }
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
    function restoreLocation(location) {
        const viewer = getViewer();
        const container = getContainer();
        if (!viewer || !container || !location) {
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
            finishRestore(location);
            return;
        }
        viewer.currentScaleValue = String(location.scale);
        if (app && app.pdfLinkService) {
            app.pdfLinkService.goToPage(location.pageNumber);
        }
        finishRestore(location);
    }
    function canRestoreWithPdfDestination(location, viewer) {
        const hasPdfPosition = typeof location.pdfLeft === "number"
            && Number.isFinite(location.pdfLeft)
            && typeof location.pdfTop === "number"
            && Number.isFinite(location.pdfTop);
        return Number.isFinite(location.pageNumber)
            && hasPdfPosition
            && Number.isFinite(location.scale)
            && typeof viewer.scrollPageIntoView === "function";
    }
    function finishRestore(location) {
        const container = getContainer();
        if (!container) {
            restoring = false;
            return;
        }
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                container.scrollTop = location.scrollTop;
                container.scrollLeft = location.scrollLeft;
                restoring = false;
            });
        });
    }
    function recordDeparture() {
        if (restoring || !history) {
            return;
        }
        history.pushDeparture(captureLocation());
    }
    function patchExplicitNavigation(app) {
        const linkService = app.pdfLinkService;
        if (linkService && !patchedLinkServices.has(linkService)) {
            const goToDestination = linkService.goToDestination.bind(linkService);
            linkService.goToDestination = function (...args) {
                recordDeparture();
                return goToDestination(...args);
            };
            const goToPage = linkService.goToPage.bind(linkService);
            linkService.goToPage = function (...args) {
                recordDeparture();
                return goToPage(...args);
            };
            const setHash = linkService.setHash.bind(linkService);
            linkService.setHash = function (...args) {
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
    function handleNavigationMessage(data, allowPressedKey = false) {
        if (!isNavigationMessage(data)) {
            return;
        }
        if (data.type === "navigation.configure") {
            mouseNavigationEnabled = data.mouseButtonsEnabled;
            mouseButtonMapping = data.mouseButtonMapping;
        }
        else if (!history) {
            return;
        }
        else if (data.type === "navigation.back") {
            if (!allowPressedKey && pressedNavigationKeys.back) {
                return;
            }
            history.back(captureLocation());
        }
        else if (data.type === "navigation.forward") {
            if (!allowPressedKey && pressedNavigationKeys.forward) {
                return;
            }
            history.forward(captureLocation());
        }
    }
    function isNavigationMessage(data) {
        return typeof data === "object"
            && data !== null
            && "type" in data
            && (data.type === "navigation.back"
                || data.type === "navigation.forward"
                || (data.type === "navigation.configure"
                    && "mouseButtonsEnabled" in data
                    && typeof data.mouseButtonsEnabled === "boolean"
                    && "mouseButtonMapping" in data
                    && (data.mouseButtonMapping === "standard"
                        || data.mouseButtonMapping === "swapped")));
    }
    function handleViewerShortcutBoundary(event) {
        const key = event.key.toLowerCase();
        const primaryModifier = event.ctrlKey || event.metaKey;
        if (primaryModifier && !event.altKey && key === "p") {
            if (!event.repeat) {
                vscode.postMessage({
                    type: event.shiftKey ? "workbench.showCommands" : "workbench.quickOpen"
                });
            }
            consumeShortcut(event);
            return;
        }
        if (primaryModifier && !event.altKey && !event.shiftKey && key === "o") {
            if (!event.repeat) {
                vscode.postMessage({ type: "workbench.openFile" });
            }
            consumeShortcut(event);
            return;
        }
        if (!primaryModifier && !event.altKey && key === "r" && !isEditableKeyboardTarget(event.target)) {
            consumeShortcut(event);
        }
    }
    function handleMouseNavigation(event) {
        if (!mouseNavigationEnabled) {
            return;
        }
        const direction = mouseNavigationDirection(event);
        if (!direction) {
            return;
        }
        consumeMouseEvent(event);
        vscode.postMessage({ type: "navigation.request", direction });
    }
    /** Resolves the PDF position under a pointer event. */
    function getSyncTexPointer(event) {
        const viewer = getViewer();
        if (!viewer) {
            return undefined;
        }
        for (const pageView of pdfjsAdapter.getPageViews(viewer)) {
            const bounds = pageView.div.getBoundingClientRect();
            if (event.clientX < bounds.left
                || event.clientX > bounds.right
                || event.clientY < bounds.top
                || event.clientY > bounds.bottom) {
                continue;
            }
            const [x, pdfY] = pageView.viewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top);
            const pageHeight = pageView.viewport.viewBox[3];
            const y = pageHeight - pdfY;
            if (!Number.isFinite(x) || !Number.isFinite(y)) {
                continue;
            }
            return { pageNumber: pageView.id, x, y };
        }
        return undefined;
    }
    /** Sends the PDF position for the configured inverse SyncTeX trigger. */
    function handleSyncTexPointer(event, trigger) {
        if (event.button !== (trigger === "doubleClick" ? 0 : 2)) {
            return;
        }
        const point = getSyncTexPointer(event);
        if (point) {
            vscode.postMessage({ type: "synctex.inverse", ...point, trigger });
        }
    }
    function configureSyncTexMode(mode) {
        window.removeEventListener("dblclick", handleSyncTexDoubleClick, true);
        window.removeEventListener("contextmenu", handleSyncTexRightClick, true);
        if (mode === "doubleclick") {
            window.addEventListener("dblclick", handleSyncTexDoubleClick, true);
        }
        else if (mode === "rightclick") {
            window.addEventListener("contextmenu", handleSyncTexRightClick, true);
        }
    }
    function handleSyncTexDoubleClick(event) {
        handleSyncTexPointer(event, "doubleClick");
    }
    function handleSyncTexRightClick(event) {
        handleSyncTexPointer(event, "rightClick");
    }
    function readSyncTexConfig() {
        const value = document.getElementById("pdf-preview-config")?.getAttribute("data-config");
        try {
            const settings = JSON.parse(value || "{}");
            return settings.syncTexMode === "off" || settings.syncTexMode === "rightclick"
                ? settings.syncTexMode
                : "doubleclick";
        }
        catch {
            return "doubleclick";
        }
    }
    function consumeMouseNavigation(event) {
        if (mouseNavigationEnabled && mouseNavigationDirection(event)) {
            consumeMouseEvent(event);
        }
    }
    function readMouseNavigationConfig() {
        const value = document.getElementById("pdf-preview-config")?.getAttribute("data-config");
        if (!value) {
            return { enabled: true, mapping: "standard" };
        }
        try {
            const settings = JSON.parse(value);
            return {
                enabled: settings.mouseNavigationEnabled !== false,
                mapping: settings.mouseButtonMapping === "swapped" ? "swapped" : "standard"
            };
        }
        catch {
            return { enabled: true, mapping: "standard" };
        }
    }
    function mouseNavigationDirection(event) {
        if (event.button === 3) {
            return mouseButtonMapping === "standard" ? "back" : "forward";
        }
        if (event.button === 4) {
            return mouseButtonMapping === "standard" ? "forward" : "back";
        }
        return undefined;
    }
    function consumeMouseEvent(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    function consumeShortcut(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    function isEditableKeyboardTarget(target) {
        return target instanceof HTMLElement
            && (target instanceof HTMLInputElement
                || target instanceof HTMLTextAreaElement
                || target instanceof HTMLSelectElement
                || target.isContentEditable);
    }
    function handleKeyDown(event) {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
            return;
        }
        if (event.key === "ArrowLeft") {
            event.preventDefault();
            if (event.repeat || pressedNavigationKeys.back) {
                return;
            }
            pressedNavigationKeys.back = true;
            handleNavigationMessage({ type: "navigation.back" }, true);
        }
        else if (event.key === "ArrowRight") {
            event.preventDefault();
            if (event.repeat || pressedNavigationKeys.forward) {
                return;
            }
            pressedNavigationKeys.forward = true;
            handleNavigationMessage({ type: "navigation.forward" }, true);
        }
    }
    function handleKeyUp(event) {
        if (event.key === "ArrowLeft") {
            releaseNavigationKey("back");
        }
        else if (event.key === "ArrowRight") {
            releaseNavigationKey("forward");
        }
        else if (event.key === "Alt") {
            releaseNavigationKey("back");
            releaseNavigationKey("forward");
        }
    }
    function releaseNavigationKey(direction) {
        if (!pressedNavigationKeys[direction]) {
            return;
        }
        pressedNavigationKeys[direction] = false;
        vscode.postMessage({
            type: "navigation.keyUp",
            direction
        });
    }
    function handleWheel(event) {
        if (event.target instanceof Element
            && event.target.closest(".academic-citation-popup.is-open")) {
            return;
        }
        const app = pdfjsAdapter.getApplication();
        const viewer = app && app.pdfViewer;
        if (!viewer || viewer.isInPresentationMode) {
            return;
        }
        const isZoomWheel = event.ctrlKey && app.supportsMouseWheelZoomCtrlKey
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
    function getWheelZoomDelta(event) {
        const delta = normalizeWheelEventDirection(event);
        if (event.deltaMode === WheelEvent.DOM_DELTA_LINE || event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
            return Math.abs(delta) >= 1
                ? Math.sign(delta)
                : delta;
        }
        const pixelsPerLineScale = 30;
        return delta / pixelsPerLineScale;
    }
    function normalizeWheelEventDirection(event) {
        let delta = Math.hypot(event.deltaX, event.deltaY);
        const angle = Math.atan2(event.deltaY, event.deltaX);
        if (-0.25 * Math.PI < angle && angle < 0.75 * Math.PI) {
            delta = -delta;
        }
        return delta;
    }
    function applyPendingWheelZoom() {
        pendingWheelZoomAnimationFrame = null;
        const delta = pendingWheelZoomDelta;
        const point = pendingWheelZoomPoint;
        pendingWheelZoomDelta = 0;
        pendingWheelZoomPoint = null;
        if (!point || Math.abs(delta) < 0.001) {
            return;
        }
        const viewer = getViewer();
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
    function roundScale(scale) {
        return Math.round(scale * 10000) / 10000;
    }
    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }
    function preserveZoomCenter(viewer, point, previousScale, currentScale) {
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
    let history = null;
    let restoring = false;
    async function initialize() {
        const app = pdfjsAdapter.getApplication();
        if (!app) {
            return;
        }
        await app.initializedPromise;
        history = new NavigationHistory(restoreLocation);
        patchExplicitNavigation(app);
        app.eventBus.on("documentloaded", () => {
            if (history) {
                history.reset();
            }
            patchExplicitNavigation(app);
        });
        window.addEventListener("message", event => handleNavigationMessage(event.data));
        window.addEventListener("keydown", handleKeyDown, true);
        window.addEventListener("keyup", handleKeyUp, true);
        window.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    }
    let initializationStarted = false;
    function startInitialization() {
        if (initializationStarted || !pdfjsAdapter.getApplication()) {
            return;
        }
        initializationStarted = true;
        initialize().catch(error => {
            console.error("Failed to initialize Academic PDF navigation layer.", error);
        });
    }
    startInitialization();
    document.addEventListener("webviewerloaded", startInitialization, { once: true });
    window.addEventListener("load", startInitialization, { once: true });
}());
