/// <reference path="./globals.d.ts" />
"use strict";
(function () {
    const OPEN_DELAY_MS = 120;
    const CLOSE_DELAY_MS = 120;
    const TEXT_RADIUS_PX = 90;
    const MIN_PREVIEW_SCALE = 1.25;
    const MAX_PREVIEW_SCALE = 3.2;
    const MAX_PREVIEW_PIXELS = 25600000;
    const PREVIEW_MARGIN_FALLBACK_RATIO = 0.08;
    const TEXT_BOUND_PADDING_PX = 28;
    const PREVIEW_TARGET_RADIUS = 10;
    const HIT_PADDING_PX = 2;
    const MIN_HIT_HEIGHT_PX = 10;
    const SCALE_RENDER_DEBOUNCE_MS = 140;
    const MAX_PREVIEW_CACHE_ENTRIES = 16;
    const WHEEL_ZOOM_SUPPRESS_HOVER_MS = 260;
    class HoverDelayer {
        _openTimer;
        _closeTimer;
        constructor() {
            this._openTimer = null;
            this._closeTimer = null;
        }
        open(callback) {
            this.cancelClose();
            this.cancelOpen();
            this._openTimer = setTimeout(() => {
                this._openTimer = null;
                callback();
            }, OPEN_DELAY_MS);
        }
        close(callback) {
            this.cancelOpen();
            if (this._closeTimer) {
                return;
            }
            this._closeTimer = setTimeout(() => {
                this._closeTimer = null;
                callback();
            }, CLOSE_DELAY_MS);
        }
        cancelOpen() {
            if (!this._openTimer) {
                return;
            }
            clearTimeout(this._openTimer);
            this._openTimer = null;
        }
        cancelClose() {
            if (!this._closeTimer) {
                return;
            }
            clearTimeout(this._closeTimer);
            this._closeTimer = null;
        }
    }
    class CitationPreviewController {
        _app;
        _eventBus;
        _pdfDocument;
        _hoverDelayer;
        _previewCache;
        _textCache;
        _pageCache;
        _annotationCache;
        _textContentCache;
        _pageRenderIds;
        _previewRequestId;
        _popup;
        _scaleRenderTimer;
        _suppressHoverUntil;
        _activeRenderTask;
        constructor(app) {
            this._app = app;
            this._eventBus = app.eventBus;
            this._pdfDocument = null;
            this._hoverDelayer = new HoverDelayer();
            this._previewCache = new Map();
            this._textCache = new Map();
            this._pageCache = new Map();
            this._annotationCache = new Map();
            this._textContentCache = new Map();
            this._pageRenderIds = new Map();
            this._previewRequestId = 0;
            this._popup = this._createPopup();
            this._scaleRenderTimer = null;
            this._suppressHoverUntil = 0;
            this._activeRenderTask = null;
        }
        initialize() {
            this._eventBus.on("documentloaded", () => {
                this._pdfDocument = this._app.pdfDocument;
                this._clearPreviewCache();
                this._textCache.clear();
                this._pageCache.clear();
                this._annotationCache.clear();
                this._textContentCache.clear();
                this._pageRenderIds.clear();
                this._cancelScheduledScaleRender();
                this._hidePopup();
                this._clearAllOverlays();
                this._renderVisiblePages();
            });
            this._eventBus.on("pagerendered", (event) => {
                if (event.cssTransform) {
                    this._scheduleScaleRender();
                    return;
                }
                this._renderPage(event.pageNumber);
            });
            this._eventBus.on("scalechanged", () => {
                this._hidePopup();
                this._scheduleScaleRender();
            });
            window.addEventListener("academic-pdf-wheel-zoom", () => {
                this._suppressHoverUntil = performance.now() + WHEEL_ZOOM_SUPPRESS_HOVER_MS;
                this._hidePopup();
            });
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
            for (const pageView of getPdfViewerPages(this._app.pdfViewer)) {
                if (pageView && pageView.renderingState === 3) {
                    this._renderPage(pageView.id);
                }
            }
        }
        async _renderPage(pageNumber) {
            if (!this._pdfDocument) {
                return;
            }
            const renderId = (this._pageRenderIds.get(pageNumber) || 0) + 1;
            this._pageRenderIds.set(pageNumber, renderId);
            const pageView = this._app.pdfViewer.getPageView(pageNumber - 1);
            if (!pageView || !pageView.div || !pageView.viewport) {
                return;
            }
            this._clearPageOverlays(pageView.div);
            const annotations = await this._getPageAnnotations(pageNumber);
            if (this._pageRenderIds.get(pageNumber) !== renderId) {
                return;
            }
            for (const annotation of annotations) {
                if (!isInternalLinkAnnotation(annotation)) {
                    continue;
                }
                this._appendOverlay(pageView, annotation, pageNumber);
            }
        }
        _getPageAnnotations(pageNumber) {
            const cached = this._annotationCache.get(pageNumber);
            if (cached) {
                return cached;
            }
            const promise = this._getPage(pageNumber)
                .then((page) => page.getAnnotations({ intent: "display" }))
                .catch((error) => {
                this._annotationCache.delete(pageNumber);
                throw error;
            });
            this._annotationCache.set(pageNumber, promise);
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
            overlay.setAttribute("aria-label", "Preview PDF link destination");
            const link = {
                id: `${pageNumber}:${annotation.id || JSON.stringify(annotation.rect)}`,
                sourcePageNumber: pageNumber,
                rect,
                dest: annotation.dest
            };
            overlay.addEventListener("pointerenter", () => {
                if (this._isHoverSuppressed()) {
                    return;
                }
                this._hoverDelayer.open(() => this._showPopup(overlay, link));
            });
            overlay.addEventListener("pointerleave", () => {
                this._hoverDelayer.close(() => this._hidePopup());
            });
            overlay.addEventListener("click", (event) => {
                event.preventDefault();
                event.stopPropagation();
                this._hidePopup();
                this._app.pdfLinkService.goToDestination(link.dest);
            });
            layer.append(overlay);
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
            const cachedText = this._textCache.get(textPreviewKey(destination));
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
            this._renderPopupContent(destination, text, image?.src ? image : null, anchor);
        }
        _renderPopupContent(destination, text, image, anchor) {
            this._popup.innerHTML = `
        <div class="academic-citation-popup__meta">Page ${destination.pageNumber}</div>
        ${image ? `<div class="academic-citation-popup__preview"><img class="academic-citation-popup__image" src="${image.src}" alt="" draggable="false"></div>` : ""}
        <div class="academic-citation-popup__text">${escapeHtml(text || "No nearby text found.")}</div>
      `;
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
            this._popup.classList.remove("is-open");
            this._popup.innerHTML = "";
        }
        _createPopup() {
            const popup = document.createElement("div");
            popup.className = "academic-citation-popup";
            popup.draggable = false;
            popup.addEventListener("dragstart", preventDefaultDrag);
            popup.addEventListener("wheel", (event) => {
                event.stopPropagation();
            }, { passive: false });
            popup.addEventListener("pointerenter", () => this._hoverDelayer.cancelClose());
            popup.addEventListener("pointerleave", () => {
                this._hoverDelayer.close(() => this._hidePopup());
            });
            document.body.append(popup);
            return popup;
        }
        _bindPreviewScroll(image, anchor) {
            const preview = this._popup.querySelector(".academic-citation-popup__preview");
            if (!preview) {
                return;
            }
            preview.addEventListener("wheel", (event) => {
                event.preventDefault();
                event.stopPropagation();
                preview.scrollTop += event.deltaY;
                preview.scrollLeft += event.deltaX;
            }, { passive: false });
            if (!image) {
                return;
            }
            const previewImage = preview.querySelector(".academic-citation-popup__image");
            const settlePreview = () => {
                this._positionPopup(anchor);
                preview.scrollTop = Math.max(0, preview.scrollHeight * image.targetYRatio - preview.clientHeight * 0.32);
                preview.scrollLeft = Math.max(0, preview.scrollWidth * image.targetXRatio - preview.clientWidth * 0.5);
            };
            if (previewImage && previewImage.complete) {
                requestAnimationFrame(settlePreview);
            }
            else if (previewImage) {
                previewImage.addEventListener("load", () => requestAnimationFrame(settlePreview), { once: true });
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
            if (Number.isInteger(destRef)) {
                pageNumber = destRef + 1;
            }
            else if (destRef && typeof destRef === "object") {
                pageNumber = getCachedPageNumber(this._app.pdfLinkService, destRef);
                if (!pageNumber) {
                    pageNumber = (await this._pdfDocument.getPageIndex(destRef)) + 1;
                    this._app.pdfLinkService.cachePageRef(pageNumber, destRef);
                }
            }
            if (!Number.isInteger(pageNumber)) {
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
            const cachedText = this._textCache.get(key);
            if (cachedText !== undefined) {
                return cachedText;
            }
            const page = await this._getPage(destination.pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const targetY = Number.isFinite(destination.pdfY)
                ? viewport.convertToViewportPoint(destination.pdfX || 0, destination.pdfY)[1]
                : null;
            const textContent = await this._getPageTextContent(destination.pageNumber);
            const lines = collectNearbyLines(textContent.items, viewport, targetY);
            const text = lines.slice(0, 4).join(" ");
            this._textCache.set(key, text);
            return text;
        }
        async _getImagePreview(destination) {
            const key = imagePreviewKey(destination);
            const cachedPreview = this._getCachedImagePreview(destination);
            if (cachedPreview) {
                return cachedPreview;
            }
            const page = await this._getPage(destination.pageNumber);
            let scale = getPreviewScale(this._app.pdfViewer);
            let viewport = page.getViewport({ scale });
            let point = Number.isFinite(destination.pdfY)
                ? viewport.convertToViewportPoint(destination.pdfX || 0, destination.pdfY)
                : [0, 0];
            let textBounds = await this._getPageTextBounds(destination.pageNumber, viewport);
            let crop = getPreviewCrop(viewport, textBounds);
            const maxPixelScale = Math.sqrt(MAX_PREVIEW_PIXELS / (crop.width * crop.height));
            if (maxPixelScale < 1) {
                scale *= maxPixelScale;
                viewport = page.getViewport({ scale });
                point = Number.isFinite(destination.pdfY)
                    ? viewport.convertToViewportPoint(destination.pdfX || 0, destination.pdfY)
                    : [0, 0];
                textBounds = await this._getPageTextBounds(destination.pageNumber, viewport);
                crop = getPreviewCrop(viewport, textBounds);
            }
            const croppedViewport = page.getViewport({
                scale,
                offsetX: -crop.left,
                offsetY: -crop.top
            });
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(crop.width);
            canvas.height = Math.round(crop.height);
            canvas.style.width = `${crop.width}px`;
            canvas.style.height = `${crop.height}px`;
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
            drawPreviewTarget(context, point, crop);
            const dataUrl = canvas.toDataURL("image/png");
            canvas.width = 0;
            canvas.height = 0;
            const image = {
                src: dataUrl,
                targetXRatio: clamp((point[0] - crop.left) / crop.width, 0, 1),
                targetYRatio: clamp((point[1] - crop.top) / crop.height, 0, 1)
            };
            this._rememberImagePreview(key, image);
            return image;
        }
        _getCachedImagePreview(destination) {
            const key = imagePreviewKey(destination);
            const cachedPreview = this._previewCache.get(key);
            if (cachedPreview !== undefined) {
                this._previewCache.delete(key);
                this._previewCache.set(key, cachedPreview);
            }
            return cachedPreview;
        }
        _getPageTextContent(pageNumber) {
            const cached = this._textContentCache.get(pageNumber);
            if (cached) {
                return cached;
            }
            const promise = this._getPage(pageNumber)
                .then((page) => page.getTextContent())
                .catch((error) => {
                this._textContentCache.delete(pageNumber);
                throw error;
            });
            this._textContentCache.set(pageNumber, promise);
            return promise;
        }
        _getPage(pageNumber) {
            const cached = this._pageCache.get(pageNumber);
            if (cached) {
                return cached;
            }
            const promise = this._pdfDocument.getPage(pageNumber)
                .catch((error) => {
                this._pageCache.delete(pageNumber);
                throw error;
            });
            this._pageCache.set(pageNumber, promise);
            return promise;
        }
        _rememberImagePreview(key, image) {
            if (this._previewCache.has(key)) {
                this._previewCache.delete(key);
            }
            this._previewCache.set(key, image);
            while (this._previewCache.size > MAX_PREVIEW_CACHE_ENTRIES) {
                const oldestKey = this._previewCache.keys().next().value;
                if (oldestKey === undefined) {
                    return;
                }
                this._previewCache.delete(oldestKey);
            }
        }
        _clearPreviewCache() {
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
                if (!item.str || !item.str.trim()) {
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
            for (const layer of document.querySelectorAll(".academic-citation-layer")) {
                layer.remove();
            }
        }
        _clearPageOverlays(pageDiv) {
            const layer = pageDiv.querySelector(".academic-citation-layer");
            if (layer) {
                layer.textContent = "";
                pageDiv.append(layer);
            }
        }
        _ensurePageLayer(pageDiv) {
            let layer = pageDiv.querySelector(".academic-citation-layer");
            if (!layer) {
                layer = document.createElement("div");
                layer.className = "academic-citation-layer";
            }
            pageDiv.append(layer);
            return layer;
        }
    }
    function isInternalLinkAnnotation(annotation) {
        return annotation
            && annotation.subtype === "Link"
            && annotation.dest
            && Array.isArray(annotation.rect);
    }
    function viewportRect(viewport, pdfRect) {
        const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(pdfRect);
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
    function getPdfViewerPages(pdfViewer) {
        return Array.isArray(pdfViewer?._pages) ? pdfViewer._pages : [];
    }
    function getCachedPageNumber(pdfLinkService, destRef) {
        return typeof pdfLinkService?._cachedPageNumber === "function"
            ? pdfLinkService._cachedPageNumber(destRef)
            : null;
    }
    function collectNearbyLines(items, viewport, targetY) {
        const rows = [];
        for (const item of items) {
            if (!item.str || !item.str.trim()) {
                continue;
            }
            const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
            const y = transform[5];
            if (targetY !== null && Math.abs(y - targetY) > TEXT_RADIUS_PX) {
                continue;
            }
            rows.push({
                text: item.str.trim(),
                x: transform[4],
                y
            });
        }
        if (rows.length === 0 && targetY !== null) {
            return collectNearbyLines(items, viewport, null).slice(0, 4);
        }
        rows.sort((a, b) => Math.abs(a.y - (targetY ?? a.y)) - Math.abs(b.y - (targetY ?? b.y)) || a.y - b.y || a.x - b.x);
        const selected = rows.slice(0, 40);
        selected.sort((a, b) => a.y - b.y || a.x - b.x);
        const lines = [];
        for (const row of selected) {
            const last = lines[lines.length - 1];
            if (!last || Math.abs(last.y - row.y) > 4) {
                lines.push({ y: row.y, parts: [row] });
            }
            else {
                last.parts.push(row);
            }
        }
        return lines.map(line => line.parts
            .sort((a, b) => a.x - b.x)
            .map(part => part.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim())
            .filter(Boolean);
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
    function getPreviewScale(pdfViewer) {
        const currentScale = Number.isFinite(pdfViewer.currentScale) ? pdfViewer.currentScale : 1;
        const scale = currentScale > 1
            ? 1 + (currentScale - 1) * 1.5
            : MIN_PREVIEW_SCALE;
        const preferredScale = clamp(scale * Math.min(window.devicePixelRatio || 1, 2), MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE);
        return preferredScale;
    }
    function drawPreviewTarget(context, point, crop) {
        const x = clamp(point[0] - crop.left, PREVIEW_TARGET_RADIUS + 2, crop.width - PREVIEW_TARGET_RADIUS - 2);
        const y = clamp(point[1] - crop.top, PREVIEW_TARGET_RADIUS + 2, crop.height - PREVIEW_TARGET_RADIUS - 2);
        context.save();
        context.globalCompositeOperation = "multiply";
        context.fillStyle = "#f57b7b";
        context.beginPath();
        context.arc(x, y, PREVIEW_TARGET_RADIUS, 0, Math.PI * 2);
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
        const app = window.PDFViewerApplication;
        if (!app) {
            return;
        }
        await app.initializedPromise;
        const controller = new CitationPreviewController(app);
        controller.initialize();
    }
    initialize().catch(error => {
        console.error("Failed to initialize Academic PDF citation preview layer.", error);
    });
}());
