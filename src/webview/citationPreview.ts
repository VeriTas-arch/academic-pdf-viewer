/// <reference path="./globals.d.ts" />

"use strict";

import { collectNearbyLinesFromRows, type PositionedTextRow } from "./citationPreviewLines.mjs";

(function () {
    type Timer = ReturnType<typeof setTimeout> | null;
    interface ViewportRect {
        left: number;
        top: number;
        width: number;
        height: number;
    }

    interface PreviewLink {
        rect: ViewportRect;
        dest: PdfJsDestination;
    }

    type InternalLinkAnnotation = PdfJsAnnotation & {
        dest: PdfJsDestination;
        rect: number[];
    };

    interface HoveredPreview {
        anchor: HTMLElement;
        link: PreviewLink;
    }

    interface ResolvedDestination {
        pageNumber: number;
        pdfX: number | null;
        pdfY: number | null;
    }

    interface ImagePreview {
        src: string;
        canvas?: HTMLCanvasElement;
        sizeBytes?: number;
        pixelWidth?: number;
        pixelHeight?: number;
        maxPixelWidth?: number;
        targetXRatio: number;
        targetYRatio: number;
    }

    interface PendingPreviewEncoding {
        image: ImagePreview;
        task: Promise<ImagePreview | null>;
    }

    interface TextBounds {
        left: number;
        right: number;
    }

    interface PreviewCrop {
        left: number;
        top: number;
        width: number;
        height: number;
    }

    interface PopupPlacement {
        left: number;
        top: number;
    }

    interface LinkPreviewConfiguration {
        debug: boolean;
        enabled: boolean;
        resolutionScale: number;
    }

    const OPEN_DELAY_MS = 200;
    const TEXT_RADIUS_PX = 90;
    const DEFAULT_RESOLUTION_SCALE = 0;
    const MIN_RESOLUTION_SCALE = 1;
    const MAX_RESOLUTION_SCALE = 4;
    const MAX_PREVIEW_PIXELS = 25600000;
    const MAX_PREVIEW_DIMENSION = 16384;
    const MAX_PREVIEW_DISPLAY_WIDTH = 760;
    const PREVIEW_VIEWPORT_MARGIN = 16;
    const PREVIEW_MARGIN_FALLBACK_RATIO = 0.08;
    const TEXT_BOUND_PADDING_PX = 28;
    const PREVIEW_TARGET_RADIUS = 10;
    const HIT_PADDING_PX = 2;
    const MIN_HIT_HEIGHT_PX = 10;
    const SCALE_RENDER_DEBOUNCE_MS = 140;
    const MAX_PREVIEW_CACHE_ENTRIES = 16;
    const MAX_PREVIEW_CACHE_BYTES = 128 * 1024 * 1024;
    const MAX_PENDING_PREVIEW_ENCODINGS = 1;
    const MAX_DOCUMENT_CACHE_ENTRIES = 64;
    const WHEEL_ZOOM_SUPPRESS_HOVER_MS = 260;
    const CLOSE_DELAY_MS = 180;
    const pdfjsAdapter = window.academicPdfJsAdapter;

    class HoverDelayer {
        _openTimer: Timer;

        constructor() {
            this._openTimer = null;
        }

        open(callback: () => void): void {
            this.cancelOpen();
            this._openTimer = setTimeout(() => {
                this._openTimer = null;
                callback();
            }, OPEN_DELAY_MS);
        }

        cancelOpen(): void {
            if (!this._openTimer) {
                return;
            }
            clearTimeout(this._openTimer);
            this._openTimer = null;
        }

    }

    class CitationPreviewController {
        _app: PdfJsApplication;
        _eventBus: PdfJsEventBus;
        _pdfDocument: PdfJsDocument | null = null;
        _pendingPointerMoveFrame: number | null = null;
        _hoverDelayer: HoverDelayer = new HoverDelayer();
        _previewCache: Map<string, ImagePreview> = new Map();
        _previewCacheBytes: number = 0;
        _pendingPreviewEncodings: Map<string, PendingPreviewEncoding> = new Map();
        _textCache: Map<string, string> = new Map();
        _pageCache: Map<number, Promise<PdfJsPage>> = new Map();
        _annotationCache: Map<number, Promise<PdfJsAnnotation[]>> = new Map();
        _textContentCache: Map<number, Promise<PdfJsTextContent>> = new Map();
        _pageRenderIds: Map<number, number> = new Map();
        _documentGeneration: number = 0;
        _overlayLinks: WeakMap<HTMLElement, PreviewLink> = new WeakMap();
        _pageOverlays: Map<HTMLElement, Set<HTMLElement>> = new Map();
        _pageLayers: Set<HTMLElement> = new Set();
        _previewRequestId: number = 0;
        _popup: HTMLDivElement;
        _scaleRenderTimer: Timer = null;
        _suppressedOpenTimer: Timer = null;
        _closeTimer: Timer = null;
        _suppressHoverUntil: number = 0;
        _activeRenderTask: PdfJsRenderTask | null = null;
        _debug: boolean;
        _enabled: boolean;
        _resolutionScale: number;
        _controlPressed: boolean = false;
        _hoveredPreview: HoveredPreview | null = null;
        _pointerPosition: { x: number; y: number } | null = null;
        _displayedImage: ImagePreview | null = null;
        _previewGeneration = 0;
        _refreshTimer: Timer = null;
        _displayWidth = 0;
        _displayDensity = 0;

        constructor(app: PdfJsApplication) {
            const initialConfiguration = readInitialConfiguration();
            this._app = app;
            this._eventBus = app.eventBus;
            this._popup = this._createPopup();
            this._debug = initialConfiguration.debug;
            this._enabled = initialConfiguration.enabled;
            this._resolutionScale = initialConfiguration.resolutionScale;
        }

        initialize(): void {
            const refresh = () => this._schedulePreviewRefresh();
            const observer = new ResizeObserver(refresh);
            observer.observe(this._popup);
            window.addEventListener("resize", refresh);
            let media: MediaQueryList;
            const watchDensity = () => {
                media?.removeEventListener("change", watchDensity);
                media = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
                media.addEventListener("change", watchDensity);
                refresh();
            };
            watchDensity();
            window.addEventListener("pagehide", () => {
                observer.disconnect();
                media.removeEventListener("change", watchDensity);
                window.removeEventListener("resize", refresh);
                this._hidePopup();
                this._clearPreviewCache();
            }, { once: true });
            this._eventBus.on("documentloaded", () => {
                this._documentGeneration += 1;
                this._pdfDocument = this._app.pdfDocument;
                this._hidePopup();
                this._clearPreviewCache();
                this._textCache.clear();
                this._pageCache.clear();
                this._annotationCache.clear();
                this._textContentCache.clear();
                this._pageRenderIds.clear();
                this._cancelScheduledScaleRender();
                this._hoveredPreview = null;
                this._clearAllOverlays();
                if (this._enabled) {
                    this._renderVisiblePages();
                }
            });

            this._eventBus.on("pagerendered", (event: { pageNumber: number; cssTransform?: boolean }) => {
                if (!this._enabled) {
                    return;
                }
                if (event.cssTransform) {
                    this._scheduleScaleRender();
                    return;
                }
                this._renderPage(event.pageNumber);
            });

            this._eventBus.on("scalechanged", () => {
                this._hidePopup();
                if (this._enabled) {
                    this._scheduleScaleRender();
                }
            });

            window.addEventListener("academic-pdf-wheel-zoom", () => {
                this._suppressHoverUntil = performance.now() + WHEEL_ZOOM_SUPPRESS_HOVER_MS;
                this._hidePopup();
                this._openHoveredPreview(true);
            });

            window.addEventListener("message", event => {
                if (window.academicExtensionMessages.isMessage(event.data)
                    && event.data.type === "linkPreview.configure") {
                    const message = event.data;
                    this._configure(message.enabled, message.resolutionScale);
                }
            });
            window.addEventListener("keydown", event => {
                if (event.key !== "Control" || event.repeat) {
                    return;
                }
                this._controlPressed = true;
                this._syncHoveredPreviewAtPointer();
                this._openHoveredPreview(true);
            }, true);
            window.addEventListener("keyup", event => {
                if (event.key === "Control") {
                    this._releaseControl();
                }
            }, true);
            window.addEventListener("blur", () => this._releaseControl());
            window.addEventListener("pointermove", event => {
                this._pointerPosition = { x: event.clientX, y: event.clientY };
                this._controlPressed ||= event.ctrlKey;
                if (!this._controlPressed) {
                    return;
                }
                if (this._pendingPointerMoveFrame !== null) {
                    return;
                }
                this._pendingPointerMoveFrame = requestAnimationFrame(() => {
                    this._pendingPointerMoveFrame = null;
                    if (this._syncHoveredPreviewAtPointer() && this._controlPressed) {
                        this._openHoveredPreview();
                    }
                });
            }, { capture: true, passive: true });
            window.addEventListener("pointerout", event => {
                if (event.relatedTarget === null) {
                    this._pointerPosition = null;
                    this._cancelClose();
                    this._setHoveredPreview(null);
                    this._cancelPendingPointerMoveFrame();
                }
            }, true);
        }

        _openHoveredPreview(immediate = false): void {
            const hovered = this._hoveredPreview;
            if (!this._enabled || !this._controlPressed || !hovered?.anchor.isConnected) {
                return;
            }
            const suppressedForMs = this._suppressHoverUntil - performance.now();
            if (suppressedForMs > 0) {
                this._scheduleSuppressedOpen(hovered, suppressedForMs);
                return;
            }
            this._cancelSuppressedOpen();
            const open = () => {
                if (this._controlPressed && this._hoveredPreview === hovered) {
                    this._showPopup(hovered.anchor, hovered.link);
                }
            };
            if (immediate) {
                this._hoverDelayer.cancelOpen();
                open();
            } else {
                this._hoverDelayer.open(open);
            }
        }

        _scheduleSuppressedOpen(hovered: HoveredPreview, delayMs: number): void {
            this._cancelSuppressedOpen();
            this._suppressedOpenTimer = setTimeout(() => {
                this._suppressedOpenTimer = null;
                if (this._hoveredPreview === hovered) {
                    this._openHoveredPreview(true);
                }
            }, Math.ceil(delayMs) + 1);
        }

        _cancelSuppressedOpen(): void {
            if (!this._suppressedOpenTimer) {
                return;
            }
            clearTimeout(this._suppressedOpenTimer);
            this._suppressedOpenTimer = null;
        }

        _releaseControl(): void {
            this._controlPressed = false;
            if (this._hoveredPreview) {
                this._setHoveredPreview(null);
            } else {
                this._hidePopup();
            }
        }

        _configure(enabled: boolean, resolutionScale: number): void {
            const normalizedScale = normalizeResolutionScale(resolutionScale);
            const enabledChanged = this._enabled !== enabled;
            const resolutionChanged = this._resolutionScale !== normalizedScale;
            if (!enabledChanged && !resolutionChanged) {
                return;
            }
            this._enabled = enabled;
            this._resolutionScale = normalizedScale;
            this._hoveredPreview = null;
            this._hidePopup();
            if (resolutionChanged) {
                this._clearPreviewCache();
            }
            if (!enabledChanged) {
                return;
            }
            this._cancelScheduledScaleRender();
            this._clearAllOverlays();
            if (enabled) {
                this._renderVisiblePages();
            }
        }

        _scheduleScaleRender(): void {
            if (this._scaleRenderTimer) {
                clearTimeout(this._scaleRenderTimer);
            }
            this._scaleRenderTimer = setTimeout(() => {
                this._scaleRenderTimer = null;
                this._renderVisiblePages();
            }, SCALE_RENDER_DEBOUNCE_MS);
        }

        _cancelScheduledScaleRender(): void {
            if (!this._scaleRenderTimer) {
                return;
            }
            clearTimeout(this._scaleRenderTimer);
            this._scaleRenderTimer = null;
        }

        async _renderVisiblePages(): Promise<void> {
            await this._app.pdfViewer.pagesPromise;
            if (!this._enabled) {
                return;
            }
            for (const pageView of pdfjsAdapter.getPageViews(this._app.pdfViewer)) {
                if (pageView && pageView.renderingState === 3) {
                    this._renderPage(pageView.id);
                }
            }
        }

        async _renderPage(pageNumber: number): Promise<void> {
            if (!this._enabled || !this._pdfDocument) {
                return;
            }
            const renderId = (this._pageRenderIds.get(pageNumber) || 0) + 1;
            const documentGeneration = this._documentGeneration;
            rememberBoundedEntry(this._pageRenderIds, pageNumber, renderId, MAX_DOCUMENT_CACHE_ENTRIES);

            const pageView = this._app.pdfViewer.getPageView(pageNumber - 1);
            if (!pageView || !pageView.div || !pageView.viewport) {
                return;
            }

            this._clearPageOverlays(pageView.div);

            let annotations: PdfJsAnnotation[];
            try {
                annotations = await this._getPageAnnotations(pageNumber);
            } catch (error) {
                if (this._documentGeneration === documentGeneration) {
                    console.warn("Failed to read PDF link annotations.", error);
                }
                return;
            }
            if (!this._enabled
                || this._documentGeneration !== documentGeneration
                || this._pageRenderIds.get(pageNumber) !== renderId) {
                return;
            }
            for (const annotation of annotations) {
                if (!isInternalLinkAnnotation(annotation)) {
                    continue;
                }
                this._appendOverlay(pageView, annotation);
            }
            this._syncHoveredPreviewAtPointer();
            this._openHoveredPreview(true);
        }

        _getPageAnnotations(pageNumber: number): Promise<PdfJsAnnotation[]> {
            return getCachedPromise(this._annotationCache, pageNumber, () => (
                this._getPage(pageNumber).then(page => page.getAnnotations({ intent: "display" }))
            ));
        }

        _appendOverlay(pageView: PdfJsPageView, annotation: InternalLinkAnnotation): void {
            const rect = viewportRect(pageView.viewport, annotation.rect);
            if (!rect || rect.width <= 0 || rect.height <= 0) {
                return;
            }
            const layer = this._ensurePageLayer(pageView.div);

            const overlay = document.createElement("button");
            overlay.type = "button";
            overlay.className = "academic-citation-link";
            overlay.style.left = `${rect.left}px`;
            overlay.style.top = `${rect.top}px`;
            overlay.style.width = `${rect.width}px`;
            overlay.style.height = `${rect.height}px`;
            overlay.setAttribute("aria-label", "PDF link. Hold Control to preview destination.");

            const link = {
                rect,
                dest: annotation.dest
            };
            this._overlayLinks.set(overlay, link);
            this._trackPageOverlay(pageView.div, overlay);
            overlay.addEventListener("click", (event: MouseEvent) => {
                event.preventDefault();
                event.stopPropagation();
                this._hidePopup();
                this._app.pdfLinkService.goToDestination(link.dest);
            });

            layer.append(overlay);
        }

    _syncHoveredPreviewAtPointer(): boolean {
        if (!this._pointerPosition) {
            this._cancelClose();
            return this._setHoveredPreview(null);
        }
        const { x, y } = this._pointerPosition;
        const elements = document.elementsFromPoint(x, y);
        if (this._popup.classList.contains("is-open")
            && elements.some(element => element === this._popup || this._popup.contains(element))) {
            this._cancelClose();
            return false;
        }
        let directAnchor: HTMLElement | null = null;
        let page: HTMLElement | null = null;
        for (const element of elements) {
            if (!directAnchor) {
                directAnchor = element.closest<HTMLElement>(".academic-citation-link");
            }
            if (!page) {
                page = element.closest<HTMLElement>(".page");
            }
            if (directAnchor && page) {
                break;
            }
        }
        const overlays = page ? this._pageOverlays.get(page) : null;
        const pageRect = page && !directAnchor ? page.getBoundingClientRect() : null;
        let anchor = directAnchor;
        if (!anchor && overlays) {
            if (!pageRect) {
                return this._setHoveredPreview(null);
            }
            for (const candidate of overlays) {
                const link = this._overlayLinks.get(candidate);
                if (!link) {
                    continue;
                }
                if (containsClientPointInPage(pageRect, link.rect, x, y)) {
                    anchor = candidate;
                    break;
                }
            }
        }
        const link = anchor && this._overlayLinks.get(anchor);
        if (anchor && link) {
            this._cancelClose();
            return this._setHoveredPreview({ anchor, link });
        }
        if (this._popup.classList.contains("is-open") && this._hoveredPreview) {
            this._scheduleClose();
            return false;
        }
        this._cancelClose();
        return this._setHoveredPreview(null);
    }

        _setHoveredPreview(hovered: HoveredPreview | null): boolean {
            if (this._hoveredPreview?.anchor === hovered?.anchor) {
                return false;
            }
            this._hoveredPreview?.anchor.classList.remove("is-pointer-over");
            if (this._hoveredPreview) {
                this._hidePopup();
            }
            this._hoveredPreview = hovered;
            hovered?.anchor.classList.add("is-pointer-over");
            return true;
        }

        _getPreviewDensity(): number {
            return this._resolutionScale || Math.max(2, window.devicePixelRatio || 1);
        }

        _schedulePreviewRefresh(): void {
            if (!this._popup.classList.contains("is-open") || !this._displayedImage) {
                return;
            }
            const width = this._getPreviewDisplayWidth();
            const density = this._getPreviewDensity();
            const requiredWidth = Math.min(Math.ceil(width * density), this._displayedImage.maxPixelWidth ?? Infinity);
            if (Math.abs(width - this._displayWidth) < 0.5 && density === this._displayDensity
                && (this._displayedImage.pixelWidth ?? 0) >= requiredWidth) {
                return;
            }
            if (this._refreshTimer) {
                clearTimeout(this._refreshTimer);
            }
            this._refreshTimer = setTimeout(() => {
                this._refreshTimer = null;
                const hovered = this._hoveredPreview;
                if (hovered && this._controlPressed && this._popup.classList.contains("is-open")) {
                    void this._showPopup(hovered.anchor, hovered.link, true);
                }
            }, SCALE_RENDER_DEBOUNCE_MS);
        }

        async _showPopup(anchor: HTMLElement, link: PreviewLink, preserveScroll = false): Promise<void> {
            if (this._isHoverSuppressed()) {
                return;
            }
            this._cancelActiveRenderTask();
            const requestId = ++this._previewRequestId;
            const destination = await this._resolveDestination(link.dest).catch((error: unknown): null => {
                console.warn("Failed to resolve PDF link destination.", error);
                return null;
            });
            if (!destination || requestId !== this._previewRequestId || this._isHoverSuppressed()) {
                return;
            }

            this._popup.classList.add("is-open");
            const cachedText = getCachedEntry(this._textCache, textPreviewKey(destination));
            const cachedImage = this._getCachedImagePreview(destination);
            if (!preserveScroll && cachedText !== undefined && cachedImage !== undefined) {
                this._renderPopupContent(destination, cachedText, cachedImage, anchor);
            } else if (!preserveScroll) {
                this._popup.innerHTML = `
        <div class="academic-citation-popup__meta">Page ${destination.pageNumber}</div>
        <div class="academic-citation-popup__preview"><div class="academic-citation-popup__loading">Loading preview...</div></div>
      `;
            }
            this._positionPopup(anchor);

            const [text, image] = await Promise.all([
                this._getTextPreview(destination).catch((error: unknown): string => {
                    console.warn("Failed to render PDF link text preview.", error);
                    return "";
                }),
                this._getImagePreview(destination, requestId).catch((error: unknown): null => {
                    console.warn("Failed to render PDF link image preview.", error);
                    return null;
                })
            ]);
            if (requestId !== this._previewRequestId || this._isHoverSuppressed()) {
                return;
            }
            if (!image?.src && !image?.canvas && this._displayedImage) {
                return;
            }
            if (image && image === this._displayedImage && !preserveScroll) {
                return;
            }
            this._renderPopupContent(
                destination,
                text,
                image?.src || image?.canvas ? image : null,
                anchor,
                preserveScroll || this._displayedImage !== null
            );
        }

        _renderPopupContent(
            destination: ResolvedDestination,
            text: string,
            image: ImagePreview | null,
            anchor: HTMLElement,
            preserveScroll = false
        ): void {
            const previous = this._popup.querySelector<HTMLElement>(".academic-citation-popup__preview");
            const scroll = preserveScroll && previous && this._displayWidth > 0
                ? { top: previous.scrollTop / this._displayWidth, left: previous.scrollLeft / this._displayWidth }
                : null;
            const oldImage = this._displayedImage;
            this._displayedImage = image;
            this._popup.innerHTML = `
        <div class="academic-citation-popup__meta">Page ${destination.pageNumber}</div>
        ${image ? `<div class="academic-citation-popup__preview">${image.src ? `<img class="academic-citation-popup__image" src="${image.src}" width="${image.pixelWidth}" height="${image.pixelHeight}" alt="" draggable="false">` : ""}</div>` : ""}
        <div class="academic-citation-popup__text">${escapeHtml(text || "No nearby text found.")}</div>
      `;
            if (image?.canvas) {
                image.canvas.className = "academic-citation-popup__image";
                image.canvas.setAttribute("aria-hidden", "true");
                this._popup.querySelector(".academic-citation-popup__preview")?.append(image.canvas);
            }
            this._displayWidth = this._getPreviewDisplayWidth();
            this._displayDensity = this._getPreviewDensity();
            this._bindPreviewScroll(image, anchor, scroll);
            if (oldImage !== image) {
                this._releasePreviewCanvas(oldImage);
            }
            requestAnimationFrame(() => this._positionPopup(anchor));
        }

        _isHoverSuppressed(): boolean {
            return performance.now() < this._suppressHoverUntil;
        }

        _hidePopup(): void {
            if (this._refreshTimer) {
                clearTimeout(this._refreshTimer);
                this._refreshTimer = null;
            }
            this._previewRequestId++;
            this._cancelActiveRenderTask();
            this._hoverDelayer.cancelOpen();
            this._cancelSuppressedOpen();
            this._cancelClose();
            this._cancelPendingPointerMoveFrame();
            this._popup.classList.remove("is-open");
            this._popup.innerHTML = "";
            const image = this._displayedImage;
            this._displayedImage = null;
            this._releasePreviewCanvas(image);
        }

        _scheduleClose(): void {
            if (this._closeTimer !== null) {
                return;
            }
            this._closeTimer = setTimeout(() => {
                this._closeTimer = null;
                if (this._pointerPosition && this._popup.classList.contains("is-open")) {
                    const { x, y } = this._pointerPosition;
                    const rect = this._popup.getBoundingClientRect();
                    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
                        return;
                    }
                }
                this._setHoveredPreview(null);
            }, CLOSE_DELAY_MS);
        }

        _cancelClose(): void {
            if (this._closeTimer === null) {
                return;
            }
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }

        _cancelPendingPointerMoveFrame(): void {
            if (this._pendingPointerMoveFrame === null) {
                return;
            }
            cancelAnimationFrame(this._pendingPointerMoveFrame);
            this._pendingPointerMoveFrame = null;
        }

        _createPopup(): HTMLDivElement {
            const popup = document.createElement("div");
            popup.className = "academic-citation-popup";
            popup.draggable = false;
            popup.addEventListener("dragstart", preventDefaultDrag);
            popup.addEventListener("wheel", event => {
                if (!event.ctrlKey && !event.metaKey) {
                    return;
                }
                const scrollTarget = event.target instanceof Element
                    ? event.target.closest<HTMLElement>(".academic-citation-popup__preview") ?? popup
                    : popup;
                const deltaScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
                    ? 16
                    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
                        ? scrollTarget.clientHeight
                        : 1;
                scrollTarget.scrollLeft += event.deltaX * deltaScale;
                scrollTarget.scrollTop += event.deltaY * deltaScale;
                event.preventDefault();
                event.stopPropagation();
            }, { passive: false });
            document.body.append(popup);
            return popup;
        }

        _bindPreviewScroll(
            image: ImagePreview | null,
            anchor: HTMLElement,
            scroll: { top: number; left: number } | null = null
        ): void {
            const preview = this._popup.querySelector<HTMLElement>(".academic-citation-popup__preview");
            if (!preview) {
                return;
            }
            if (!image) {
                return;
            }
            const previewImage = preview.querySelector<HTMLElement>(".academic-citation-popup__image");
            const settlePreview = () => {
                if (!preview.isConnected || this._displayedImage !== image) {
                    return;
                }
                this._positionPopup(anchor);
                const width = this._getPreviewDisplayWidth();
                preview.scrollTop = scroll ? scroll.top * width
                    : Math.max(0, preview.scrollHeight * image.targetYRatio - preview.clientHeight * 0.32);
                preview.scrollLeft = scroll ? scroll.left * width
                    : Math.max(0, preview.scrollWidth * image.targetXRatio - preview.clientWidth * 0.5);
                this._schedulePreviewRefresh();
            };
            // Explicit image dimensions make layout available before PNG decoding completes.
            if (previewImage) {
                requestAnimationFrame(settlePreview);
            }
        }

        _positionPopup(anchor: HTMLElement): void {
            const anchorRect = anchor.getBoundingClientRect();
            const popupRect = this._popup.getBoundingClientRect();
            const margin = 8;
            const placement = choosePopupPlacement(anchorRect, popupRect, margin);
            this._popup.style.left = `${placement.left}px`;
            this._popup.style.top = `${placement.top}px`;
        }

        async _resolveDestination(dest: PdfJsDestination): Promise<ResolvedDestination | null> {
            if (!this._pdfDocument) {
                return null;
            }

            const explicitDest = typeof dest === "string"
                ? await this._pdfDocument.getDestination(dest)
                : dest;
            if (!Array.isArray(explicitDest) || explicitDest.length < 2) {
                return null;
            }

            const destRef = explicitDest[0];
            let pageNumber: number | null = null;
            if (typeof destRef === "number" && Number.isInteger(destRef)) {
                pageNumber = destRef + 1;
            } else if (destRef && typeof destRef === "object") {
                pageNumber = getCachedPageNumber(this._app.pdfDocument, destRef);
                if (!pageNumber) {
                    pageNumber = (await this._pdfDocument.getPageIndex(destRef)) + 1;
                }
            }
            if (typeof pageNumber !== "number" || !Number.isInteger(pageNumber)) {
                return null;
            }

            const position = getDestinationPosition(explicitDest);
            return {
                pageNumber,
                pdfX: position.x,
                pdfY: position.y
            };
        }

        async _getTextPreview(destination: ResolvedDestination): Promise<string> {
            const key = textPreviewKey(destination);
            const cachedText = getCachedEntry(this._textCache, key);
            if (cachedText !== undefined) {
                return cachedText;
            }

            const page = await this._getPage(destination.pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const targetY = destination.pdfY !== null && Number.isFinite(destination.pdfY)
                ? viewport.convertToViewportPoint(destination.pdfX || 0, destination.pdfY)[1]
                : null;
            const textContent = await this._getPageTextContent(destination.pageNumber);
            const lines = collectNearbyLines(textContent.items, viewport, targetY);
            const text = lines.slice(0, 4).join(" ");
            rememberBoundedEntry(this._textCache, key, text, MAX_DOCUMENT_CACHE_ENTRIES);
            return text;
        }

        async _getImagePreview(destination: ResolvedDestination, requestId: number): Promise<ImagePreview | null> {
            const startedAt = performance.now();
            const key = imagePreviewKey(destination);
            const pdfDocument = this._pdfDocument;
            const generation = this._previewGeneration;
            const page = await this._getPage(destination.pageNumber);
            const baseViewport = page.getViewport({ scale: 1 });
            const baseTextBounds = await this._getPageTextBounds(destination.pageNumber, baseViewport);
            if (requestId !== this._previewRequestId || generation !== this._previewGeneration) {
                return null;
            }
            const baseCrop = getPreviewCrop(baseViewport, baseTextBounds);
            const loading = this._popup.querySelector<HTMLElement>(".academic-citation-popup__preview > .academic-citation-popup__loading");
            if (loading) {
                // Lay out the same scrollable page height before measuring the content width.
                loading.style.boxSizing = "border-box";
                loading.style.aspectRatio = `${baseCrop.width} / ${baseCrop.height}`;
            }
            const displayWidth = this._getPreviewDisplayWidth();
            const maxPixelScale = Math.min(
                Math.sqrt(MAX_PREVIEW_PIXELS / (baseCrop.width * baseCrop.height)),
                MAX_PREVIEW_DIMENSION / baseCrop.width,
                MAX_PREVIEW_DIMENSION / baseCrop.height
            );
            const maxPixelWidth = Math.max(1, Math.floor(baseCrop.width * maxPixelScale));
            const pixelWidth = Math.max(1, Math.min(Math.ceil(displayWidth * this._getPreviewDensity()), maxPixelWidth));
            const scale = Math.min(pixelWidth / baseCrop.width, maxPixelScale);
            const pixelHeight = Math.max(1, Math.floor(baseCrop.height * scale));
            const cachedPreview = this._getCachedImagePreview(destination);
            if (cachedPreview && (cachedPreview.pixelWidth ?? 0) >= pixelWidth) {
                return cachedPreview;
            }
            const encodingKey = `${generation}:${key}:${pixelWidth}`;
            for (const [pendingKey, pending] of this._pendingPreviewEncodings) {
                if (pendingKey.startsWith(`${generation}:${key}:`) && (pending.image.pixelWidth ?? 0) >= pixelWidth) {
                    return pending.image;
                }
            }
            const viewport = page.getViewport({ scale });
            const point = destination.pdfY !== null && Number.isFinite(destination.pdfY)
                ? viewport.convertToViewportPoint(destination.pdfX || 0, destination.pdfY)
                : [0, 0];
            const crop = scalePreviewCrop(baseCrop, scale);
            const croppedViewport = page.getViewport({
                scale,
                offsetX: -crop.left,
                offsetY: -crop.top
            });

            const canvas = document.createElement("canvas");
            canvas.width = pixelWidth;
            canvas.height = pixelHeight;

            const context = canvas.getContext("2d", { alpha: false });
            if (!context) {
                canvas.width = canvas.height = 0;
                return null;
            }
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            const renderTask = page.render({
                canvasContext: context,
                viewport: croppedViewport
            }) as PdfJsRenderTask;
            this._activeRenderTask = renderTask;
            try {
                await renderTask.promise;
            } catch (error) {
                if (isRenderingCancelled(error)) {
                    canvas.width = canvas.height = 0;
                    return null;
                }
                canvas.width = canvas.height = 0;
                throw error;
            } finally {
                if (this._activeRenderTask === renderTask) {
                    this._activeRenderTask = null;
                }
            }
            drawPreviewTarget(context, point, crop, crop.width / displayWidth);
            if (this._pdfDocument !== pdfDocument || generation !== this._previewGeneration
                || requestId !== this._previewRequestId) {
                canvas.width = 0;
                canvas.height = 0;
                return null;
            }
            const image = {
                src: "",
                canvas,
                pixelWidth,
                pixelHeight,
                maxPixelWidth,
                targetXRatio: clamp((point[0] - crop.left) / crop.width, 0, 1),
                targetYRatio: clamp((point[1] - crop.top) / crop.height, 0, 1)
            };
            this._reportDebug("linkPreviewRendered", {
                pageNumber: destination.pageNumber,
                durationMs: performance.now() - startedAt,
                sizeBytes: canvas.width * canvas.height * 4
            });

            this._startPreviewEncoding(
                key,
                encodingKey,
                image,
                canvas,
                pdfDocument,
                generation,
                destination.pageNumber
            );
            return image;
        }

        _startPreviewEncoding(
            key: string,
            encodingKey: string,
            image: ImagePreview,
            canvas: HTMLCanvasElement,
            pdfDocument: PdfJsDocument | null,
            generation: number,
            pageNumber: number
        ): void {
            if (this._pendingPreviewEncodings.has(encodingKey)
                || this._pendingPreviewEncodings.size >= MAX_PENDING_PREVIEW_ENCODINGS) {
                return;
            }
            const encodingStartedAt = performance.now();
            const encoding = canvasToPngBlob(canvas).then((blob): ImagePreview | null => {
                if (this._pdfDocument !== pdfDocument || this._previewGeneration !== generation
                    || (this._previewCache.get(key)?.pixelWidth ?? 0) > canvas.width) {
                    return null;
                }
                const encodedPreview = {
                    src: URL.createObjectURL(blob),
                    // Include a decoded RGBA copy; compressed PNG size alone understates the cost.
                    sizeBytes: blob.size + canvas.width * canvas.height * 4,
                    pixelWidth: image.pixelWidth,
                    pixelHeight: image.pixelHeight,
                    maxPixelWidth: image.maxPixelWidth,
                    targetXRatio: image.targetXRatio,
                    targetYRatio: image.targetYRatio
                };
                this._rememberImagePreview(key, encodedPreview);
                this._reportDebug("linkPreviewEncoded", {
                    pageNumber,
                    durationMs: performance.now() - encodingStartedAt,
                    sizeBytes: blob.size
                });
                return encodedPreview;
            }).catch((error: unknown): null => {
                console.warn("Failed to cache PDF link image preview.", error);
                return null;
            }).finally(() => {
                if (this._pendingPreviewEncodings.get(encodingKey)?.task === encoding) {
                    this._pendingPreviewEncodings.delete(encodingKey);
                }
                this._releasePreviewCanvas(image);
            });
            this._pendingPreviewEncodings.set(encodingKey, { image, task: encoding });
        }

        _reportDebug(event: string, fields: Record<string, unknown>): void {
            if (!this._debug) {
                return;
            }
            window.dispatchEvent(new CustomEvent("academic-pdf-debug", {
                detail: { type: "pdf.debug", event, ...fields }
            }));
        }

        _getCachedImagePreview(destination: ResolvedDestination): ImagePreview | undefined {
            const key = imagePreviewKey(destination);
            return getCachedEntry(this._previewCache, key);
        }

        _getPageTextContent(pageNumber: number): Promise<PdfJsTextContent> {
            return getCachedPromise(this._textContentCache, pageNumber, () => (
                this._getPage(pageNumber).then(page => page.getTextContent())
            ));
        }

        _getPage(pageNumber: number): Promise<PdfJsPage> {
            return getCachedPromise(this._pageCache, pageNumber, () => (
                this._pdfDocument!.getPage(pageNumber)
            ));
        }

        _getPreviewDisplayWidth(): number {
            const content = this._popup.querySelector<HTMLElement>(
                ".academic-citation-popup__image, .academic-citation-popup__preview > .academic-citation-popup__loading"
            );
            const width = content?.getBoundingClientRect().width;
            if (width && width > 0) {
                return width;
            }
            const popupWidth = this._popup.clientWidth;
            if (popupWidth > 0) {
                return popupWidth;
            }
            return Math.max(1, Math.min(MAX_PREVIEW_DISPLAY_WIDTH, window.innerWidth - PREVIEW_VIEWPORT_MARGIN));
        }

        _rememberImagePreview(key: string, image: ImagePreview): void {
            const existing = this._previewCache.get(key);
            if (existing) {
                URL.revokeObjectURL(existing.src);
                this._previewCacheBytes -= existing.sizeBytes ?? 0;
                this._previewCache.delete(key);
            }
            this._previewCache.set(key, image);
            this._previewCacheBytes += image.sizeBytes ?? 0;
            while (this._previewCache.size > MAX_PREVIEW_CACHE_ENTRIES
                || this._previewCacheBytes > MAX_PREVIEW_CACHE_BYTES) {
                const oldestKey = this._previewCache.keys().next().value;
                if (oldestKey === undefined) {
                    return;
                }
                const oldest = this._previewCache.get(oldestKey);
                if (oldest) {
                    URL.revokeObjectURL(oldest.src);
                    this._previewCacheBytes -= oldest.sizeBytes ?? 0;
                }
                this._previewCache.delete(oldestKey);
            }
            this._previewCacheBytes = Math.max(0, this._previewCacheBytes);
        }

        _clearPreviewCache(): void {
            this._previewGeneration++;
            for (const image of this._previewCache.values()) {
                URL.revokeObjectURL(image.src);
            }
            this._previewCache.clear();
            this._previewCacheBytes = 0;
        }

        _releasePreviewCanvas(image: ImagePreview | null): void {
            if (!image?.canvas || image.canvas.isConnected) {
                return;
            }
            for (const pending of this._pendingPreviewEncodings.values()) {
                if (pending.image === image) {
                    return;
                }
            }
            image.canvas.width = image.canvas.height = 0;
        }

        _cancelActiveRenderTask(): void {
            if (!this._activeRenderTask) {
                return;
            }
            this._activeRenderTask.cancel();
            this._activeRenderTask = null;
        }

        async _getPageTextBounds(pageNumber: number, viewport: PdfJsViewport): Promise<TextBounds | null> {
            const textContent = await this._getPageTextContent(pageNumber);
            let minX = Infinity;
            let maxX = -Infinity;
            for (const item of textContent.items) {
                if (typeof item.str !== "string"
                    || !item.str.trim()
                    || !Array.isArray(item.transform)
                    || typeof item.width !== "number") {
                    continue;
                }
                const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
                const x = transform[4];
                const width = Math.abs(item.width * viewport.scale);
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x + width);
            }
            if (!Number.isFinite(minX) || !Number.isFinite(maxX) || maxX <= minX) {
                return null;
            }
            return {
                left: clamp(minX - TEXT_BOUND_PADDING_PX, 0, viewport.width),
                right: clamp(maxX + TEXT_BOUND_PADDING_PX, 0, viewport.width)
            };
        }

        _clearAllOverlays(): void {
            for (const layer of this._pageLayers) {
                layer.remove();
            }
            this._pageLayers.clear();
            this._pageOverlays.clear();
        }

        _clearPageOverlays(pageDiv: HTMLElement): void {
            const layer = pageDiv.querySelector(".academic-citation-layer");
            if (layer) {
                layer.textContent = "";
                pageDiv.append(layer);
            }
            this._pageOverlays.delete(pageDiv);
        }

        _trackPageOverlay(pageDiv: HTMLElement, overlay: HTMLElement): void {
            let overlays = this._pageOverlays.get(pageDiv);
            if (!overlays) {
                overlays = new Set();
                this._pageOverlays.set(pageDiv, overlays);
            }
            overlays.add(overlay);
        }

        _ensurePageLayer(pageDiv: HTMLElement): HTMLElement {
            let layer = pageDiv.querySelector<HTMLElement>(".academic-citation-layer");
            if (!layer) {
                layer = document.createElement("div");
                layer.className = "academic-citation-layer";
                pageDiv.append(layer);
            }
            this._pageLayers.add(layer);
            return layer;
        }
    }

    function isInternalLinkAnnotation(
        annotation: PdfJsAnnotation
    ): annotation is InternalLinkAnnotation {
        return annotation.subtype === "Link"
            && (Array.isArray(annotation.dest)
                || typeof annotation.dest === "string" && annotation.dest.length > 0)
            && Array.isArray(annotation.rect);
    }

    function readInitialConfiguration(): LinkPreviewConfiguration {
        const configElement = document.getElementById("pdf-preview-config");
        const config = configElement?.getAttribute("data-config");
        if (!config) {
            return { debug: false, enabled: true, resolutionScale: DEFAULT_RESOLUTION_SCALE };
        }
        try {
            const settings = JSON.parse(config) as {
                linkPreviewEnabled?: unknown;
                linkPreviewResolutionScale?: unknown;
                debug?: unknown;
            };
            return {
                debug: settings.debug === true,
                enabled: settings.linkPreviewEnabled !== false,
                resolutionScale: normalizeResolutionScale(settings.linkPreviewResolutionScale)
            };
        } catch {
            return { debug: false, enabled: true, resolutionScale: DEFAULT_RESOLUTION_SCALE };
        }
    }

    function viewportRect(viewport: PdfJsViewport, pdfRect: number[]): ViewportRect {
        const [x1, y1] = viewport.convertToViewportPoint(pdfRect[0], pdfRect[1]);
        const [x2, y2] = viewport.convertToViewportPoint(pdfRect[2], pdfRect[3]);
        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const extraHeight = Math.max(0, MIN_HIT_HEIGHT_PX - height) / 2;
        return {
            left: left - HIT_PADDING_PX,
            top: top - HIT_PADDING_PX - extraHeight,
            width: width + HIT_PADDING_PX * 2,
            height: height + HIT_PADDING_PX * 2 + extraHeight * 2
        };
    }

    function getDestinationPosition(destArray: unknown[]): { x: number | null; y: number | null } {
        const kind = (destArray[1] as { name?: string } | undefined)?.name;
        if (kind === "XYZ") {
            return { x: numberOrNull(destArray[2]), y: numberOrNull(destArray[3]) };
        }
        if (kind === "FitH" || kind === "FitBH") {
            return { x: 0, y: numberOrNull(destArray[2]) };
        }
        if (kind === "FitV" || kind === "FitBV") {
            return { x: numberOrNull(destArray[2]), y: null };
        }
        if (kind === "FitR") {
            return { x: numberOrNull(destArray[2]), y: numberOrNull(destArray[5]) };
        }
        return { x: 0, y: null };
    }

    function numberOrNull(value: unknown): number | null {
        return typeof value === "number" ? value : null;
    }

    function textPreviewKey(destination: ResolvedDestination): string {
        return `${destination.pageNumber}:${Math.round(destination.pdfY || 0)}`;
    }

    function imagePreviewKey(destination: ResolvedDestination): string {
        return `${destination.pageNumber}:${Math.round(destination.pdfX || 0)}:${Math.round(destination.pdfY || 0)}`;
    }

    function getCachedPageNumber(pdfDocument: PdfJsDocument | null, destRef: object): number | null {
        return typeof pdfDocument?.cachedPageNumber === "function"
            ? pdfDocument.cachedPageNumber(destRef)
            : null;
    }

    function collectNearbyLines(items: PdfJsTextItem[], viewport: PdfJsViewport, targetY: number | null): string[] {
        const allRows: Array<PositionedTextRow> = [];
        for (const item of items) {
            if (typeof item.str !== "string" || !item.str.trim() || !Array.isArray(item.transform)) {
                continue;
            }
            const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
            const y = transform[5];
            const row = {
                text: item.str.trim(),
                x: transform[4],
                y
            };
            allRows.push(row);
        }
        return collectNearbyLinesFromRows(allRows, targetY, {
            textRadiusPx: TEXT_RADIUS_PX,
            maxCandidateRows: 40,
            maxReturnedLines: 4,
        });
    }

    function getPreviewCrop(viewport: PdfJsViewport, textBounds: TextBounds | null): PreviewCrop {
        const fallbackMargin = viewport.width * PREVIEW_MARGIN_FALLBACK_RATIO;
        let left = fallbackMargin;
        let right = viewport.width - fallbackMargin;
        if (textBounds) {
            const leftMargin = textBounds.left;
            const rightMargin = viewport.width - textBounds.right;
            // Symmetric cropping must retain the wider side of asymmetric content.
            const balancedMargin = Math.min(leftMargin, rightMargin);
            left = balancedMargin;
            right = viewport.width - balancedMargin;
        }
        return {
            left,
            top: 0,
            width: Math.max(1, right - left),
            height: viewport.height
        };
    }

    function scalePreviewCrop(crop: PreviewCrop, scale: number): PreviewCrop {
        return {
            left: crop.left * scale,
            top: crop.top * scale,
            width: crop.width * scale,
            height: crop.height * scale
        };
    }

    function drawPreviewTarget(
        context: CanvasRenderingContext2D,
        point: number[],
        crop: PreviewCrop,
        pixelDensity: number
    ): void {
        const maximumRadius = Math.max(0, Math.min(crop.width, crop.height) / 2 - 2);
        const radius = Math.min(PREVIEW_TARGET_RADIUS * pixelDensity, maximumRadius);
        if (radius <= 0) {
            return;
        }
        const x = clamp(point[0] - crop.left, radius + 2, crop.width - radius - 2);
        const y = clamp(point[1] - crop.top, radius + 2, crop.height - radius - 2);
        context.save();
        context.globalCompositeOperation = "multiply";
        context.fillStyle = "#f57b7b";
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
        context.restore();
    }

    function escapeHtml(value: unknown): string {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    function clamp(value: number, min: number, max: number): number {
        return Math.min(Math.max(value, min), max);
    }

    function containsClientPointInPage(pageRect: DOMRect, rect: ViewportRect, x: number, y: number): boolean {
        const left = pageRect.left + rect.left;
        const right = left + rect.width;
        const top = pageRect.top + rect.top;
        const bottom = top + rect.height;
        return x >= left && x <= right && y >= top && y <= bottom;
    }

    function normalizeResolutionScale(value: unknown): number {
        if (value === 0 || typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_RESOLUTION_SCALE;
        }
        return clamp(value, MIN_RESOLUTION_SCALE, MAX_RESOLUTION_SCALE);
    }

    function getCachedEntry<K, V>(cache: Map<K, V>, key: K): V | undefined {
        const value = cache.get(key);
        if (value !== undefined) {
            cache.delete(key);
            cache.set(key, value);
        }
        return value;
    }

    function rememberBoundedEntry<K, V>(cache: Map<K, V>, key: K, value: V, maximumEntries: number): void {
        cache.delete(key);
        cache.set(key, value);
        while (cache.size > maximumEntries) {
            const oldestKey = cache.keys().next().value;
            if (oldestKey === undefined) {
                return;
            }
            cache.delete(oldestKey);
        }
    }

    function getCachedPromise<T>(cache: Map<number, Promise<T>>, pageNumber: number, load: () => Promise<T>): Promise<T> {
        const cached = getCachedEntry(cache, pageNumber);
        if (cached) {
            return cached;
        }
        const promise = load();
        rememberBoundedEntry(cache, pageNumber, promise, MAX_DOCUMENT_CACHE_ENTRIES);
        void promise.catch(() => {
            if (cache.get(pageNumber) === promise) {
                cache.delete(pageNumber);
            }
        });
        return promise;
    }

    function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error("Could not encode the PDF link preview image."));
                }
            }, "image/png");
        });
    }

    function isRenderingCancelled(error: unknown): boolean {
        return error instanceof Error && error.name === "RenderingCancelledException";
    }

    function preventDefaultDrag(event: DragEvent): void {
        event.preventDefault();
        event.stopPropagation();
    }

    function choosePopupPlacement(anchorRect: DOMRect, popupRect: DOMRect, margin: number): PopupPlacement {
        const maxLeft = window.innerWidth - popupRect.width - margin;
        const maxTop = window.innerHeight - popupRect.height - margin;
        const candidates = [
            {
                left: anchorRect.left,
                top: anchorRect.bottom + margin
            },
            {
                left: anchorRect.left,
                top: anchorRect.top - popupRect.height - margin
            },
            {
                left: anchorRect.right + margin,
                top: anchorRect.top + anchorRect.height / 2 - popupRect.height / 2
            },
            {
                left: anchorRect.left - popupRect.width - margin,
                top: anchorRect.top + anchorRect.height / 2 - popupRect.height / 2
            }
        ];

        let best: (PopupPlacement & { score: number }) | null = null;
        for (const candidate of candidates) {
            const score = scorePlacement(candidate, popupRect, margin);
            const clamped = {
                left: clamp(candidate.left, margin, Math.max(margin, maxLeft)),
                top: clamp(candidate.top, margin, Math.max(margin, maxTop))
            };
            if (!best || score > best.score) {
                best = { ...clamped, score };
            }
        }
        return best || { left: margin, top: margin };
    }

    function scorePlacement(position: PopupPlacement, popupRect: DOMRect, margin: number): number {
        const left = position.left;
        const top = position.top;
        const right = left + popupRect.width;
        const bottom = top + popupRect.height;
        const visibleWidth = Math.max(0, Math.min(right, window.innerWidth - margin) - Math.max(left, margin));
        const visibleHeight = Math.max(0, Math.min(bottom, window.innerHeight - margin) - Math.max(top, margin));
        const overflow =
            Math.max(0, margin - left)
            + Math.max(0, margin - top)
            + Math.max(0, right - (window.innerWidth - margin))
            + Math.max(0, bottom - (window.innerHeight - margin));
        return visibleWidth * visibleHeight - overflow * 10000;
    }

    async function initialize(): Promise<void> {
        const app = pdfjsAdapter.getApplication();
        if (!app) {
            return;
        }

        await app.initializedPromise;
        const controller = new CitationPreviewController(app);
        controller.initialize();
    }

    let initializationStarted = false;
    function startInitialization(): void {
        if (initializationStarted || !pdfjsAdapter.getApplication()) {
            return;
        }
        initializationStarted = true;
        initialize().catch(error => {
            console.error("Failed to initialize Academic PDF citation preview layer.", error);
        });
    }

    startInitialization();
    document.addEventListener("webviewerloaded", startInitialization, { once: true });
    window.addEventListener("load", startInitialization, { once: true });
}());
