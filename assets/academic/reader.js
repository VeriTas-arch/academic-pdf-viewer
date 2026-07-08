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

  class NavigationHistory {
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
      this._onNavigate(this._backStack.pop());
    }

    forward(currentLocation) {
      if (this._forwardStack.length === 0) {
        return;
      }
      if (currentLocation && !locationsEqual(this._backStack[this._backStack.length - 1], currentLocation)) {
        this._backStack.push(currentLocation);
      }
      this._onNavigate(this._forwardStack.pop());
    }
  }

  function normalizeLocation(location) {
    if (!location) {
      return null;
    }
    return {
      pageNumber: location.pageNumber,
      scrollTop: Math.round(location.scrollTop),
      scrollLeft: Math.round(location.scrollLeft),
      scale: Math.round(location.scale * 10000) / 10000,
      pdfLeft: Number.isFinite(location.pdfLeft) ? Math.round(location.pdfLeft) : null,
      pdfTop: Number.isFinite(location.pdfTop) ? Math.round(location.pdfTop) : null
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
    if (canRestoreWithPdfDestination(location, viewer)) {
      viewer.scrollPageIntoView({
        pageNumber: location.pageNumber,
        destArray: [
          null,
          { name: "XYZ" },
          location.pdfLeft,
          location.pdfTop,
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
    return Number.isFinite(location.pageNumber)
      && Number.isFinite(location.pdfLeft)
      && Number.isFinite(location.pdfTop)
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

  function handleNavigationMessage(data, allowPressedKey) {
    if (!history) {
      return;
    }
    if (data && data.type === "navigation.back") {
      if (!allowPressedKey && pressedNavigationKeys.back) {
        return;
      }
      history.back(captureLocation());
    } else if (data && data.type === "navigation.forward") {
      if (!allowPressedKey && pressedNavigationKeys.forward) {
        return;
      }
      history.forward(captureLocation());
    }
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
    } else if (event.key === "ArrowRight") {
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
    } else if (event.key === "ArrowRight") {
      releaseNavigationKey("forward");
    } else if (event.key === "Alt") {
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
      history.reset();
      patchExplicitNavigation(app);
    });

    window.addEventListener("message", event => handleNavigationMessage(event.data));
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
  }

  initialize().catch(error => {
    console.error("Failed to initialize Academic PDF navigation layer.", error);
  });
}());
