/// <reference path="./globals.d.ts" />
"use strict";
import { collectNearbyLinesFromRows } from "./citationPreviewLines.js";
(function () {
    const OPEN_DELAY_MS = 200;
    const TEXT_RADIUS_PX = 90;
    const DEFAULT_RESOLUTION_SCALE = 2;
    const MIN_RESOLUTION_SCALE = 1;
    const MAX_RESOLUTION_SCALE = 4;
    const MAX_PREVIEW_PIXELS = 25600000;
    const MAX_PREVIEW_DISPLAY_WIDTH = 760;
    const PREVIEW_VIEWPORT_MARGIN = 16;
    const PREVIEW_MARGIN_FALLBACK_RATIO = 0.08;
    const TEXT_BOUND_PADDING_PX = 28;
    const PREVIEW_TARGET_RADIUS = 10;
    const HIT_PADDING_PX = 2;
    const MIN_HIT_HEIGHT_PX = 10;
    const SCALE_RENDER_DEBOUNCE_MS = 140;
    const MAX_PREVIEW_CACHE_ENTRIES = 16;
    const MAX_DOCUMENT_CACHE_ENTRIES = 64;
    const WHEEL_ZOOM_SUPPRESS_HOVER_MS = 260;
    const pdfjsAdapter = window.academicPdfJsAdapter;
    class HoverDelayer {
        _openTimer;
        constructor() {
            this._openTimer = null;
        }
        open(callback) {
            this.cancelOpen();
            this._openTimer = setTimeout(() => {
                this._openTimer = null;
                callback();
            }, OPEN_DELAY_MS);
        }
        cancelOpen() {
            if (!this._openTimer) {
                return;
            }
            clearTimeout(this._openTimer);
            this._openTimer = null;
        }
    }
    class CitationPreviewController {
        _app;
        _eventBus;
        _pdfDocument;
        _pendingPointerMoveFrame;
        _hoverDelayer;
        _previewCache;
        _textCache;
        _pageCache;
        _annotationCache;
        _textContentCache;
        _pageRenderIds;
        _overlayLinks;
        _pageOverlays;
        _pageLayers;
        _previewRequestId;
        _popup;
        _scaleRenderTimer;
        _suppressedOpenTimer;
        _suppressHoverUntil;
        _activeRenderTask;
        _debug;
        _enabled;
        _resolutionScale;
        _controlPressed;
        _hoveredPreview;
        _pointerPosition;
        constructor(app) {
            const initialConfiguration = readInitialConfiguration();
            this._app = app;
            this._eventBus = app.eventBus;
            this._pdfDocument = null;
            this._pendingPointerMoveFrame = null;
            this._hoverDelayer = new HoverDelayer();
            this._previewCache = new Map();
            this._textCache = new Map();
            this._pageCache = new Map();
            this._annotationCache = new Map();
            this._textContentCache = new Map();
            this._pageRenderIds = new Map();
            this._overlayLinks = new WeakMap();
            this._pageOverlays = new Map();
            this._pageLayers = new Set();
            this._previewRequestId = 0;
            this._popup = this._createPopup();
            this._scaleRenderTimer = null;
            this._suppressedOpenTimer = null;
            this._suppressHoverUntil = 0;
            this._activeRenderTask = null;
            this._debug = initialConfiguration.debug;
            this._enabled = initialConfiguration.enabled;
            this._resolutionScale = initialConfiguration.resolutionScale;
            this._controlPressed = false;
            this._hoveredPreview = null;
            this._pointerPosition = null;
        }
        initialize() {
            this._eventBus.on("documentloaded", () => {
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
            this._eventBus.on("pagerendered", (event) => {
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
                const message = event.data;
                if (isConfigureMessage(message)) {
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
                    this._setHoveredPreview(null);
                    this._cancelPendingPointerMoveFrame();
                }
            }, true);
        }
        _openHoveredPreview(immediate = false) {
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
            }
            else {
                this._hoverDelayer.open(open);
            }
        }
        _scheduleSuppressedOpen(hovered, delayMs) {
            this._cancelSuppressedOpen();
            this._suppressedOpenTimer = setTimeout(() => {
                this._suppressedOpenTimer = null;
                if (this._hoveredPreview === hovered) {
                    this._openHoveredPreview(true);
                }
            }, Math.ceil(delayMs) + 1);
        }
        _cancelSuppressedOpen() {
            if (!this._suppressedOpenTimer) {
                return;
            }
            clearTimeout(this._suppressedOpenTimer);
            this._suppressedOpenTimer = null;
        }
        _releaseControl() {
            this._controlPressed = false;
            this._hidePopup();
        }
        _configure(enabled, resolutionScale) {
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
        _scheduleScaleRender() {
            if (this._scaleRenderTimer) {
                clearTimeout(this._scaleRenderTimer);
            }
            this._scaleRenderTimer = setTimeout(() => {
                this._scaleRenderTimer = null;
                this._renderVisiblePages();
            }, SCALE_RENDER_DEBOUNCE_MS);
        }
        _cancelScheduledScaleRender() {
            if (!this._scaleRenderTimer) {
                return;
            }
            clearTimeout(this._scaleRenderTimer);
            this._scaleRenderTimer = null;
        }
        async _renderVisiblePages() {
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
        async _renderPage(pageNumber) {
            if (!this._enabled || !this._pdfDocument) {
                return;
            }
            const renderId = (this._pageRenderIds.get(pageNumber) || 0) + 1;
            rememberBoundedEntry(this._pageRenderIds, pageNumber, renderId, MAX_DOCUMENT_CACHE_ENTRIES);
            const pageView = this._app.pdfViewer.getPageView(pageNumber - 1);
            if (!pageView || !pageView.div || !pageView.viewport) {
                return;
            }
            this._clearPageOverlays(pageView.div);
            const annotations = await this._getPageAnnotations(pageNumber);
            if (!this._enabled || this._pageRenderIds.get(pageNumber) !== renderId) {
                return;
            }
            for (const annotation of annotations) {
                if (!isInternalLinkAnnotation(annotation)) {
                    continue;
                }
                this._appendOverlay(pageView, annotation, pageNumber);
            }
            this._syncHoveredPreviewAtPointer();
            this._openHoveredPreview(true);
        }
        _getPageAnnotations(pageNumber) {
            const cached = getCachedEntry(this._annotationCache, pageNumber);
            if (cached) {
                return cached;
            }
            const promise = this._getPage(pageNumber)
                .then((page) => page.getAnnotations({ intent: "display" }));
            rememberBoundedEntry(this._annotationCache, pageNumber, promise, MAX_DOCUMENT_CACHE_ENTRIES);
            void promise.catch(() => {
                if (this._annotationCache.get(pageNumber) === promise) {
                    this._annotationCache.delete(pageNumber);
                }
            });
            return promise;
        }
        _appendOverlay(pageView, annotation, pageNumber) {
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
                id: `${pageNumber}:${annotation.id || JSON.stringify(annotation.rect)}`,
                sourcePageNumber: pageNumber,
                rect,
                dest: annotation.dest
            };
            this._overlayLinks.set(overlay, link);
            this._trackPageOverlay(pageView.div, overlay);
            overlay.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._hidePopup();
                this._app.pdfLinkService.goToDestination(link.dest);
            });
            layer.append(overlay);
        }
        _syncHoveredPreviewAtPointer() {
            if (!this._pointerPosition) {
                return this._setHoveredPreview(null);
            }
            const { x, y } = this._pointerPosition;
            const elements = document.elementsFromPoint(x, y);
            let directAnchor = null;
            let page = null;
            for (const element of elements) {
                if (!directAnchor) {
                    directAnchor = element.closest(".academic-citation-link");
                }
                if (!page) {
                    page = element.closest(".page");
                }
                if (directAnchor && page) {
                    break;
                }
            }
            const overlays = page ? this._pageOverlays.get(page) : null;
            let anchor = directAnchor;
            if (!anchor && overlays) {
                for (const candidate of overlays) {
                    if (containsClientPoint(candidate.getBoundingClientRect(), x, y)) {
                        anchor = candidate;
                        break;
                    }
                }
            }
            const link = anchor && this._overlayLinks.get(anchor);
            return this._setHoveredPreview(anchor && link ? { anchor, link } : null);
        }
        _setHoveredPreview(hovered) {
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
        async _showPopup(anchor, link) {
            if (this._isHoverSuppressed()) {
                return;
            }
            this._cancelActiveRenderTask();
            const requestId = ++this._previewRequestId;
            const destination = await this._resolveDestination(link.dest).catch((error) => {
                console.warn("Failed to resolve PDF link destination.", error);
                return null;
            });
            if (!destination || requestId !== this._previewRequestId || this._isHoverSuppressed()) {
                return;
            }
            const cachedText = getCachedEntry(this._textCache, textPreviewKey(destination));
            const cachedImage = this._getCachedImagePreview(destination);
            if (cachedText !== undefined && cachedImage !== undefined) {
                this._popup.classList.add("is-open");
                this._renderPopupContent(destination, cachedText, cachedImage, anchor);
                return;
            }
            this._popup.classList.add("is-open");
            this._popup.innerHTML = `
        <div class="academic-citation-popup__meta">Page ${destination.pageNumber}</div>
        <div class="academic-citation-popup__loading">Loading preview...</div>
      `;
            this._positionPopup(anchor);
            const [text, image] = await Promise.all([
                this._getTextPreview(destination).catch((error) => {
                    console.warn("Failed to render PDF link text preview.", error);
                    return "";
                }),
                this._getImagePreview(destination).catch((error) => {
                    console.warn("Failed to render PDF link image preview.", error);
                    return null;
                })
            ]);
            if (requestId !== this._previewRequestId || this._isHoverSuppressed()) {
                return;
            }
            this._renderPopupContent(destination, text, image?.src || image?.canvas ? image : null, anchor);
        }
        _renderPopupContent(destination, text, image, anchor) {
            this._popup.innerHTML = `
        <div class="academic-citation-popup__meta">Page ${destination.pageNumber}</div>
        ${image ? `<div class="academic-citation-popup__preview">${image.src ? `<img class="academic-citation-popup__image" src="${image.src}" alt="" draggable="false">` : ""}</div>` : ""}
        <div class="academic-citation-popup__text">${escapeHtml(text || "No nearby text found.")}</div>
      `;
            if (image?.canvas) {
                image.canvas.className = "academic-citation-popup__image";
                image.canvas.setAttribute("aria-hidden", "true");
                this._popup.querySelector(".academic-citation-popup__preview")?.append(image.canvas);
            }
            this._bindPreviewScroll(image, anchor);
            requestAnimationFrame(() => this._positionPopup(anchor));
        }
        _isHoverSuppressed() {
            return performance.now() < this._suppressHoverUntil;
        }
        _hidePopup() {
            this._previewRequestId++;
            this._cancelActiveRenderTask();
            this._hoverDelayer.cancelOpen();
            this._cancelSuppressedOpen();
            this._cancelPendingPointerMoveFrame();
            this._popup.classList.remove("is-open");
            this._popup.innerHTML = "";
        }
        _cancelPendingPointerMoveFrame() {
            if (this._pendingPointerMoveFrame === null) {
                return;
            }
            cancelAnimationFrame(this._pendingPointerMoveFrame);
            this._pendingPointerMoveFrame = null;
        }
        _createPopup() {
            const popup = document.createElement("div");
            popup.className = "academic-citation-popup";
            popup.draggable = false;
            popup.addEventListener("dragstart", preventDefaultDrag);
            document.body.append(popup);
            return popup;
        }
        _bindPreviewScroll(image, anchor) {
            const preview = this._popup.querySelector(".academic-citation-popup__preview");
            if (!preview) {
                return;
            }
            if (!image) {
                return;
            }
            const previewImage = preview.querySelector(".academic-citation-popup__image");
            const settlePreview = () => {
                this._positionPopup(anchor);
                preview.scrollTop = Math.max(0, preview.scrollHeight * image.targetYRatio - preview.clientHeight * 0.32);
                preview.scrollLeft = Math.max(0, preview.scrollWidth * image.targetXRatio - preview.clientWidth * 0.5);
            };
            if (previewImage instanceof HTMLImageElement && previewImage.complete) {
                requestAnimationFrame(settlePreview);
            }
            else if (previewImage instanceof HTMLImageElement) {
                previewImage.addEventListener("load", () => requestAnimationFrame(settlePreview), { once: true });
            }
            else if (previewImage) {
                requestAnimationFrame(settlePreview);
            }
        }
        _positionPopup(anchor) {
            const anchorRect = anchor.getBoundingClientRect();
            const popupRect = this._popup.getBoundingClientRect();
            const margin = 8;
            const placement = choosePopupPlacement(anchorRect, popupRect, margin);
            this._popup.style.left = `${placement.left}px`;
            this._popup.style.top = `${placement.top}px`;
        }
        async _resolveDestination(dest) {
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
            let pageNumber = null;
            if (typeof destRef === "number" && Number.isInteger(destRef)) {
                pageNumber = destRef + 1;
            }
            else if (destRef && typeof destRef === "object") {
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
                destArray: explicitDest,
                pdfX: position.x,
                pdfY: position.y
            };
        }
        async _getTextPreview(destination) {
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
        async _getImagePreview(destination) {
            const startedAt = performance.now();
            const key = imagePreviewKey(destination);
            const cachedPreview = this._getCachedImagePreview(destination);
            if (cachedPreview) {
                return cachedPreview;
            }
            const pdfDocument = this._pdfDocument;
            const resolutionScale = this._resolutionScale;
            const page = await this._getPage(destination.pageNumber);
            const baseViewport = page.getViewport({ scale: 1 });
            const baseTextBounds = await this._getPageTextBounds(destination.pageNumber, baseViewport);
            const baseCrop = getPreviewCrop(baseViewport, baseTextBounds);
            const displayWidth = this._getPreviewDisplayWidth();
            const desiredScale = displayWidth * resolutionScale / baseCrop.width;
            const maxPixelScale = Math.sqrt(MAX_PREVIEW_PIXELS / (baseCrop.width * baseCrop.height));
            const scale = Math.min(desiredScale, maxPixelScale);
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
            canvas.width = Math.round(crop.width);
            canvas.height = Math.round(crop.height);
            const context = canvas.getContext("2d", { alpha: false });
            if (!context) {
                return {
                    src: "",
                    targetXRatio: 0,
                    targetYRatio: 0
                };
            }
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            const renderTask = page.render({
                canvasContext: context,
                viewport: croppedViewport
            });
            this._activeRenderTask = renderTask;
            try {
                await renderTask.promise;
            }
            catch (error) {
                if (isRenderingCancelled(error)) {
                    return {
                        src: "",
                        targetXRatio: 0,
                        targetYRatio: 0
                    };
                }
                throw error;
            }
            finally {
                if (this._activeRenderTask === renderTask) {
                    this._activeRenderTask = null;
                }
            }
            drawPreviewTarget(context, point, crop, crop.width / displayWidth);
            if (this._pdfDocument !== pdfDocument || this._resolutionScale !== resolutionScale) {
                canvas.width = 0;
                canvas.height = 0;
                return {
                    src: "",
                    targetXRatio: 0,
                    targetYRatio: 0
                };
            }
            const image = {
                src: "",
                canvas,
                targetXRatio: clamp((point[0] - crop.left) / crop.width, 0, 1),
                targetYRatio: clamp((point[1] - crop.top) / crop.height, 0, 1)
            };
            this._reportDebug("linkPreviewRendered", {
                pageNumber: destination.pageNumber,
                durationMs: performance.now() - startedAt,
                sizeBytes: canvas.width * canvas.height * 4
            });
            const encodingStartedAt = performance.now();
            void canvasToPngBlob(canvas).then(blob => {
                if (this._pdfDocument !== pdfDocument || this._resolutionScale !== resolutionScale) {
                    return;
                }
                this._rememberImagePreview(key, {
                    src: URL.createObjectURL(blob),
                    targetXRatio: image.targetXRatio,
                    targetYRatio: image.targetYRatio
                });
                this._reportDebug("linkPreviewEncoded", {
                    pageNumber: destination.pageNumber,
                    durationMs: performance.now() - encodingStartedAt,
                    sizeBytes: blob.size
                });
            }).catch((error) => {
                console.warn("Failed to cache PDF link image preview.", error);
            });
            return image;
        }
        _reportDebug(event, fields) {
            if (!this._debug) {
                return;
            }
            window.dispatchEvent(new CustomEvent("academic-pdf-debug", {
                detail: { type: "pdf.debug", event, ...fields }
            }));
        }
        _getCachedImagePreview(destination) {
            const key = imagePreviewKey(destination);
            return getCachedEntry(this._previewCache, key);
        }
        _getPageTextContent(pageNumber) {
            const cached = getCachedEntry(this._textContentCache, pageNumber);
            if (cached) {
                return cached;
            }
            const promise = this._getPage(pageNumber)
                .then((page) => page.getTextContent());
            rememberBoundedEntry(this._textContentCache, pageNumber, promise, MAX_DOCUMENT_CACHE_ENTRIES);
            void promise.catch(() => {
                if (this._textContentCache.get(pageNumber) === promise) {
                    this._textContentCache.delete(pageNumber);
                }
            });
            return promise;
        }
        _getPage(pageNumber) {
            const cached = getCachedEntry(this._pageCache, pageNumber);
            if (cached) {
                return cached;
            }
            const promise = this._pdfDocument.getPage(pageNumber);
            rememberBoundedEntry(this._pageCache, pageNumber, promise, MAX_DOCUMENT_CACHE_ENTRIES);
            void promise.catch(() => {
                if (this._pageCache.get(pageNumber) === promise) {
                    this._pageCache.delete(pageNumber);
                }
            });
            return promise;
        }
        _getPreviewDisplayWidth() {
            const popupWidth = this._popup.clientWidth;
            if (popupWidth > 0) {
                return popupWidth;
            }
            return Math.max(1, Math.min(MAX_PREVIEW_DISPLAY_WIDTH, window.innerWidth - PREVIEW_VIEWPORT_MARGIN));
        }
        _rememberImagePreview(key, image) {
            const existing = this._previewCache.get(key);
            if (existing) {
                URL.revokeObjectURL(existing.src);
                this._previewCache.delete(key);
            }
            this._previewCache.set(key, image);
            while (this._previewCache.size > MAX_PREVIEW_CACHE_ENTRIES) {
                const oldestKey = this._previewCache.keys().next().value;
                if (oldestKey === undefined) {
                    return;
                }
                const oldest = this._previewCache.get(oldestKey);
                if (oldest) {
                    URL.revokeObjectURL(oldest.src);
                }
                this._previewCache.delete(oldestKey);
            }
        }
        _clearPreviewCache() {
            for (const image of this._previewCache.values()) {
                URL.revokeObjectURL(image.src);
            }
            this._previewCache.clear();
        }
        _cancelActiveRenderTask() {
            if (!this._activeRenderTask) {
                return;
            }
            this._activeRenderTask.cancel();
            this._activeRenderTask = null;
        }
        async _getPageTextBounds(pageNumber, viewport) {
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
        _clearAllOverlays() {
            for (const layer of this._pageLayers) {
                layer.remove();
            }
            this._pageLayers.clear();
            this._pageOverlays.clear();
        }
        _clearPageOverlays(pageDiv) {
            const layer = pageDiv.querySelector(".academic-citation-layer");
            if (layer) {
                layer.textContent = "";
                pageDiv.append(layer);
            }
            this._pageOverlays.delete(pageDiv);
        }
        _trackPageOverlay(pageDiv, overlay) {
            let overlays = this._pageOverlays.get(pageDiv);
            if (!overlays) {
                overlays = new Set();
                this._pageOverlays.set(pageDiv, overlays);
            }
            overlays.add(overlay);
        }
        _ensurePageLayer(pageDiv) {
            let layer = pageDiv.querySelector(".academic-citation-layer");
            if (!layer) {
                layer = document.createElement("div");
                layer.className = "academic-citation-layer";
                pageDiv.append(layer);
            }
            this._pageLayers.add(layer);
            return layer;
        }
    }
    function isInternalLinkAnnotation(annotation) {
        return annotation.subtype === "Link"
            && (Array.isArray(annotation.dest)
                || typeof annotation.dest === "string" && annotation.dest.length > 0)
            && Array.isArray(annotation.rect);
    }
    function isConfigureMessage(message) {
        return typeof message === "object"
            && message !== null
            && "type" in message
            && message.type === "linkPreview.configure"
            && "enabled" in message
            && typeof message.enabled === "boolean"
            && "resolutionScale" in message
            && typeof message.resolutionScale === "number"
            && Number.isFinite(message.resolutionScale);
    }
    function readInitialConfiguration() {
        const configElement = document.getElementById("pdf-preview-config");
        const config = configElement?.getAttribute("data-config");
        if (!config) {
            return { debug: false, enabled: true, resolutionScale: DEFAULT_RESOLUTION_SCALE };
        }
        try {
            const settings = JSON.parse(config);
            return {
                debug: settings.debug === true,
                enabled: settings.linkPreviewEnabled !== false,
                resolutionScale: normalizeResolutionScale(settings.linkPreviewResolutionScale)
            };
        }
        catch {
            return { debug: false, enabled: true, resolutionScale: DEFAULT_RESOLUTION_SCALE };
        }
    }
    function viewportRect(viewport, pdfRect) {
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
    function getDestinationPosition(destArray) {
        const kind = destArray[1]?.name;
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
    function numberOrNull(value) {
        return typeof value === "number" ? value : null;
    }
    function textPreviewKey(destination) {
        return `${destination.pageNumber}:${Math.round(destination.pdfY || 0)}`;
    }
    function imagePreviewKey(destination) {
        return `${destination.pageNumber}:${Math.round(destination.pdfX || 0)}:${Math.round(destination.pdfY || 0)}`;
    }
    function getCachedPageNumber(pdfDocument, destRef) {
        return typeof pdfDocument?.cachedPageNumber === "function"
            ? pdfDocument.cachedPageNumber(destRef)
            : null;
    }
    function collectNearbyLines(items, viewport, targetY) {
        const nearbyRows = [];
        const allRows = [];
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
            if (targetY === null || Math.abs(y - targetY) <= TEXT_RADIUS_PX) {
                nearbyRows.push(row);
            }
        }
        return collectNearbyLinesFromRows(allRows, targetY, {
            textRadiusPx: TEXT_RADIUS_PX,
            maxCandidateRows: 40,
            maxReturnedLines: 4,
        });
    }
    function getPreviewCrop(viewport, textBounds) {
        const fallbackMargin = viewport.width * PREVIEW_MARGIN_FALLBACK_RATIO;
        let left = fallbackMargin;
        let right = viewport.width - fallbackMargin;
        if (textBounds) {
            const leftMargin = textBounds.left;
            const rightMargin = viewport.width - textBounds.right;
            const balancedMargin = Math.max(leftMargin, rightMargin);
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
    function scalePreviewCrop(crop, scale) {
        return {
            left: crop.left * scale,
            top: crop.top * scale,
            width: crop.width * scale,
            height: crop.height * scale
        };
    }
    function drawPreviewTarget(context, point, crop, pixelDensity) {
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
    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }
    function clamp(value, min, max) {
        return Math.min(Math.max(value, min), max);
    }
    function containsClientPoint(rect, x, y) {
        return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }
    function normalizeResolutionScale(value) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return DEFAULT_RESOLUTION_SCALE;
        }
        return clamp(value, MIN_RESOLUTION_SCALE, MAX_RESOLUTION_SCALE);
    }
    function getCachedEntry(cache, key) {
        const value = cache.get(key);
        if (value !== undefined) {
            cache.delete(key);
            cache.set(key, value);
        }
        return value;
    }
    function rememberBoundedEntry(cache, key, value, maximumEntries) {
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
    function canvasToPngBlob(canvas) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(blob => {
                if (blob) {
                    resolve(blob);
                }
                else {
                    reject(new Error("Could not encode the PDF link preview image."));
                }
            }, "image/png");
        });
    }
    function isRenderingCancelled(error) {
        return error instanceof Error && error.name === "RenderingCancelledException";
    }
    function preventDefaultDrag(event) {
        event.preventDefault();
        event.stopPropagation();
    }
    function choosePopupPlacement(anchorRect, popupRect, margin) {
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
        let best = null;
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
    function scorePlacement(position, popupRect, margin) {
        const left = position.left;
        const top = position.top;
        const right = left + popupRect.width;
        const bottom = top + popupRect.height;
        const visibleWidth = Math.max(0, Math.min(right, window.innerWidth - margin) - Math.max(left, margin));
        const visibleHeight = Math.max(0, Math.min(bottom, window.innerHeight - margin) - Math.max(top, margin));
        const overflow = Math.max(0, margin - left)
            + Math.max(0, margin - top)
            + Math.max(0, right - (window.innerWidth - margin))
            + Math.max(0, bottom - (window.innerHeight - margin));
        return visibleWidth * visibleHeight - overflow * 10000;
    }
    async function initialize() {
        const app = pdfjsAdapter.getApplication();
        if (!app) {
            return;
        }
        await app.initializedPromise;
        const controller = new CitationPreviewController(app);
        controller.initialize();
    }
    let initializationStarted = false;
    function startInitialization() {
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
