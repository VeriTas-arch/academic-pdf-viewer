/// <reference path="./globals.d.ts" />
"use strict";
(function () {
    if (window.PDFViewerApplicationOptions) {
        window.PDFViewerApplicationOptions.set("disableHistory", true);
        window.PDFViewerApplicationOptions.set("useOnlyCssZoom", true);
    }
    const vscode = acquireVsCodeApi();
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
        return window.PDFViewerApplication && window.PDFViewerApplication.pdfViewer;
    }
    function getContainer() {
        const viewer = getViewer();
        return viewer && viewer.container || document.getElementById("viewerContainer");
    }
    function captureLocation() {
        const viewer = getViewer();
        const container = getContainer();
        if (!viewer || !container) {
            return null;
        }
        const pdfLocation = viewer._location;
        return normalizeLocation({
            pageNumber: viewer.currentPageNumber,
            scrollTop: container.scrollTop,
            scrollLeft: container.scrollLeft,
            scale: viewer.currentScale,
            pdfLeft: pdfLocation ? pdfLocation.left : null,
            pdfTop: pdfLocation ? pdfLocation.top : null
        });
    }
    function restoreLocation(location) {
        const viewer = getViewer();
        const container = getContainer();
        if (!viewer || !container || !location) {
            return;
        }
        restoring = true;
        const app = window.PDFViewerApplication;
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
        if (linkService && !linkService.__academicHistoryPatched) {
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
            linkService.__academicHistoryPatched = true;
        }
        const viewer = app.pdfViewer;
        if (viewer && !viewer.__academicHistoryPatched && typeof viewer._setCurrentPageNumber === "function") {
            const setCurrentPageNumber = viewer._setCurrentPageNumber.bind(viewer);
            viewer._setCurrentPageNumber = function (pageNumber, resetCurrentPageView) {
                if (resetCurrentPageView && pageNumber !== viewer.currentPageNumber) {
                    recordDeparture();
                }
                return setCurrentPageNumber(pageNumber, resetCurrentPageView);
            };
            viewer.__academicHistoryPatched = true;
        }
    }
    function handleNavigationMessage(data, allowPressedKey = false) {
        if (!history) {
            return;
        }
        if (!isNavigationMessage(data)) {
            return;
        }
        if (data.type === "navigation.back") {
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
                || data.type === "navigation.forward");
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
        const app = window.PDFViewerApplication;
        const viewer = app && app.pdfViewer;
        if (!viewer || viewer.isInPresentationMode) {
            return;
        }
        const supportedKeys = app.supportedMouseWheelZoomModifierKeys || {};
        const isZoomWheel = event.ctrlKey && supportedKeys.ctrlKey
            || event.metaKey && supportedKeys.metaKey;
        if (!isZoomWheel) {
            return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
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
        const app = window.PDFViewerApplication;
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
        window.addEventListener("academic-pdf-show-commands", () => {
            vscode.postMessage({
                type: "workbench.showCommands"
            });
        });
    }
    initialize().catch(error => {
        console.error("Failed to initialize Academic PDF navigation layer.", error);
    });
}());
