/// <reference path="./globals.d.ts" />
"use strict";
(function () {
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
