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

    interface PrivateViewsManager {
        active: number;
        isOpen: boolean;
        close(): void;
        switchView(view: number, forceOpen?: boolean): void;
    }

    interface PrivatePdfJsApplication extends PdfJsApplication {
        viewsManager?: PrivateViewsManager;
    }

    const sidebarViews: Readonly<Record<AcademicSidebarView, number>> = {
        pages: 1,
        outline: 2,
        attachments: 3,
        layers: 4
    };

    function getViewsManager(): PrivateViewsManager | null {
        const manager = (window.PDFViewerApplication as PrivatePdfJsApplication | undefined)?.viewsManager;
        return manager && typeof manager.switchView === "function" ? manager : null;
    }

    function getSidebarView(value: number): AcademicSidebarView | null {
        for (const [view, id] of Object.entries(sidebarViews)) {
            if (id === value) {
                return view as AcademicSidebarView;
            }
        }
        return null;
    }

    function selectSidebarView(manager: PrivateViewsManager, view: AcademicSidebarView): boolean {
        const selectedView = sidebarViews[view];
        manager.switchView(selectedView, false);
        if (manager.active === selectedView) {
            return true;
        }
        manager.switchView(sidebarViews.pages, false);
        return false;
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

        getCapabilities(
            document = adapter.getApplication()?.pdfDocument ?? null,
            viewer = adapter.getViewer()
        ): AcademicPdfJsCapabilities {
            const privateDocument = document as PrivatePdfJsDocument | null;
            const privateViewer = viewer as PrivatePdfJsViewer | null;
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

        getSidebarState(): AcademicSidebarState | null {
            const manager = getViewsManager();
            const view = manager && getSidebarView(manager.active);
            return manager && view ? { view, isOpen: manager.isOpen } : null;
        },

        setSidebarView(view: AcademicSidebarView): boolean {
            const manager = getViewsManager();
            if (!manager) {
                return false;
            }
            return selectSidebarView(manager, view);
        },

        restoreSidebarState(state: AcademicSidebarState): boolean {
            const manager = getViewsManager();
            if (!manager) {
                return false;
            }
            const selected = selectSidebarView(manager, state.view);
            if (state.isOpen) {
                manager.switchView(manager.active, true);
            } else if (manager.isOpen) {
                manager.close();
            }
            return selected;
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
