/// <reference path="./globals.d.ts" />

"use strict";

(function () {
    interface PrivatePdfJsDocument extends PdfJsDocument {
        _pdfInfo?: {
            fingerprints: string[];
        };
    }

    interface PrivatePdfJsViewer extends PdfJsViewer {
        _location?: {
            left?: number;
            top?: number;
        };
        _setCurrentPageNumber?(pageNumber: number, resetCurrentPageView: boolean): unknown;
    }

    const patchedPageViewers = new WeakSet<PdfJsViewer>();

    const adapter: AcademicPdfJsAdapter = {
        getApplication(): PdfJsApplication | null {
            return window.PDFViewerApplication ?? null;
        },

        getViewer(): PdfJsViewer | null {
            return window.PDFViewerApplication?.pdfViewer ?? null;
        },

        getViewerContainer(viewer = adapter.getViewer()): HTMLElement | null {
            return viewer?.container ?? document.getElementById("viewerContainer");
        },

        getToolbarHost(): HTMLElement | null {
            return document.getElementById("toolbarViewerLeft");
        },

        getPageViews(viewer: PdfJsViewer): PdfJsPageView[] {
            const pages: PdfJsPageView[] = [];
            for (let index = 0; index < viewer.pagesCount; index++) {
                const page = viewer.getPageView(index);
                if (page) {
                    pages.push(page);
                }
            }
            return pages;
        },

        getPdfLocation(viewer: PdfJsViewer): PdfJsLocation {
            const location = (viewer as PrivatePdfJsViewer)._location;
            return {
                left: typeof location?.left === "number" ? location.left : null,
                top: typeof location?.top === "number" ? location.top : null
            };
        },

        setDocumentFingerprint(document: PdfJsDocument, fingerprint: string): boolean {
            const info = (document as PrivatePdfJsDocument)._pdfInfo;
            if (!info) {
                return false;
            }
            info.fingerprints = [fingerprint];
            return true;
        },

        interceptPageNumberChanges(
            viewer: PdfJsViewer,
            beforeChange: (pageNumber: number, resetCurrentPageView: boolean) => void
        ): boolean {
            if (patchedPageViewers.has(viewer)) {
                return true;
            }
            const privateViewer = viewer as PrivatePdfJsViewer;
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
