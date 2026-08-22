/// <reference path="./globals.d.ts" />
"use strict";
(function () {
    const sidebarViews = {
        pages: 1,
        outline: 2,
        attachments: 3,
        layers: 4
    };
    function getViewsManager() {
        const manager = window.PDFViewerApplication?.viewsManager;
        return manager && typeof manager.switchView === "function" ? manager : null;
    }
    function getSidebarView(value) {
        for (const [view, id] of Object.entries(sidebarViews)) {
            if (id === value) {
                return view;
            }
        }
        return null;
    }
    function selectSidebarView(manager, view) {
        const selectedView = sidebarViews[view];
        manager.switchView(selectedView, false);
        if (manager.active === selectedView) {
            return true;
        }
        manager.switchView(sidebarViews.pages, false);
        return false;
    }
    const patchedPageViewers = new WeakSet();
    const adapter = {
        getApplication() {
            return window.PDFViewerApplication ?? null;
        },
        getViewer() {
            return window.PDFViewerApplication?.pdfViewer ?? null;
        },
        getViewerContainer(viewer = adapter.getViewer()) {
            return viewer?.container ?? document.getElementById("viewerContainer");
        },
        getToolbarHost() {
            return document.getElementById("toolbarViewerLeft");
        },
        getPageViews(viewer) {
            const pages = [];
            for (let index = 0; index < viewer.pagesCount; index++) {
                const page = viewer.getPageView(index);
                if (page) {
                    pages.push(page);
                }
            }
            return pages;
        },
        getCapabilities(document = adapter.getApplication()?.pdfDocument ?? null, viewer = adapter.getViewer()) {
            const privateDocument = document;
            const privateViewer = viewer;
            return {
                viewer: viewer !== null,
                viewerContainer: adapter.getViewerContainer(viewer) !== null,
                toolbarHost: adapter.getToolbarHost() !== null,
                location: privateViewer?._location !== undefined,
                fingerprintOverride: privateDocument?._pdfInfo !== undefined,
                pageNumberInterception: typeof privateViewer?._setCurrentPageNumber === "function",
                sidebarView: getViewsManager() !== null
            };
        },
        getPdfLocation(viewer) {
            const location = viewer._location;
            return {
                left: typeof location?.left === "number" ? location.left : null,
                top: typeof location?.top === "number" ? location.top : null
            };
        },
        setDocumentFingerprint(document, fingerprint) {
            const info = document._pdfInfo;
            if (!info) {
                return false;
            }
            info.fingerprints = [fingerprint];
            return true;
        },
        getSidebarState() {
            const manager = getViewsManager();
            const view = manager && getSidebarView(manager.active);
            return manager && view ? { view, isOpen: manager.isOpen } : null;
        },
        setSidebarView(view) {
            const manager = getViewsManager();
            if (!manager) {
                return false;
            }
            return selectSidebarView(manager, view);
        },
        restoreSidebarState(state) {
            const manager = getViewsManager();
            if (!manager) {
                return false;
            }
            const selected = selectSidebarView(manager, state.view);
            if (state.isOpen) {
                manager.switchView(manager.active, true);
            }
            else if (manager.isOpen) {
                manager.close();
            }
            return selected;
        },
        interceptPageNumberChanges(viewer, beforeChange) {
            if (patchedPageViewers.has(viewer)) {
                return true;
            }
            const privateViewer = viewer;
            const setCurrentPageNumber = privateViewer._setCurrentPageNumber;
            if (typeof setCurrentPageNumber !== "function") {
                return false;
            }
            privateViewer._setCurrentPageNumber = function (pageNumber, resetCurrentPageView) {
                beforeChange(pageNumber, resetCurrentPageView);
                return setCurrentPageNumber.call(this, pageNumber, resetCurrentPageView);
            };
            patchedPageViewers.add(viewer);
            return true;
        }
    };
    window.academicPdfJsAdapter = adapter;
}());
