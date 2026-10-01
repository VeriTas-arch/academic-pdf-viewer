import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { loadSource } = createRequire(import.meta.url)("./helpers/extensionSource.cjs");
const fixturePath = "/test/fixtures/viewer-smoke.pdf";

test("bundled PDF.js viewer preserves extension behavior", { timeout: 60_000 }, async t => {
    const html = await buildViewerHtml();
    const diffHtml = await buildViewerHtml({
        diffRole: "modified",
        diffLabel: "Working tree"
    });
    const originalDiffHtml = await buildViewerHtml({
        diffRole: "original",
        diffLabel: "Index"
    });
    const outlineSidebarHtml = await buildViewerHtml({
        defaultSidebar: "outline"
    });
    const server = createServer((request, response) => {
        void serveRequest(
            request.url || "/",
            html,
            diffHtml,
            originalDiffHtml,
            outlineSidebarHtml,
            response
        );
    });
    await new Promise((resolvePromise, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolvePromise);
    });
    t.after(() => new Promise(resolvePromise => server.close(resolvePromise)));

    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch(await browserLaunchOptions());
    t.after(() => browser.close());
    const page = await browser.newPage();
    const pageErrors = [];
    const failedRequests = [];
    const externalRequests = [];
    const httpErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("requestfailed", request => failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`));
    page.on("response", response => {
        if (response.status() >= 400) {
            httpErrors.push(`${response.status()} ${response.url()}`);
        }
    });
    await page.route("**/*", route => {
        const url = route.request().url();
        if (url.startsWith(origin) || url.startsWith("blob:") || url.startsWith("data:")) {
            return route.continue();
        }
        if (!externalRequests.includes(url)) {
            externalRequests.push(url);
        }
        return route.abort("blockedbyclient");
    });

    await page.goto(`${origin}/__viewer_test__.html`);
    await page.waitForFunction(() => window.__academicTestMessages.some(message => message.type === "webview.ready"));
    await page.evaluate(async pdfPath => {
        const data = await (await fetch(pdfPath)).arrayBuffer();
        window.postMessage({
            type: "document.load",
            loadId: 1,
            data,
            isEmptyRevision: false,
            fingerprint: "viewer-smoke",
            preserveView: false
        }, "*");
    }, fixturePath);
    await page.waitForFunction(() => window.__academicTestDebug.some(message => message.event === "firstPageRendered"));

    await t.test("starts offline with the bundled Worker", async () => {
        assert.deepEqual(externalRequests, []);
        assert.deepEqual(failedRequests, []);
        assert.deepEqual(httpErrors, []);
        assert.deepEqual(pageErrors, []);
        assert.equal(await page.evaluate(() => window.PDFViewerApplication.pdfDocument?.numPages), 2);
        assert.equal(await page.evaluate(() => {
            const adapter = window.academicPdfJsAdapter;
            const viewer = adapter.getViewer();
            return adapter.getApplication() === window.PDFViewerApplication
                && adapter.getViewerContainer(viewer) === document.getElementById("viewerContainer")
                && adapter.getToolbarHost() === document.getElementById("toolbarViewerLeft")
                && viewer !== null
                && adapter.getPageViews(viewer).length === 2;
        }), true);
        assert.deepEqual(await page.evaluate(() => window.academicPdfJsAdapter.getCapabilities()), {
            viewer: true,
            viewerContainer: true,
            toolbarHost: true,
            location: true,
            fingerprintOverride: true,
            pageNumberInterception: true,
            sidebarView: true,
        });
        assert.equal(await page.evaluate(() => window.__academicTestDebug.some(message =>
            message.event === "viewerInitialized" && message.workerSource === "blob"
        )), true);
    });

    await t.test("centers stronger PDF link borders on their rectangles without moving click targets", async t => {
        const borderPage = await browser.newPage({ deviceScaleFactor: 1.25 });
        t.after(() => borderPage.close());
        const errors = [];
        borderPage.on("pageerror", error => errors.push(error.message));
        await borderPage.goto(`${origin}/__viewer_test__.html`);
        await borderPage.waitForFunction(() => window.__academicTestMessages.some(
            message => message.type === "webview.ready"
        ));

        for (const userUnit of [1, 2]) {
            await borderPage.evaluate(({ bytes, loadId }) => {
                window.postMessage({
                    type: "document.load",
                    loadId,
                    data: new Uint8Array(bytes).buffer,
                    isEmptyRevision: false,
                    fingerprint: `link-borders-${loadId}`,
                    preserveView: false
                }, "*");
            }, { bytes: Array.from(createLinkBorderPdf(userUnit)), loadId: userUnit });
            await borderPage.waitForFunction(loadId => window.__academicTestDebug.some(
                message => message.event === "firstPageRendered"
                    && message.fingerprint === `link-borders-${loadId}`
            ), userUnit);
            await borderPage.locator('.annotationLayer .linkAnnotation[data-annotation-id="6R"]').waitFor();

            // Return to the initial zoom and rotate to catch cumulative scaling or recreation bugs.
            for (const [scale, rotation] of [[0.75, 0], [1.25, 0], [1.5, 0], [3, 90], [1.5, 180], [1.25, 270], [0.75, 0]]) {
                await borderPage.evaluate(({ scale, rotation }) => {
                    const viewer = window.PDFViewerApplication.pdfViewer;
                    viewer.currentScaleValue = String(scale);
                    viewer.pagesRotation = rotation;
                }, { scale, rotation });
                await borderPage.waitForFunction(() => {
                    const view = window.PDFViewerApplication.pdfViewer.getPageView(0);
                    return view.renderingState === 3 && !view.div.querySelector(".annotationLayer")?.hidden;
                });
                const borders = await borderPage.locator(".annotationLayer .linkAnnotation").evaluateAll(elements =>
                    elements.map(element => {
                        const frame = element.querySelector(".academic-link-border") || element;
                        const style = getComputedStyle(frame);
                        const rect = element.getBoundingClientRect();
                        const frameRect = frame.getBoundingClientRect();
                        const anchorRect = element.querySelector("a").getBoundingClientRect();
                        return {
                            width: parseFloat(style.borderBottomWidth),
                            topWidth: parseFloat(style.borderTopWidth),
                            style: style.borderBottomStyle,
                            color: style.borderBottomColor,
                            clickOffsets: ["left", "top", "right", "bottom"].map(side => anchorRect[side] - rect[side]),
                            strokeOffsets: [
                                frameRect.left + parseFloat(style.borderLeftWidth) / 2 - rect.left,
                                frameRect.top + parseFloat(style.borderTopWidth) / 2 - rect.top,
                                frameRect.right - parseFloat(style.borderRightWidth) / 2 - rect.right,
                                frameRect.bottom - parseFloat(style.borderBottomWidth) / 2 - rect.bottom
                            ]
                        };
                    })
                );
                const unit = scale * 4 / 3 * userUnit;
                assert.equal(borders.length, 5);
                for (const [index, width, style] of [[0, 1, "solid"], [1, 2, "dashed"], [2, 1, "solid"]]) {
                    assert(Math.abs(borders[index].width - width * unit * 1.5) < 1,
                        `link ${index}, zoom ${scale}, rotation ${rotation}, UserUnit ${userUnit}`);
                    assert.equal(borders[index].style, style);
                    assert.equal(borders[index].color, "rgb(0, 255, 0)");
                    const offsets = index === 2 ? [borders[index].strokeOffsets[3]] : borders[index].strokeOffsets;
                    assert(offsets.every(offset => Math.abs(offset) < 0.6), `stroke alignment: ${JSON.stringify(borders[index])}`);
                    assert(borders[index].clickOffsets.every(offset => Math.abs(offset) < 0.05),
                        `click rectangle: ${JSON.stringify(borders[index])}`);
                }
                assert.equal(borders[2].topWidth, 0, "underline must remain bottom-only");
                assert.equal(borders[3].width, 0, "zero-width link must stay borderless");
                assert.equal(borders[4].width, 0, "transparent link must stay borderless");
                const coordinateErrors = await borderPage.evaluate(async () => {
                    const view = window.PDFViewerApplication.pdfViewer.getPageView(0);
                    const canvas = view.div.querySelector(".canvasWrapper").getBoundingClientRect();
                    const annotations = await view.pdfPage.getAnnotations();
                    return annotations.filter(annotation => annotation.subtype === "Link").flatMap(annotation => {
                        const rect = view.div.querySelector(`[data-annotation-id="${annotation.id}"]`).getBoundingClientRect();
                        const [x1, y1] = view.viewport.convertToViewportPoint(annotation.rect[0], annotation.rect[1]);
                        const [x2, y2] = view.viewport.convertToViewportPoint(annotation.rect[2], annotation.rect[3]);
                        return [rect.left - canvas.left - Math.min(x1, x2), rect.top - canvas.top - Math.min(y1, y2),
                            rect.right - canvas.left - Math.max(x1, x2), rect.bottom - canvas.top - Math.max(y1, y2)];
                    });
                });
                assert(coordinateErrors.every(error => Math.abs(error) < 0.1), `PDF coordinates: ${coordinateErrors}`);
                await borderPage.evaluate(() => {
                    window.academicPdfJsAdapter.scaleLinkBorders(window.PDFViewerApplication.pdfViewer.getPageView(0));
                });
                assert.equal(await borderPage.locator(".academic-link-border").count(), 3, "repeated updates must not duplicate borders");
            }
        }
        assert.deepEqual(errors, []);
    });

    await t.test("adapts preview pixels to content width, DPI and cached image quality", async t => {
        const previewPage = await browser.newPage({ viewport: { width: 600, height: 900 }, deviceScaleFactor: 1.25 });
        previewPage.setDefaultTimeout(5_000);
        t.after(() => previewPage.close());
        const errors = [];
        previewPage.on("pageerror", error => errors.push(error.message));
        await previewPage.goto(`${origin}/__viewer_test__.html`);
        // Headless Chromium normally overlays scrollbars; exercise the reserved gutter too.
        await previewPage.addStyleTag({ content: ".academic-citation-popup__preview { scrollbar-gutter: stable; }" });
        await previewPage.waitForFunction(() => window.__academicTestMessages.some(m => m.type === "webview.ready"));
        await previewPage.evaluate(bytes => window.postMessage({
            type: "document.load", loadId: 1, data: new Uint8Array(bytes).buffer,
            isEmptyRevision: false, fingerprint: "preview-resolution", preserveView: false
        }, "*"), Array.from(createLinkBorderPdf(1)));
        await previewPage.locator(".academic-citation-link").first().waitFor();
        await previewPage.evaluate(() => {
            window.PDFViewerApplication.pdfViewer.currentScaleValue = "0.75";
            window.postMessage({ type: "linkPreview.configure", enabled: true, resolutionScale: 0 }, "*");
        });
        const openPreview = async () => {
            await previewPage.waitForFunction(() => {
                const link = document.querySelector(".academic-citation-link");
                if (!link) {
                    return false;
                }
                const rect = link.getBoundingClientRect();
                link.dispatchEvent(new PointerEvent("pointermove", {
                    bubbles: true, clientX: rect.x + rect.width / 2,
                    clientY: rect.y + rect.height / 2, ctrlKey: true
                }));
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", bubbles: true }));
                return true;
            });
            await waitForPreview(previewPage);
            await previewPage.waitForFunction(() => {
                const image = document.querySelector(".academic-citation-popup__image");
                return image instanceof HTMLCanvasElement || image instanceof HTMLImageElement && image.complete;
            });
            await previewPage.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        };
        const readImage = () => previewPage.evaluate(() => {
            const image = document.querySelector(".academic-citation-popup__image");
            const preview = image.parentElement;
            const width = image.getBoundingClientRect().width;
            return {
                pixels: image instanceof HTMLImageElement ? image.naturalWidth : image.width,
                height: image instanceof HTMLImageElement ? image.naturalHeight : image.height,
                width, popupWidth: document.querySelector(".academic-citation-popup").clientWidth,
                scroll: preview.scrollTop / width,
                renders: window.__academicTestDebug.filter(m => m.event === "linkPreviewRendered").length
            };
        });
        await openPreview();
        const initial = await readImage();
        assert(Math.abs(initial.pixels - Math.ceil(initial.width * 2)) <= 1, JSON.stringify(initial));
        assert(initial.width < initial.popupWidth, "fixture must exercise scrollbar width");
        await previewPage.waitForFunction(() => window.__academicTestDebug.some(m => m.event === "linkPreviewEncoded"));
        await previewPage.evaluate(() => window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" })));
        await openPreview();
        const cached = await readImage();
        assert.equal(cached.renders, initial.renders);
        assert.equal(cached.pixels, initial.pixels);
        assert.equal(cached.width, initial.width);
        assert.equal(cached.scroll, initial.scroll, "cached image must retain the destination position");

        await previewPage.evaluate(() => { document.querySelector(".academic-citation-popup__preview").scrollTop = 120; });
        const beforeResize = await readImage();
        await previewPage.setViewportSize({ width: 1200, height: 900 });
        await previewPage.waitForFunction(previous => {
            const image = document.querySelector(".academic-citation-popup__image");
            return image && (image.naturalWidth || image.width) > previous;
        }, initial.pixels);
        await previewPage.evaluate(() => new Promise(requestAnimationFrame));
        const resized = await readImage();
        assert(Math.abs(resized.pixels - Math.ceil(resized.width * 2)) <= 1, JSON.stringify(resized));
        assert(Math.abs(resized.scroll - beforeResize.scroll) < 0.005, JSON.stringify({ beforeResize, resized }));

        const cdp = await previewPage.context().newCDPSession(previewPage);
        // CDP changes DPR without notifying media queries unless viewport metrics also change.
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 901, deviceScaleFactor: 3, mobile: false });
        await previewPage.waitForFunction(() => {
            const image = document.querySelector(".academic-citation-popup__image");
            return image && (image.naturalWidth || image.width) >= image.getBoundingClientRect().width * 3 - 1;
        });
        const highDpi = await readImage();
        assert(Math.abs(highDpi.pixels - Math.ceil(highDpi.width * 3)) <= 1, JSON.stringify(highDpi));
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 1.25, mobile: false });
        await previewPage.waitForTimeout(250);
        assert.equal((await readImage()).renders, highDpi.renders, "lower DPI should reuse sufficient pixels");

        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 901, deviceScaleFactor: 8, mobile: false });
        await previewPage.waitForFunction(previous => {
            const image = document.querySelector(".academic-citation-popup__image");
            return image && (image.naturalWidth || image.width) > previous;
        }, highDpi.pixels);
        const capped = await readImage();
        assert(capped.pixels * capped.height <= 25_600_000, JSON.stringify(capped));
        assert(capped.pixels < capped.width * 8, "pixel budget must cap the requested density");
        await previewPage.waitForTimeout(350);
        assert.equal((await readImage()).renders, capped.renders, "pixel cap must not cause repeated rendering");

        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 900, deviceScaleFactor: 3, mobile: false });
        await previewPage.evaluate(() => window.postMessage({ type: "linkPreview.configure", enabled: true, resolutionScale: 1 }, "*"));
        await openPreview();
        const manual = await readImage();
        assert(Math.abs(manual.pixels - Math.ceil(manual.width)) <= 1, JSON.stringify(manual));
        assert.deepEqual(errors, []);
    });

    await t.test("routes VS Code-owned shortcuts to the workbench", async () => {
        for (const [shortcut, messageType] of [
            ["Control+P", "workbench.quickOpen"],
            ["Control+Shift+P", "workbench.showCommands"],
            ["Control+O", "workbench.openFile"]
        ]) {
            await page.keyboard.press(shortcut);
            await page.waitForFunction(type => window.__academicTestMessages.some(
                message => message.type === type
            ), messageType);
        }
        assert.equal(await page.evaluate(() => window.__academicPrintCalls), 0);
    });

    await t.test("routes mouse side buttons through PDF navigation", async () => {
        const defaultPrevented = await page.evaluate(() => {
            const results = [];
            for (const button of [3, 4]) {
                for (const type of ["mouseup", "auxclick"]) {
                    const event = new MouseEvent(type, {
                        bubbles: true,
                        button,
                        cancelable: true
                    });
                    document.body.dispatchEvent(event);
                    results.push(event.defaultPrevented);
                }
            }
            return results;
        });
        assert.deepEqual(defaultPrevented, [true, true, true, true]);

        const cdp = await page.context().newCDPSession(page);
        const clickSideButton = async (button, buttons) => {
            const event = { x: 900, y: 360, button, clickCount: 1 };
            await cdp.send("Input.dispatchMouseEvent", {
                ...event,
                type: "mousePressed",
                buttons
            });
            await cdp.send("Input.dispatchMouseEvent", {
                ...event,
                type: "mouseReleased",
                buttons: 0
            });
        };

        const start = await page.evaluate(() => window.__academicTestMessages.length);
        await clickSideButton("back", 8);
        await clickSideButton("forward", 16);
        await page.waitForFunction(offset => window.__academicTestMessages.length >= offset + 2, start);
        assert.deepEqual(await page.evaluate(offset => window.__academicTestMessages
            .slice(offset)
            .filter(message => message.type === "navigation.request"), start), [
            { type: "navigation.request", direction: "back" },
            { type: "navigation.request", direction: "forward" }
        ]);

        const disabled = await page.evaluate(() => {
            window.dispatchEvent(new MessageEvent("message", {
                data: {
                    type: "navigation.configure",
                    mouseButtonsEnabled: false,
                    mouseButtonMapping: "standard"
                }
            }));
            const messageCount = window.__academicTestMessages.length;
            const event = new MouseEvent("mousedown", {
                bubbles: true,
                button: 3,
                cancelable: true
            });
            document.body.dispatchEvent(event);
            window.dispatchEvent(new MessageEvent("message", {
                data: {
                    type: "navigation.configure",
                    mouseButtonsEnabled: true,
                    mouseButtonMapping: "swapped"
                }
            }));
            return {
                defaultPrevented: event.defaultPrevented,
                navigationRequests: window.__academicTestMessages
                    .slice(messageCount)
                    .filter(message => message.type === "navigation.request")
            };
        });
        assert.deepEqual(disabled, {
            defaultPrevented: false,
            navigationRequests: []
        });

        const swappedStart = await page.evaluate(() => window.__academicTestMessages.length);
        await clickSideButton("back", 8);
        await clickSideButton("forward", 16);
        await page.waitForFunction(offset => window.__academicTestMessages.length >= offset + 2, swappedStart);
        assert.deepEqual(await page.evaluate(offset => window.__academicTestMessages
            .slice(offset)
            .filter(message => message.type === "navigation.request"), swappedStart), [
            { type: "navigation.request", direction: "forward" },
            { type: "navigation.request", direction: "back" }
        ]);

        await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", {
            data: {
                type: "navigation.configure",
                mouseButtonsEnabled: true,
                mouseButtonMapping: "standard"
            }
        })));
        await cdp.detach();
    });

    await t.test("blocks bare rotation shortcuts while keeping toolbar rotation", async () => {
        assert.equal(await page.evaluate(() => window.PDFViewerApplication.pdfViewer.pagesRotation), 0);
        await page.keyboard.press("r");
        await page.keyboard.press("Shift+r");
        assert.equal(await page.evaluate(() => window.PDFViewerApplication.pdfViewer.pagesRotation), 0);

        await page.locator("#secondaryToolbarToggleButton").click();
        await page.locator("#pageRotateCw").click();
        await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.pagesRotation === 90);
        await page.locator("#pageRotateCcw").click();
        await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.pagesRotation === 0);
    });

    const link = page.locator(".academic-citation-link").first();
    await link.waitFor({ state: "visible" });
    const box = await link.boundingBox();
    assert(box);
    const target = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await t.test("opens a preview when Control is pressed over the link glyph", async () => {
        await page.mouse.move(target.x, target.y);
        await page.keyboard.down("Control");
        await waitForPreview(page);
        assert.equal(await link.evaluate(element => element.classList.contains("is-pointer-over")), true);
        await page.keyboard.up("Control");
    });

    await t.test("opens a preview when entering the link with Control held", async () => {
        await page.mouse.move(4, 4);
        await page.keyboard.down("Control");
        await page.mouse.move(target.x, target.y);
        await waitForPreview(page);
        await page.keyboard.up("Control");
    });

    await t.test("defers citation hit testing until Control is held", async () => {
        await page.mouse.move(4, 4);
        await page.evaluate(() => new Promise(requestAnimationFrame));
        await page.evaluate(() => {
            const original = document.elementsFromPoint.bind(document);
            window.__academicOriginalElementsFromPoint = original;
            window.__academicElementsFromPointCalls = 0;
            document.elementsFromPoint = (...args) => {
                window.__academicElementsFromPointCalls += 1;
                return original(...args);
            };
        });
        try {
            await page.mouse.move(target.x, target.y, { steps: 12 });
            await page.evaluate(() => new Promise(requestAnimationFrame));
            assert.equal(await page.evaluate(() => window.__academicElementsFromPointCalls), 0);

            await page.keyboard.down("Control");
            await waitForPreview(page);
            assert.equal(await page.evaluate(() => window.__academicElementsFromPointCalls > 0), true);
        } finally {
            await page.keyboard.up("Control");
            await page.evaluate(() => {
                document.elementsFromPoint = window.__academicOriginalElementsFromPoint;
                delete window.__academicOriginalElementsFromPoint;
                delete window.__academicElementsFromPointCalls;
            });
        }
    });

    await t.test("keeps the preview open and scrollable while Control is held", async () => {
        await page.mouse.move(target.x, target.y);
        await page.keyboard.down("Control");
        const popup = page.locator(".academic-citation-popup");
        try {
            await waitForPreview(page);
            const preview = popup.locator(".academic-citation-popup__preview");
            await preview.evaluate(element => {
                element.style.maxHeight = "80px";
                element.scrollTop = 0;
            });
            const previewBox = await preview.boundingBox();
            assert(previewBox);
            await page.mouse.move(
                previewBox.x + previewBox.width / 2,
                previewBox.y + previewBox.height / 2,
                { steps: 12 }
            );
            assert.equal(await popup.evaluate(element => element.classList.contains("is-open")), true);
            const previousScale = await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale);
            await page.mouse.wheel(0, 240);
            await page.waitForFunction(() => {
                const element = document.querySelector(".academic-citation-popup__preview");
                return element instanceof HTMLElement && element.scrollTop > 0;
            }, undefined, { timeout: 5_000 });
            assert.equal(await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale), previousScale);
            assert.equal(await popup.evaluate(element => element.classList.contains("is-open")), true);
        } finally {
            await page.keyboard.up("Control");
        }
        await page.waitForFunction(() => !document.querySelector(".academic-citation-popup")?.classList.contains("is-open"));
    });

    await t.test("reuses pending preview encoding and discards it after configuration changes", async () => {
        const renderedBefore = await page.evaluate(() => window.__academicTestDebug.filter(
            message => message.event === "linkPreviewRendered"
        ).length);
        const encodedBefore = await page.evaluate(() => window.__academicTestDebug.filter(
            message => message.event === "linkPreviewEncoded"
        ).length);
        await page.evaluate(() => {
            window.postMessage({
                type: "linkPreview.configure",
                enabled: true,
                resolutionScale: 2
            }, "*");
            const original = HTMLCanvasElement.prototype.toBlob;
            window.__academicOriginalToBlob = original;
            window.__academicToBlobCalls = 0;
            window.__academicPendingToBlobCallbacks = [];
            HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
                window.__academicToBlobCalls += 1;
                return original.call(this, blob => {
                    window.__academicPendingToBlobCallbacks.push(() => callback(blob));
                }, type, quality);
            };
        });
        try {
            await page.mouse.move(target.x, target.y);
            await page.keyboard.down("Control");
            await waitForPreview(page);
            await page.waitForFunction(() => window.__academicToBlobCalls === 1);
            await page.waitForFunction(() => window.__academicPendingToBlobCallbacks.length === 1);
            await page.keyboard.up("Control");
            await page.waitForFunction(() => !document.querySelector(
                ".academic-citation-popup"
            )?.classList.contains("is-open"));

            await page.keyboard.down("Control");
            await page.waitForFunction(() => document.querySelector(
                ".academic-citation-popup.is-open canvas.academic-citation-popup__image"
            ), undefined, { timeout: 1_000 });
            assert.equal(await page.evaluate(() => window.__academicToBlobCalls), 1);
            assert.equal(await page.evaluate(start => window.__academicTestDebug.filter(
                message => message.event === "linkPreviewRendered"
            ).length - start, renderedBefore), 1);
            assert.equal(await page.evaluate(start => window.__academicTestDebug.filter(
                message => message.event === "linkPreviewEncoded"
            ).length - start, encodedBefore), 0);
            await page.evaluate(() => {
                window.__academicPendingCanvas = document.querySelector("canvas.academic-citation-popup__image");
            });
            await page.keyboard.up("Control");
            // Returning to the same numeric setting must not revive an old generation.
            for (const resolutionScale of [1, 2]) {
                await page.evaluate(scale => new Promise(resolve => {
                    const applied = event => {
                        if (event.data?.type === "linkPreview.configure" && event.data.resolutionScale === scale) {
                            window.removeEventListener("message", applied);
                            resolve();
                        }
                    };
                    window.addEventListener("message", applied);
                    window.postMessage({ type: "linkPreview.configure", enabled: true, resolutionScale: scale }, "*");
                }), resolutionScale);
            }
            await page.evaluate(() => {
                window.__academicPendingToBlobCallbacks.splice(0).forEach(callback => callback());
            });
            await page.waitForFunction(() => window.__academicPendingCanvas.width === 0);
            assert.equal(await page.evaluate(start => window.__academicTestDebug.filter(
                message => message.event === "linkPreviewEncoded"
            ).length - start, encodedBefore), 0, "stale encoding must not populate the cache");
            await page.keyboard.down("Control");
            await waitForPreview(page);
            await page.waitForFunction(() => window.__academicPendingToBlobCallbacks.length === 1);
            assert.equal(await page.evaluate(() => window.__academicToBlobCalls), 2);
        } finally {
            await page.keyboard.up("Control");
            await page.evaluate(() => {
                window.__academicPendingToBlobCallbacks.splice(0).forEach(callback => callback());
                HTMLCanvasElement.prototype.toBlob = window.__academicOriginalToBlob;
                delete window.__academicOriginalToBlob;
                delete window.__academicToBlobCalls;
                delete window.__academicPendingToBlobCallbacks;
                delete window.__academicPendingCanvas;
                window.postMessage({
                    type: "linkPreview.configure",
                    enabled: true,
                    resolutionScale: 1
                }, "*");
            });
        }
    });

    await t.test("restores a stationary preview after Control-wheel zoom", async () => {
        await page.mouse.move(4, 4);
        await page.keyboard.down("Control");
        await page.mouse.move(target.x, target.y);
        const previousScale = await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale);
        await page.mouse.wheel(0, -10);
        await page.waitForTimeout(80);
        assert.equal(await page.locator(".academic-citation-popup").evaluate(element => element.classList.contains("is-open")), false);
        await page.waitForFunction(scale => window.PDFViewerApplication.pdfViewer.currentScale !== scale, previousScale);
        const zoomedBox = await link.boundingBox();
        assert(zoomedBox);
        assert(target.x >= zoomedBox.x && target.x <= zoomedBox.x + zoomedBox.width);
        assert(target.y >= zoomedBox.y && target.y <= zoomedBox.y + zoomedBox.height);
        await waitForPreview(page);
        await page.keyboard.up("Control");
    });

    await t.test("precomputes every page in a small document when highlights are enabled", async () => {
        const { viewerPage: diffPage, pageErrors: diffPageErrors } = await openPreparedDiffPage(
            browser,
            origin,
            "/__viewer_diff_test__.html"
        );
        await diffPage.evaluate(() => {
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 1,
                role: "modified",
                originalData: new ArrayBuffer(0),
                originalFingerprint: "empty-original",
                originalIsEmptyRevision: true,
                modifiedIsEmptyRevision: false
            }, "*");
        });
        await diffPage.waitForFunction(() => document.querySelectorAll(
            '.page[data-page-number="2"] .academicPdfDiffRegion'
        ).length > 0, undefined, { timeout: 5_000 });
        assert.equal(await diffPage.locator('.page[data-page-number="1"] .academicPdfDiffRegion').count(), 1);
        assert.equal(await diffPage.locator('.page[data-page-number="2"] .academicPdfDiffRegion').count(), 1);
        assert.deepEqual(diffPageErrors, []);
        await diffPage.close();
    });

    await t.test("aligns proportional-font highlights with consistent same-line heights", async () => {
        const diffPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const diffPageErrors = [];
        diffPage.on("pageerror", error => diffPageErrors.push(error.message));
        await diffPage.goto(`${origin}/__viewer_diff_test__.html`);
        await diffPage.waitForFunction(() => window.__academicTestMessages.some(
            message => message.type === "webview.ready"
        ));

        const originalData = createTextPdf("A control run was noisy and rough today.");
        const modifiedData = createTextPdf("A baseline run is stable and focused today.");
        await diffPage.evaluate(async data => {
            window.postMessage({
                type: "document.load",
                loadId: 1,
                data: Uint8Array.from(data).buffer,
                isEmptyRevision: false,
                fingerprint: "text-alignment-modified",
                preserveView: false
            }, "*");
        }, [...modifiedData]);
        await diffPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "firstPageRendered"
        ));
        await diffPage.evaluate(data => {
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 1,
                role: "modified",
                originalData: Uint8Array.from(data).buffer,
                originalFingerprint: "text-alignment-original",
                originalIsEmptyRevision: false,
                modifiedIsEmptyRevision: false
            }, "*");
        }, [...originalData]);
        await diffPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "diffComputed"
        ));

        const markerRects = await diffPage.locator(
            '.page[data-page-number="1"] .academicPdfDiffRegion'
        ).evaluateAll(markers => markers.map(marker => {
            const rect = marker.getBoundingClientRect();
            return {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height
            };
        }));
        assert(markerRects.length >= 3,
            `expected several same-line highlights, received ${JSON.stringify(markerRects)}`);
        for (const rect of markerRects.slice(1)) {
            assert(Math.abs(rect.top - markerRects[0].top) <= 0.5,
                `same-line highlight tops differed: ${JSON.stringify(markerRects)}`);
            assert(Math.abs(rect.height - markerRects[0].height) <= 0.5,
                `same-line highlight heights differed: ${JSON.stringify(markerRects)}`);
        }

        const pairedRegionHeights = await diffPage.evaluate(() => {
            const resultMessage = [...window.__academicTestMessages].reverse().find(
                message => message.type === "diff.pageResult" && message.pageNumber === 1
            );
            return {
                original: resultMessage?.originalChanges
                    .flatMap(change => change.regions)
                    .map(region => region.height) ?? [],
                modified: [...document.querySelectorAll(
                    '.page[data-page-number="1"] .academicPdfDiffRegion'
                )].map(marker => Number.parseFloat(marker.style.height) / 100)
            };
        });
        assert.equal(pairedRegionHeights.original.length, pairedRegionHeights.modified.length);
        for (const [index, height] of pairedRegionHeights.original.entries()) {
            assert(Math.abs(height - pairedRegionHeights.modified[index]) <= 0.000001,
                `paired highlight heights differed: ${JSON.stringify(pairedRegionHeights)}`);
        }

        const gaps = await diffPage.evaluate(() => {
            const marker = document.querySelector(
                '.page[data-page-number="1"] .academicPdfDiffRegion'
            );
            const pageCanvas = document.querySelector('.page[data-page-number="1"] canvas');
            if (!(marker instanceof HTMLElement) || !(pageCanvas instanceof HTMLCanvasElement)) {
                throw new Error("Could not find the changed text and its highlight.");
            }
            const markerRect = marker.getBoundingClientRect();
            const pageCanvasContext = pageCanvas.getContext("2d", { willReadFrequently: true });
            if (!pageCanvasContext) {
                throw new Error("Could not inspect the rendered PDF page.");
            }
            const pageCanvasRect = pageCanvas.getBoundingClientRect();
            const canvasScaleX = pageCanvas.width / pageCanvasRect.width;
            const scanPadding = 8;
            const firstColumn = Math.max(0, Math.floor(
                (markerRect.left - pageCanvasRect.left - scanPadding) * canvasScaleX
            ));
            const lastColumn = Math.min(pageCanvas.width, Math.ceil(
                (markerRect.right - pageCanvasRect.left + scanPadding) * canvasScaleX
            ));
            const width = lastColumn - firstColumn;
            const canvasScaleY = pageCanvas.height / pageCanvasRect.height;
            const firstRow = Math.max(0, Math.floor(
                (markerRect.top - pageCanvasRect.top - scanPadding) * canvasScaleY
            ));
            const lastRow = Math.min(pageCanvas.height, Math.ceil(
                (markerRect.bottom - pageCanvasRect.top + scanPadding) * canvasScaleY
            ));
            const height = lastRow - firstRow;
            const pixels = pageCanvasContext.getImageData(firstColumn, firstRow, width, height).data;
            let inkLeft = width;
            let inkTop = height;
            let inkRight = -1;
            let inkBottom = -1;
            for (let y = 0; y < height; y += 1) {
                for (let x = 0; x < width; x += 1) {
                    const pixel = (y * width + x) * 4;
                    if (pixels[pixel] < 128 && pixels[pixel + 1] < 128 && pixels[pixel + 2] < 128) {
                        inkLeft = Math.min(inkLeft, x);
                        inkTop = Math.min(inkTop, y);
                        inkRight = Math.max(inkRight, x + 1);
                        inkBottom = Math.max(inkBottom, y + 1);
                    }
                }
            }
            if (inkRight < 0 || inkBottom < 0) {
                throw new Error("Could not find changed glyph pixels near the highlight.");
            }
            const glyphLeft = pageCanvasRect.left + (firstColumn + inkLeft) / canvasScaleX;
            const glyphRight = pageCanvasRect.left + (firstColumn + inkRight) / canvasScaleX;
            const glyphTop = pageCanvasRect.top + (firstRow + inkTop) / canvasScaleY;
            const glyphBottom = pageCanvasRect.top + (firstRow + inkBottom) / canvasScaleY;
            return {
                left: glyphLeft - markerRect.left,
                right: markerRect.right - glyphRight,
                top: glyphTop - markerRect.top,
                bottom: markerRect.bottom - glyphBottom
            };
        });
        assert(gaps.left >= 0 && gaps.left <= 8, `left highlight gap was ${gaps.left}px`);
        assert(gaps.right >= 0 && gaps.right <= 8, `right highlight gap was ${gaps.right}px`);
        assert(gaps.top >= 0 && gaps.top <= 12, `top highlight gap was ${gaps.top}px`);
        assert(gaps.bottom >= 0 && gaps.bottom <= 12, `bottom highlight gap was ${gaps.bottom}px`);

        await diffPage.evaluate(() => {
            window.postMessage({
                type: "diff.navigate",
                sessionId: 1,
                direction: "next"
            }, "*");
        });
        await diffPage.waitForFunction(() => document.querySelectorAll(
            '.page[data-page-number="1"] .academicPdfDiffRegion--selected'
        ).length > 0);
        const selectedChangeIndices = await diffPage.locator(
            '.page[data-page-number="1"] .academicPdfDiffRegion--selected'
        ).evaluateAll(markers => [...new Set(markers.map(marker => marker.dataset.changeIndex))]);
        assert.equal(selectedChangeIndices.length, 1);
        assert.match(selectedChangeIndices[0] ?? "", /^\d+$/u);
        assert.deepEqual(diffPageErrors, []);
        await diffPage.close();
    });

    await t.test("keeps visual changes outside semantic text regions", async () => {
        const diffPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const diffPageErrors = [];
        diffPage.on("pageerror", error => diffPageErrors.push(error.message));
        await diffPage.goto(`${origin}/__viewer_diff_test__.html`);
        await diffPage.waitForFunction(() => window.__academicTestMessages.some(
            message => message.type === "webview.ready"
        ));

        const originalData = createTextPdfWithCommands([["(A old C) Tj"]]);
        const modifiedData = createTextPdfWithCommands([[
            "(A new C) Tj",
            "ET",
            "0 0 0 rg",
            "400 100 80 80 re f",
            "BT"
        ]]);
        await diffPage.evaluate(data => {
            window.postMessage({
                type: "document.load",
                loadId: 1,
                data: Uint8Array.from(data).buffer,
                isEmptyRevision: false,
                fingerprint: "hybrid-modified",
                preserveView: false
            }, "*");
        }, [...modifiedData]);
        await diffPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "firstPageRendered"
        ));
        await diffPage.evaluate(data => {
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 1,
                role: "modified",
                originalData: Uint8Array.from(data).buffer,
                originalFingerprint: "hybrid-original",
                originalIsEmptyRevision: false,
                modifiedIsEmptyRevision: false
            }, "*");
        }, [...originalData]);
        await diffPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "diffComputed"
        ));

        const relativeMarkerTops = await diffPage.locator(
            '.page[data-page-number="1"] .academicPdfDiffRegion'
        ).evaluateAll(markers => {
            const pageRect = markers[0]?.closest(".page")?.getBoundingClientRect();
            return pageRect
                ? markers.map(marker => (marker.getBoundingClientRect().top - pageRect.top) / pageRect.height)
                : [];
        });
        assert(relativeMarkerTops.some(top => top > 0.65), "The non-text rectangle change should be highlighted.");
        assert.deepEqual(diffPageErrors, []);
        await diffPage.close();
    });

    await t.test("clears all selected markers when paging from a multi-rectangle change", async () => {
        const diffPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const diffPageErrors = [];
        diffPage.on("pageerror", error => diffPageErrors.push(error.message));
        await diffPage.goto(`${origin}/__viewer_diff_test__.html`);
        await diffPage.waitForFunction(() => window.__academicTestMessages.some(
            message => message.type === "webview.ready"
        ));

        const originalData = createTextPdfWithCommands([
            [
                "(common ) Tj",
                "0 -24 Td",
                "(left) Tj",
                "0 -24 Td",
                "(tail) Tj"
            ],
            ["(unchanged second page) Tj"]
        ]);
        const modifiedData = createTextPdfWithCommands([
            [
                "(common ) Tj",
                "0 -24 Td",
                "(first) Tj",
                "0 -24 Td",
                "(second) Tj",
                "0 -24 Td",
                "(tail) Tj"
            ],
            ["(unchanged second page) Tj"]
        ]);
        await diffPage.evaluate(data => {
            window.postMessage({
                type: "document.load",
                loadId: 1,
                data: Uint8Array.from(data).buffer,
                isEmptyRevision: false,
                fingerprint: "multi-rect-modified",
                preserveView: false
            }, "*");
        }, [...modifiedData]);
        await diffPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "firstPageRendered"
        ));
        await diffPage.evaluate(data => {
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 1,
                role: "modified",
                originalData: Uint8Array.from(data).buffer,
                originalFingerprint: "multi-rect-original",
                originalIsEmptyRevision: false,
                modifiedIsEmptyRevision: false
            }, "*");
        }, [...originalData]);
        await diffPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "diffComputed"
        ));

        await diffPage.waitForFunction(() => [...document.querySelectorAll('.academicPdfDiffRegion')].length > 0);
        const targetChange = await diffPage.evaluate(() => {
            const markerCounts = [...document.querySelectorAll('.academicPdfDiffRegion')]
                .reduce((acc, marker) => {
                    const index = marker.dataset.changeIndex;
                    if (index === undefined) {
                        return acc;
                    }
                    acc[index] = (acc[index] ?? 0) + 1;
                    return acc;
                }, {});
            const multiRegionChange = Object.entries(markerCounts).find(([, count]) => count >= 2);
            if (!multiRegionChange) {
                return null;
            }
            return {
                index: multiRegionChange[0],
                totalMarkers: multiRegionChange[1]
            };
        });
        assert.ok(targetChange);
        assert.equal(typeof targetChange.index, "string");
        assert.equal(typeof targetChange.totalMarkers, "number");
        assert.ok(targetChange.totalMarkers >= 2);
        for (let attempt = 0; attempt < 8; attempt += 1) {
            const selectedIndices = await diffPage.locator('.academicPdfDiffRegion--selected').evaluateAll(
                elements => [...new Set(elements.map(marker => marker.dataset.changeIndex))]
            );
            if (selectedIndices[0] === targetChange.index) {
                break;
            }
            await diffPage.evaluate(() => {
                window.postMessage({
                    type: "diff.navigate",
                    sessionId: 1,
                    direction: "next"
                }, "*");
            });
            await diffPage.waitForFunction(() => document.querySelectorAll(
                '.academicPdfDiffRegion--selected'
            ).length > 0);
        }
        const finalSelectedIndices = await diffPage.locator('.academicPdfDiffRegion--selected').evaluateAll(
            elements => [...new Set(elements.map(marker => marker.dataset.changeIndex))]
        );
        assert.equal(finalSelectedIndices[0], targetChange.index);
        const selectedCount = await diffPage.evaluate((index) => {
            const markers = [...document.querySelectorAll('.academicPdfDiffRegion')];
            const active = [...document.querySelectorAll('.academicPdfDiffRegion--selected')];
            return {
                total: markers.filter(marker => marker.dataset.changeIndex === index).length,
                active: active.filter(marker => marker.dataset.changeIndex === index).length
            };
        }, targetChange.index);
        assert.equal(selectedCount.total, targetChange.totalMarkers);
        assert.equal(selectedCount.active, targetChange.totalMarkers);
        await diffPage.evaluate(() => {
            const viewer = window.PDFViewerApplication.pdfViewer;
            viewer.currentPageNumber = 2;
        });
        await diffPage.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentPageNumber === 2);
        assert.equal(await diffPage.evaluate(() => document.querySelectorAll('.academicPdfDiffRegion--selected').length), 0);
        assert.deepEqual(diffPageErrors, []);
        await diffPage.close();
    });

    await t.test("limits long-document prefetch to the nearby seven-page window", async () => {
        const diffPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const diffPageErrors = [];
        diffPage.on("pageerror", error => diffPageErrors.push(error.message));
        await diffPage.goto(`${origin}/__viewer_diff_test__.html`);
        await diffPage.waitForFunction(() => window.__academicTestMessages.some(
            message => message.type === "webview.ready"
        ));

        const longDocument = createTextPdfPages(Array.from(
            { length: 20 },
            (_, index) => `Long document page ${index + 1}`
        ));
        await diffPage.evaluate(data => {
            window.postMessage({
                type: "document.load",
                loadId: 1,
                data: Uint8Array.from(data).buffer,
                isEmptyRevision: false,
                fingerprint: "long-document-modified",
                preserveView: false
            }, "*");
        }, [...longDocument]);
        await diffPage.waitForFunction(() => window.PDFViewerApplication.pdfDocument?.numPages === 20
            && window.__academicTestDebug.some(message => message.event === "firstPageRendered")
            && window.PDFViewerApplication.pdfViewer.getPageView(1)?.renderingState === 3);
        await diffPage.evaluate(() => {
            window.PDFViewerApplication.pdfViewer.currentPageNumber = 10;
        });
        await diffPage.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentPageNumber === 10);
        await diffPage.evaluate(() => {
            window.__academicTestDebug.length = 0;
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 1,
                role: "modified",
                originalData: new ArrayBuffer(0),
                originalFingerprint: "empty-original",
                originalIsEmptyRevision: true,
                modifiedIsEmptyRevision: false
            }, "*");
        });
        await diffPage.waitForFunction(() => window.__academicTestDebug.filter(
            message => message.event === "diffComputed"
        ).length === 7, undefined, { timeout: 5_000 });
        await diffPage.waitForTimeout(100);

        const computedPages = await diffPage.evaluate(() => window.__academicTestDebug
            .filter(message => message.event === "diffComputed")
            .map(message => message.pageNumber)
            .sort((first, second) => first - second));
        assert.deepEqual(computedPages, [7, 8, 9, 10, 11, 12, 13]);
        assert.deepEqual(diffPageErrors, []);
        await diffPage.close();
    });

    await t.test("accepts a minimal empty-modified diff control message", async () => {
        const { viewerPage: modifiedPage, pageErrors: modifiedPageErrors } = await openPreparedDiffPage(
            browser,
            origin,
            "/__viewer_diff_test__.html"
        );
        await modifiedPage.evaluate(() => {
            window.__academicTestDebug.length = 0;
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 1,
                role: "modified",
                modifiedIsEmptyRevision: true
            }, "*");
        });
        await modifiedPage.waitForFunction(() => document.querySelector(
            ".academicPdfDiffStatus"
        )?.classList.contains("academicPdfDiffStatus--enabled"));
        await modifiedPage.waitForTimeout(100);

        assert.equal(await modifiedPage.evaluate(() => window.__academicTestDebug.some(
            message => message.event === "diffComputed"
        )), false);
        assert.deepEqual(modifiedPageErrors, []);
        await modifiedPage.close();
    });

    await t.test("applies removed-page highlights to pre-rendered pages in a small document", async () => {
        const { viewerPage: originalPage, pageErrors: originalPageErrors } = await openPreparedDiffPage(
            browser,
            origin,
            "/__viewer_original_diff_test__.html"
        );
        await originalPage.evaluate(() => {
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 1,
                role: "original",
                allPagesChanged: false
            }, "*");
            window.postMessage({
                type: "diff.setRemovedPageRange",
                sessionId: 1,
                fromPage: 2,
                toPage: 2
            }, "*");
        });
        await originalPage.waitForFunction(() => document.querySelectorAll(
            '.page[data-page-number="2"] .academicPdfDiffRegion'
        ).length > 0, undefined, { timeout: 5_000 });
        assert.equal(await originalPage.locator('.page[data-page-number="2"] .academicPdfDiffRegion').count(), 1);
        assert.deepEqual(originalPageErrors, []);
        await originalPage.close();
    });

    await t.test("ignores malformed extension diff messages without changing the active session", async () => {
        const { viewerPage: originalPage, pageErrors: originalPageErrors } = await openPreparedDiffPage(
            browser,
            origin,
            "/__viewer_original_diff_test__.html"
        );
        await originalPage.evaluate(() => {
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 2,
                role: "modified",
                originalData: "not-an-array-buffer",
                originalFingerprint: "invalid-original",
                originalIsEmptyRevision: false,
                modifiedIsEmptyRevision: false
            }, "*");
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 3,
                role: "original"
            }, "*");
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 1,
                role: "original",
                allPagesChanged: false
            }, "*");
            window.postMessage({
                type: "diff.applyPage",
                sessionId: 1,
                pageNumber: 1,
                changes: [{
                    id: "1:text-1",
                    kind: "delete",
                    regions: [{ left: 0.1, top: 0.1, width: 0.2, height: 0.1 }],
                    strategy: "text"
                }]
            }, "*");
        });
        await originalPage.waitForFunction(() => document.querySelectorAll(
            '.page[data-page-number="1"] .academicPdfDiffRegion'
        ).length === 1, undefined, { timeout: 5_000 });

        await originalPage.evaluate(() => {
            window.postMessage({
                type: "diff.applyPage",
                sessionId: 1,
                pageNumber: 1,
                changes: [null]
            }, "*");
            window.postMessage({
                type: "diff.setRemovedPageRange",
                sessionId: 1,
                fromPage: 1.5,
                toPage: 2
            }, "*");
        });
        await originalPage.waitForTimeout(100);

        assert.equal(await originalPage.locator(
            '.page[data-page-number="1"] .academicPdfDiffRegion'
        ).count(), 1);
        assert.equal(await originalPage.locator(
            '.page[data-page-number="2"] .academicPdfDiffRegion'
        ).count(), 0);
        assert.deepEqual(originalPageErrors, []);
        await originalPage.close();
    });

    await t.test("keeps SyncTeX requests aligned with the loaded PDF and page content", async () => {
        const syncTexPage = await browser.newPage({ viewport: { width: 640, height: 720 } });
        const syncTexPageErrors = [];
        syncTexPage.on("pageerror", error => syncTexPageErrors.push(error.stack || error.message));
        await syncTexPage.goto(`${origin}/__viewer_test__.html`);
        await syncTexPage.waitForFunction(() => window.__academicTestMessages.some(
            message => message.type === "webview.ready"
        ));

        const syncTexPageTexts = Array.from({ length: 20 }, (_, index) => `SyncTeX page ${index + 1}`);
        const syncTexPdf = createTextPdfPagesWithGeometries(
            syncTexPageTexts,
            syncTexPageTexts.map((_, index) => index === 19
                ? { mediaBox: [100, 200, 500, 900], userUnit: 3 }
                : index === 18
                    ? { mediaBox: [50, 60, 450, 660], userUnit: 4 }
                    : index === 0
                        ? { mediaBox: [0, 0, 595.276, 841.89], userUnit: 1 }
                        : { mediaBox: [10, 20, 622, 812], userUnit: 2 }),
        );
        await syncTexPage.evaluate(({ pdf, forward }) => {
            const viewer = window.PDFViewerApplication.pdfViewer;
            const originalScrollPageIntoView = viewer.scrollPageIntoView.bind(viewer);
            window.__academicSyncTexScrolls = [];
            window.__academicSyncTexLocations = {};
            window.addEventListener("academic-pdf-message", event => {
                const message = event.detail;
                if (message?.type !== "synctex.forwardResult" || message.status !== "applied") {
                    return;
                }
                const location = viewer._location;
                window.__academicSyncTexLocations[message.requestId] = location && {
                    pageNumber: location.pageNumber,
                    top: location.top,
                };
            });
            viewer.scrollPageIntoView = options => {
                window.__academicSyncTexScrolls.push(options);
                originalScrollPageIntoView(options);
            };
            window.postMessage(forward, "*");
            window.postMessage({
                type: "document.load",
                loadId: forward.loadId,
                data: Uint8Array.from(pdf).buffer,
                isEmptyRevision: false,
                fingerprint: "synctex-load-race",
                preserveView: false
            }, "*");
        }, {
            pdf: [...syncTexPdf],
            forward: {
                type: "synctex.forward",
                requestId: "load-race",
                loadId: 1,
                pageNumber: 20,
                x: 120,
                y: 160,
            }
        });
        await syncTexPage.waitForFunction(() => window.__academicTestMessages.some(message =>
            message.type === "synctex.forwardResult"
                && message.requestId === "load-race"
                && message.status === "applied"
        ));
        await syncTexPage.waitForTimeout(100);

        const forwardState = await syncTexPage.evaluate(() => {
            const result = window.__academicTestMessages.find(message =>
                message.type === "synctex.forwardResult" && message.requestId === "load-race"
            );
            const scroll = window.__academicSyncTexScrolls.find(options =>
                options.pageNumber === 20 && options.destArray?.[1]?.name === "XYZ"
            );
            const pageView = window.PDFViewerApplication.pdfViewer.getPageView(19);
            return {
                result,
                destination: scroll?.destArray?.slice(2, 4),
                userUnit: pageView?.viewport.userUnit,
                viewBox: pageView?.viewport.viewBox,
                pdfPageBound: Boolean(pageView?.pdfPage),
                currentPageNumber: window.PDFViewerApplication.pdfViewer.currentPageNumber,
                scrollTop: window.PDFViewerApplication.pdfViewer.container.scrollTop,
                targetTop: pageView?.div.getBoundingClientRect().top,
            };
        });
        assert.deepEqual(forwardState.result, {
            type: "synctex.forwardResult",
            requestId: "load-race",
            loadId: 1,
            status: "applied",
        });
        assert.equal(forwardState.destination[0], 140);
        assert(Math.abs(forwardState.destination[1] - (900 - 160 / 3)) < 0.000001);
        assert.equal(forwardState.userUnit, 3);
        assert.deepEqual(forwardState.viewBox, [100, 200, 500, 900]);
        assert.equal(forwardState.pdfPageBound, true);
        assert.equal(forwardState.currentPageNumber, 20, JSON.stringify(forwardState));

        const applyPageOneForward = async (requestId, y, targetBox) => {
            const messageStart = await syncTexPage.evaluate(() => window.__academicTestMessages.length);
            await syncTexPage.evaluate(({ requestId: id, targetY, box }) => window.postMessage({
                type: "synctex.forward",
                requestId: id,
                loadId: 1,
                pageNumber: 1,
                x: 120,
                y: targetY,
                ...(box ? { targetBox: box } : {}),
            }, "*"), { requestId, targetY: y, box: targetBox });
            await syncTexPage.waitForFunction(({ offset, id }) => window.__academicTestMessages
                .slice(offset)
                .some(message => message.type === "synctex.forwardResult"
                    && message.requestId === id
                    && message.status === "applied"), {
                offset: messageStart,
                id: requestId,
            });
            await syncTexPage.waitForTimeout(100);
            return syncTexPage.evaluate(({ requestId: id, targetY, box }) => {
                const viewer = window.PDFViewerApplication.pdfViewer;
                const pageView = viewer.getPageView(0);
                const viewBox = pageView.viewport.viewBox;
                const userUnit = pageView.viewport.userUnit;
                const [viewportX, viewportY] = pageView.viewport.convertToViewportPoint(
                    viewBox[0] + 120 / userUnit,
                    viewBox[3] - targetY / userUnit,
                );
                const containerBounds = viewer.container.getBoundingClientRect();
                const pageBounds = pageView.div.getBoundingClientRect();
                const marker = pageView.div.querySelector(".academicPdfSyncTexTarget");
                const markerBounds = marker?.getBoundingClientRect();
                let expectedMarkerBox;
                if (box) {
                    const right = box.x + box.width;
                    const bottom = box.y + box.height;
                    const points = [
                        [box.x, box.y],
                        [right, box.y],
                        [box.x, bottom],
                        [right, bottom],
                    ].map(([x, y]) => pageView.viewport.convertToViewportPoint(
                        viewBox[0] + x / userUnit,
                        viewBox[3] - y / userUnit,
                    ));
                    const xs = points.map(point => point[0]);
                    const ys = points.map(point => point[1]);
                    const left = Math.min(...xs);
                    const targetTop = Math.min(...ys);
                    const targetBottom = Math.max(...ys);
                    const top = Math.max(0, targetTop - 3);
                    const visualBottom = Math.min(pageView.viewport.height, targetBottom + 3);
                    expectedMarkerBox = {
                        left,
                        top,
                        width: Math.max(...xs) - left,
                        height: visualBottom - top,
                    };
                }
                return {
                    scrollTop: viewer.container.scrollTop,
                    targetHorizontalOffset: pageBounds.left
                        + pageView.div.clientLeft
                        + viewportX
                        - containerBounds.left,
                    targetOffset: pageBounds.top
                        + pageView.div.clientTop
                        + viewportY
                        - containerBounds.top,
                    containerHeight: viewer.container.clientHeight,
                    containerWidth: viewer.container.clientWidth,
                    acknowledgedLocation: window.__academicSyncTexLocations[id],
                    markerCount: document.querySelectorAll(".academicPdfSyncTexTarget").length,
                    markerKind: marker?.dataset.synctexTarget,
                    markerBaseOpacity: marker?.style.opacity,
                    markerBackground: marker?.style.backgroundColor,
                    markerBox: markerBounds && {
                        left: markerBounds.left - pageBounds.left - pageView.div.clientLeft,
                        top: markerBounds.top - pageBounds.top - pageView.div.clientTop,
                        width: markerBounds.width,
                        height: markerBounds.height,
                    },
                    expectedMarkerBox,
                    markerOffset: markerBounds && {
                        x: markerBounds.left + markerBounds.width / 2
                            - pageBounds.left
                            - pageView.div.clientLeft
                            - viewportX,
                        y: markerBounds.top + markerBounds.height / 2
                            - pageBounds.top
                            - pageView.div.clientTop
                            - viewportY,
                    },
                };
            }, { requestId, targetY: y, box: targetBox });
        };
        const pageOneTopForward = await applyPageOneForward("page-one-top", 164.038193);
        const pageOneBottomForward = await applyPageOneForward("page-one-bottom", 672.249023);
        assert(pageOneBottomForward.scrollTop > pageOneTopForward.scrollTop, JSON.stringify({
            pageOneTopForward,
            pageOneBottomForward,
        }));
        for (const state of [pageOneTopForward, pageOneBottomForward]) {
            assert.equal(state.acknowledgedLocation?.pageNumber, 1, JSON.stringify(state));
            assert.equal(state.markerCount, 1, JSON.stringify(state));
            assert(Math.abs(state.markerOffset?.x) < 1, JSON.stringify(state));
            assert(Math.abs(state.markerOffset?.y) < 1, JSON.stringify(state));
            assert(state.targetHorizontalOffset >= 24, JSON.stringify(state));
            assert(state.targetHorizontalOffset <= state.containerWidth - 24, JSON.stringify(state));
            assert(state.targetOffset >= 24, JSON.stringify(state));
            assert(state.targetOffset <= state.containerHeight - 24, JSON.stringify(state));
        }

        const syncTexLineBox = {
            x: 110.854279,
            y: 663.946833,
            width: 388.542938,
            height: 10.626775,
        };
        const lineBoxForward = await applyPageOneForward(
            "page-one-line-box",
            672.249023,
            syncTexLineBox,
        );
        assert.equal(lineBoxForward.markerKind, "box", JSON.stringify(lineBoxForward));
        assert.equal(lineBoxForward.markerBaseOpacity, "0.65", JSON.stringify(lineBoxForward));
        assert.equal(
            lineBoxForward.markerBackground,
            "rgba(55, 148, 255, 0.1)",
            JSON.stringify(lineBoxForward),
        );
        for (const field of ["left", "top", "width", "height"]) {
            assert(
                Math.abs(lineBoxForward.markerBox[field] - lineBoxForward.expectedMarkerBox[field]) < 1,
                JSON.stringify(lineBoxForward),
            );
        }

        await syncTexPage.evaluate(() => {
            const viewer = window.PDFViewerApplication.pdfViewer;
            viewer.currentPageNumber = 1;
            viewer.container.scrollTop = 0;
        });
        await syncTexPage.waitForFunction(() => {
            const pageView = window.PDFViewerApplication.pdfViewer.getPageView(0);
            return pageView?.renderingState === 3
                && pageView.div.getAttribute("data-vscode-context") === '{"webviewSection":"pdfPage"}';
        });
        const textHintPoint = await syncTexPage.evaluate(() => {
            const textElement = [...document.querySelectorAll(".textLayer span")]
                .find(element => element.textContent === "SyncTeX page 1");
            const textNode = textElement?.firstChild;
            if (!(textNode instanceof Text)) {
                return undefined;
            }
            const range = document.createRange();
            range.setStart(textNode, 8);
            range.setEnd(textNode, 9);
            const bounds = range.getBoundingClientRect();
            return {
                x: bounds.left + bounds.width / 2,
                y: bounds.top + bounds.height / 2,
            };
        });
        assert(textHintPoint, "Could not find the SyncTeX text-layer target.");
        const textHintStart = await syncTexPage.evaluate(() => window.__academicTestMessages.length);
        await syncTexPage.mouse.dblclick(textHintPoint.x, textHintPoint.y);
        await syncTexPage.waitForFunction(offset => window.__academicTestMessages.slice(offset).some(
            message => message.type === "synctex.inverse"
        ), textHintStart);
        const hintedInverse = await syncTexPage.evaluate(offset => window.__academicTestMessages
            .slice(offset)
            .find(message => message.type === "synctex.inverse"), textHintStart);
        assert.equal(hintedInverse.context, "SyncTeX page 1");
        assert(hintedInverse.offset === 8 || hintedInverse.offset === 9, JSON.stringify(hintedInverse));

        const clickPoint = await syncTexPage.evaluate(() => {
            const pageView = window.PDFViewerApplication.pdfViewer.getPageView(0);
            const viewBox = pageView.viewport.viewBox;
            const userUnit = pageView.viewport.userUnit;
            const [viewportX, viewportY] = pageView.viewport.convertToViewportPoint(
                viewBox[0] + 120 / userUnit,
                viewBox[3] - 160 / userUnit,
            );
            const bounds = pageView.div.getBoundingClientRect();
            return {
                x: bounds.left + pageView.div.clientLeft + viewportX,
                y: bounds.top + pageView.div.clientTop + viewportY,
            };
        });
        const inverseStart = await syncTexPage.evaluate(() => window.__academicTestMessages.length);
        await syncTexPage.mouse.dblclick(clickPoint.x, clickPoint.y);
        await syncTexPage.waitForFunction(offset => window.__academicTestMessages.slice(offset).some(
            message => message.type === "synctex.inverse"
        ), inverseStart);
        const inverse = await syncTexPage.evaluate(offset => window.__academicTestMessages.slice(offset).find(
            message => message.type === "synctex.inverse"
        ), inverseStart);
        assert.equal(inverse.pageNumber, 1);
        assert.equal(inverse.trigger, "doubleClick");
        assert(Math.abs(inverse.x - 120) < 1, JSON.stringify(inverse));
        assert(Math.abs(inverse.y - 160) < 1, JSON.stringify(inverse));

        const inverseCount = await syncTexPage.evaluate(() => window.__academicTestMessages.filter(
            message => message.type === "synctex.inverse"
        ).length);
        const borderPoint = await syncTexPage.evaluate(() => {
            const bounds = window.PDFViewerApplication.pdfViewer.getPageView(0).div.getBoundingClientRect();
            return { x: bounds.left + 1, y: bounds.top + 1 };
        });
        await syncTexPage.mouse.dblclick(borderPoint.x, borderPoint.y);
        await syncTexPage.evaluate(() => {
            const page = window.PDFViewerApplication.pdfViewer.getPageView(0).div;
            const input = document.createElement("input");
            input.id = "academicSyncTexEditableTest";
            input.style.position = "absolute";
            input.style.left = "30px";
            input.style.top = "30px";
            page.appendChild(input);
        });
        await syncTexPage.locator("#academicSyncTexEditableTest").dblclick();
        assert.equal(await syncTexPage.evaluate(() => window.__academicTestMessages.filter(
            message => message.type === "synctex.inverse"
        ).length), inverseCount);

        const rightClickConfigureStart = await syncTexPage.evaluate(() => window.__academicTestMessages.length);
        await syncTexPage.evaluate(() => window.postMessage({
            type: "synctex.configure",
            mode: "rightclick"
        }, "*"));
        await syncTexPage.waitForFunction(offset => window.__academicTestMessages.slice(offset).some(
            message => message.type === "synctex.inverseClear"
        ), rightClickConfigureStart);
        const rightClickStart = await syncTexPage.evaluate(() => window.__academicTestMessages.length);
        await syncTexPage.mouse.click(textHintPoint.x, textHintPoint.y, { button: "right" });
        await syncTexPage.waitForFunction(offset => window.__academicTestMessages.slice(offset).some(
            message => message.type === "synctex.inverse" && message.trigger === "rightClick"
        ), rightClickStart);
        assert.deepEqual(await syncTexPage.evaluate(offset => window.__academicTestMessages
            .slice(offset)
            .filter(message => message.type.startsWith("synctex.inverse"))
            .map(message => message.type), rightClickStart), [
            "synctex.inverseClear",
            "synctex.inverse",
        ]);
        const rightClickInverse = await syncTexPage.evaluate(offset => window.__academicTestMessages
            .slice(offset)
            .find(message => message.type === "synctex.inverse"), rightClickStart);
        assert.equal(rightClickInverse.context, "SyncTeX page 1");
        assert(rightClickInverse.offset === 8 || rightClickInverse.offset === 9, JSON.stringify(rightClickInverse));

        const nonPageStart = await syncTexPage.evaluate(() => ({
            messages: window.__academicTestMessages.length,
            inverse: window.__academicTestMessages.filter(message => message.type === "synctex.inverse").length,
        }));
        await syncTexPage.locator("#toolbarContainer").click({ button: "right", position: { x: 2, y: 2 } });
        await syncTexPage.waitForFunction(offset => window.__academicTestMessages.slice(offset).some(
            message => message.type === "synctex.inverseClear"
        ), nonPageStart.messages);
        assert.equal(await syncTexPage.evaluate(() => window.__academicTestMessages.filter(
            message => message.type === "synctex.inverse"
        ).length), nonPageStart.inverse);

        const configureStart = await syncTexPage.evaluate(() => window.__academicTestMessages.length);
        await syncTexPage.evaluate(() => window.postMessage({
            type: "synctex.configure",
            mode: "off"
        }, "*"));
        await syncTexPage.waitForFunction(offset => window.__academicTestMessages.slice(offset).some(
            message => message.type === "synctex.inverseClear"
        ), configureStart);

        const lazyScrollStart = await syncTexPage.evaluate(() => {
            const viewer = window.PDFViewerApplication.pdfViewer;
            const targetPageView = viewer.getPageView(18);
            targetPageView.pdfPage = undefined;
            targetPageView.viewport = viewer.getPageView(0).viewport;
            window.__academicLazyPageSetCalls = 0;
            const originalSetPdfPage = targetPageView.setPdfPage.bind(targetPageView);
            targetPageView.setPdfPage = pdfPage => {
                window.__academicLazyPageSetCalls++;
                originalSetPdfPage(pdfPage);
            };
            window.postMessage({
                type: "synctex.forward",
                requestId: "lazy-page",
                loadId: 1,
                pageNumber: 19,
                x: 80,
                y: 100,
            }, "*");
            return window.__academicSyncTexScrolls.length;
        });
        await syncTexPage.waitForFunction(() => window.__academicTestMessages.some(message =>
            message.type === "synctex.forwardResult"
                && message.requestId === "lazy-page"
                && message.status === "applied"
        ));
        const lazyPageState = await syncTexPage.evaluate(scrollStart => {
            const pageView = window.PDFViewerApplication.pdfViewer.getPageView(18);
            return {
                bound: Boolean(pageView.pdfPage),
                setPdfPageCalls: window.__academicLazyPageSetCalls,
                userUnit: pageView.viewport.userUnit,
                viewBox: pageView.viewport.viewBox,
                scroll: window.__academicSyncTexScrolls.slice(scrollStart).find(options =>
                    options.pageNumber === 19 && options.destArray?.[1]?.name === "XYZ"
                ),
            };
        }, lazyScrollStart);
        assert.equal(lazyPageState.bound, true);
        assert(lazyPageState.setPdfPageCalls >= 1);
        assert.equal(lazyPageState.userUnit, 4);
        assert.deepEqual(lazyPageState.viewBox, [50, 60, 450, 660]);
        assert.deepEqual(lazyPageState.scroll.destArray.slice(2, 4), [70, 635]);

        const overflowScrollStart = await syncTexPage.evaluate(() => {
            window.PDFViewerApplication.pdfViewer.getPageView(18).viewport.userUnit = 0.5;
            window.postMessage({
                type: "synctex.forward",
                requestId: "overflow-coordinate",
                loadId: 1,
                pageNumber: 19,
                x: Number.MAX_VALUE,
                y: -Number.MAX_VALUE,
            }, "*");
            return window.__academicSyncTexScrolls.length;
        });
        await syncTexPage.waitForFunction(() => window.__academicTestMessages.some(message =>
            message.type === "synctex.forwardResult"
                && message.requestId === "overflow-coordinate"
                && message.status === "rejected"
        ));
        assert.equal(await syncTexPage.evaluate(() => window.__academicSyncTexScrolls.length), overflowScrollStart);

        await syncTexPage.evaluate(() => {
            const viewer = window.PDFViewerApplication.pdfViewer;
            let releasePagesPromise;
            const pagesPromise = new Promise(resolve => {
                releasePagesPromise = resolve;
            });
            window.__academicReleaseSyncTexPages = releasePagesPromise;
            window.__academicSyncTexPagesObserved = false;
            Object.defineProperty(viewer, "pagesPromise", {
                configurable: true,
                get() {
                    window.__academicSyncTexPagesObserved = true;
                    return pagesPromise;
                }
            });
            window.postMessage({
                type: "synctex.forward",
                requestId: "cancelled-request",
                loadId: 1,
                pageNumber: 1,
                x: 20,
                y: 30,
            }, "*");
        });
        await syncTexPage.waitForFunction(() => window.__academicSyncTexPagesObserved);
        const malformedCancelStart = await syncTexPage.evaluate(() => window.__academicTestMessages.length);
        await syncTexPage.evaluate(() => {
            window.postMessage({
                type: "synctex.forwardCancel",
                requestId: "cancelled-request",
                loadId: "1",
            }, "*");
            window.postMessage({
                type: "synctex.configure",
                mode: "off",
            }, "*");
        });
        await syncTexPage.waitForFunction(offset => window.__academicTestMessages.slice(offset).some(
            message => message.type === "synctex.inverseClear"
        ), malformedCancelStart);
        assert.equal(await syncTexPage.evaluate(() => window.__academicTestMessages.some(message =>
            message.type === "synctex.forwardResult" && message.requestId === "cancelled-request"
        )), false);

        await syncTexPage.evaluate(() => window.postMessage({
            type: "synctex.forwardCancel",
            requestId: "cancelled-request",
            loadId: 1,
        }, "*"));
        await syncTexPage.waitForFunction(() => window.__academicTestMessages.some(message =>
            message.type === "synctex.forwardResult"
                && message.requestId === "cancelled-request"
                && message.status === "rejected"
        ));
        const cancelledScrollStart = await syncTexPage.evaluate(() => window.__academicSyncTexScrolls.length);
        await syncTexPage.evaluate(({ pdf }) => {
            window.postMessage({
                type: "document.load",
                loadId: 2,
                data: Uint8Array.from(pdf).buffer,
                isEmptyRevision: false,
                fingerprint: "synctex-after-cancel",
                preserveView: false
            }, "*");
            window.postMessage({
                type: "synctex.forward",
                requestId: "replacement-request",
                loadId: 2,
                pageNumber: 20,
                x: 120,
                y: 160,
            }, "*");
            window.__academicReleaseSyncTexPages();
        }, { pdf: [...syncTexPdf] });
        await syncTexPage.waitForFunction(() => window.__academicTestMessages.some(message =>
            message.type === "synctex.forwardResult"
                && message.requestId === "replacement-request"
                && message.status === "applied"
        ));
        const cancellationState = await syncTexPage.evaluate(scrollStart => ({
            cancelledResults: window.__academicTestMessages.filter(message =>
                message.type === "synctex.forwardResult" && message.requestId === "cancelled-request"
            ),
            replacementResult: window.__academicTestMessages.find(message =>
                message.type === "synctex.forwardResult" && message.requestId === "replacement-request"
            ),
            cancelledScrolls: window.__academicSyncTexScrolls.slice(scrollStart).filter(options =>
                options.pageNumber === 1
                    && options.destArray?.[1]?.name === "XYZ"
                    && options.destArray?.[2] === 20
                    && options.destArray?.[3] === 811.89
            ),
            replacementScrolls: window.__academicSyncTexScrolls.slice(scrollStart).filter(options =>
                options.pageNumber === 20
                    && options.destArray?.[1]?.name === "XYZ"
                    && options.destArray?.[2] === 140
            ),
        }), cancelledScrollStart);
        assert.deepEqual(cancellationState.cancelledResults, [{
            type: "synctex.forwardResult",
            requestId: "cancelled-request",
            loadId: 1,
            status: "rejected",
        }]);
        assert.equal(cancellationState.replacementResult.status, "applied");
        assert.equal(cancellationState.cancelledScrolls.length, 0);
        assert.equal(cancellationState.replacementScrolls.length, 1);
        assert.deepEqual(syncTexPageErrors, []);
        await syncTexPage.close();
    });

    await t.test("applies the preferred sidebar and preserves the current view on reload", async () => {
        const sidebarPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const sidebarPageErrors = [];
        sidebarPage.on("pageerror", error => sidebarPageErrors.push(error.stack || error.message));
        await sidebarPage.goto(`${origin}/__viewer_outline_test__.html`);
        await sidebarPage.waitForFunction(() => window.__academicTestMessages.some(
            message => message.type === "webview.ready"
        ));

        await sidebarPage.evaluate(async pdfPath => {
            const data = await (await fetch(pdfPath)).arrayBuffer();
            window.postMessage({
                type: "document.load",
                loadId: 1,
                data,
                isEmptyRevision: false,
                fingerprint: "sidebar-initial",
                preserveView: false
            }, "*");
        }, fixturePath);
        await sidebarPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "firstPageRendered"
                && message.fingerprint === "sidebar-initial"
        ));

        assert.deepEqual(await sidebarPage.evaluate(() => ({
            active: window.PDFViewerApplication.viewsManager.active,
            isOpen: window.PDFViewerApplication.viewsManager.isOpen,
            visible: window.PDFViewerApplication.viewsManager.visibleView
        })), {
            active: 2,
            isOpen: false,
            visible: 0
        });

        await sidebarPage.locator("#viewsManagerToggleButton").click();
        await sidebarPage.waitForFunction(() => window.PDFViewerApplication.viewsManager.isOpen);
        assert.equal(await sidebarPage.evaluate(
            () => window.PDFViewerApplication.viewsManager.visibleView
        ), 2);
        await sidebarPage.locator("#viewsManagerToggleButton").click();
        await sidebarPage.waitForFunction(() => !window.PDFViewerApplication.viewsManager.isOpen);

        await sidebarPage.waitForFunction(() => document.querySelector("#attachmentsViewMenu")?.disabled);
        await sidebarPage.evaluate(() => window.postMessage({
            type: "sidebar.configure",
            defaultSidebar: "attachments"
        }, "*"));
        await sidebarPage.waitForFunction(() => window.PDFViewerApplication.viewsManager.active === 1);

        await sidebarPage.evaluate(() => {
            window.postMessage({
                type: "sidebar.configure",
                defaultSidebar: "pages"
            }, "*");
        });
        await sidebarPage.waitForFunction(() => window.PDFViewerApplication.viewsManager.active === 1);
        await sidebarPage.locator("#viewsManagerToggleButton").click();
        await sidebarPage.locator("#viewsManagerSelectorButton").click();
        await sidebarPage.locator("#outlinesViewMenu").click();
        await sidebarPage.waitForFunction(() => (
            window.PDFViewerApplication.viewsManager.active === 2
                && window.PDFViewerApplication.viewsManager.isOpen
        ));
        await sidebarPage.evaluate(() => {
            window.__academicTestDebug.length = 0;
        });
        await sidebarPage.evaluate(async pdfPath => {
            const data = await (await fetch(pdfPath)).arrayBuffer();
            window.postMessage({
                type: "document.load",
                loadId: 2,
                data,
                isEmptyRevision: false,
                fingerprint: "sidebar-reloaded",
                preserveView: true
            }, "*");
        }, fixturePath);
        await sidebarPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "firstPageRendered"
                && message.fingerprint === "sidebar-reloaded"
        ));

        assert.deepEqual(await sidebarPage.evaluate(() => ({
            active: window.PDFViewerApplication.viewsManager.active,
            isOpen: window.PDFViewerApplication.viewsManager.isOpen,
            visible: window.PDFViewerApplication.viewsManager.visibleView
        })), {
            active: 2,
            isOpen: true,
            visible: 2
        });

        await sidebarPage.locator("#viewsManagerToggleButton").click();
        await sidebarPage.waitForFunction(() => !window.PDFViewerApplication.viewsManager.isOpen);
        await sidebarPage.evaluate(() => {
            window.__academicTestDebug.length = 0;
        });
        await sidebarPage.evaluate(async pdfPath => {
            const data = await (await fetch(pdfPath)).arrayBuffer();
            window.postMessage({
                type: "document.load",
                loadId: 3,
                data,
                isEmptyRevision: false,
                fingerprint: "sidebar-reloaded-closed",
                preserveView: true
            }, "*");
        }, fixturePath);
        await sidebarPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "firstPageRendered"
                && message.fingerprint === "sidebar-reloaded-closed"
        ));
        assert.deepEqual(await sidebarPage.evaluate(() => ({
            active: window.PDFViewerApplication.viewsManager.active,
            isOpen: window.PDFViewerApplication.viewsManager.isOpen
        })), {
            active: 2,
            isOpen: false
        });
        assert.deepEqual(sidebarPageErrors, []);
        await sidebarPage.close();
    });

    await t.test("preserves a non-preset zoom across document reload", async () => {
        const reloadPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const reloadPageErrors = [];
        reloadPage.on("pageerror", error => reloadPageErrors.push(error.stack || error.message));
        await reloadPage.goto(`${origin}/__viewer_test__.html`);
        await reloadPage.waitForFunction(() => window.__academicTestMessages.some(
            message => message.type === "webview.ready"
        ));

        await reloadPage.evaluate(async pdfPath => {
            const data = await (await fetch(pdfPath)).arrayBuffer();
            window.postMessage({
                type: "document.load",
                loadId: 1,
                data,
                isEmptyRevision: false,
                fingerprint: "custom-zoom-initial",
                preserveView: false
            }, "*");
        }, fixturePath);
        await reloadPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "firstPageRendered"
                && message.fingerprint === "custom-zoom-initial"
        ));

        await reloadPage.evaluate(() => {
            window.PDFViewerApplication.pdfViewer.currentScaleValue = "1.2904";
            window.__academicTestDebug.length = 0;
        });
        await reloadPage.evaluate(async pdfPath => {
            const data = await (await fetch(pdfPath)).arrayBuffer();
            window.postMessage({
                type: "document.load",
                loadId: 2,
                data,
                isEmptyRevision: false,
                fingerprint: "custom-zoom-reloaded",
                preserveView: true
            }, "*");
        }, fixturePath);
        await reloadPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "firstPageRendered"
                && message.fingerprint === "custom-zoom-reloaded"
        ));
        await reloadPage.evaluate(() => new Promise(resolve => requestAnimationFrame(
            () => requestAnimationFrame(resolve)
        )));

        const scale = await reloadPage.evaluate(() => ({
            current: window.PDFViewerApplication.pdfViewer.currentScale,
            value: window.PDFViewerApplication.pdfViewer.currentScaleValue
        }));
        assert(Math.abs(scale.current - 1.2904) < 0.000001, JSON.stringify(scale));
        assert.equal(scale.value, "1.2904");
        assert.deepEqual(reloadPageErrors, []);
        await reloadPage.close();
    });

    await t.test("defers restored comparisons until the current main document opens", async t => {
        const restoredPage = await browser.newPage();
        t.after(() => restoredPage.close());
        await restoredPage.goto(`${origin}/__viewer_diff_test__.html`);
        await restoredPage.waitForFunction(() => window.__academicTestMessages.some(m => m.type === "webview.ready"));
        await restoredPage.evaluate(async path => {
            const application = window.PDFViewerApplication;
            const open = application.open.bind(application);
            application.open = async options => {
                await new Promise(resolve => { window.__resumeRestoredOpen = resolve; });
                return open(options);
            };
            window.__earlyComparisonLoads = 0;
            const getDocument = window.pdfjsLib.getDocument;
            window.pdfjsLib = { ...window.pdfjsLib, getDocument: options => {
                window.__earlyComparisonLoads += 1;
                return getDocument(options);
            } };
            const data = new Uint8Array(await (await fetch(path)).arrayBuffer());
            window.postMessage({ type: "document.load", loadId: 1, data: data.slice().buffer,
                isEmptyRevision: false, fingerprint: "restored-main", preserveView: false }, "*");
            window.postMessage({ type: "diff.setEnabled", enabled: true, sessionId: 1, role: "modified",
                originalData: data.slice().buffer, originalFingerprint: "restored-original",
                originalIsEmptyRevision: false, modifiedIsEmptyRevision: false }, "*");
        }, fixturePath);
        await restoredPage.waitForFunction(() => typeof window.__resumeRestoredOpen === "function");
        assert.equal(await restoredPage.evaluate(() => window.__earlyComparisonLoads), 0);
        await restoredPage.evaluate(() => window.__resumeRestoredOpen());
        await restoredPage.waitForFunction(() => window.__academicTestDebug.some(
            m => m.event === "diffComputed" && m.fingerprint === "restored-main"
        ), undefined, { timeout: 10_000 });
        assert.equal(await restoredPage.evaluate(() => window.__earlyComparisonLoads), 1);
        assert.equal(await restoredPage.evaluate(() => window.__academicTestDebug.some(m => m.event === "diffFailed")), false);
    });

    await t.test("isolates scroll anchors across document reloads with highlights disabled", async t => {
        const scrollPage = await browser.newPage({ viewport: { width: 900, height: 500 } });
        scrollPage.setDefaultTimeout(5_000);
        t.after(() => scrollPage.close());
        await scrollPage.addInitScript(() => {
            window.__completedLoads = [];
            window.addEventListener("academic-pdf-document-loaded", event => window.__completedLoads.push(event.detail));
        });
        await scrollPage.goto(`${origin}/__viewer_original_diff_test__.html`);
        await scrollPage.waitForFunction(() => window.__academicTestMessages.some(m => m.type === "webview.ready"));
        const load = async loadId => {
            await scrollPage.evaluate(async ({ loadId, path }) => {
                const data = await (await fetch(path)).arrayBuffer();
                window.postMessage({ type: "document.load", loadId, data, isEmptyRevision: false,
                    fingerprint: `scroll-${loadId}`, preserveView: true }, "*");
            }, { loadId, path: fixturePath });
        };
        const completed = loadId => scrollPage.waitForFunction(id =>
            window.__completedLoads.some(load => load.loadId === id && load.available), loadId);
        const frames = () => scrollPage.evaluate(() => new Promise(resolve =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const apply = (loadId, pageNumber) => scrollPage.evaluate(({ loadId, pageNumber }) => {
            window.postMessage({ type: "diff.applyScroll", loadId, pageNumber,
                pageRatio: 0, documentRatio: pageNumber === 1 ? 0 : 0.8 }, "*");
        }, { loadId, pageNumber });
        const position = () => scrollPage.evaluate(() => window.PDFViewerApplication.pdfViewer.container.scrollTop);
        await load(1);
        await completed(1);
        const initial = await position();
        await apply(99, 2);
        await frames();
        assert.equal(await position(), initial);
        await apply(1, 2);
        await frames();
        assert(await position() > initial + 50);
        await load(2);
        await completed(2);
        const reloaded = await position();
        await apply(1, 1);
        await frames();
        assert.equal(await position(), reloaded);
        await apply(2, 1);
        await frames();
        assert((await position()) <= 2);
        const pausedPosition = await position();
        await scrollPage.evaluate(() => {
            const application = window.PDFViewerApplication;
            const originalOpen = application.open.bind(application);
            application.open = async options => {
                await new Promise(resolve => { window.__resumeOpen = resolve; });
                return originalOpen(options);
            };
        });
        await load(3);
        await scrollPage.waitForFunction(() => typeof window.__resumeOpen === "function");
        const before = await scrollPage.evaluate(() => window.__academicTestMessages.filter(m => m.type === "diff.scroll").length);
        await apply(3, 2);
        await frames();
        assert.equal(await position(), pausedPosition);
        await scrollPage.evaluate(() => { window.PDFViewerApplication.pdfViewer.container.scrollTop = 100; });
        await frames();
        assert.equal(await scrollPage.evaluate(() => window.__academicTestMessages.filter(m => m.type === "diff.scroll").length), before);
        await scrollPage.evaluate(() => window.__resumeOpen());
        await completed(3);
        await scrollPage.evaluate(() => { window.PDFViewerApplication.pdfViewer.container.scrollTop += 50; });
        await scrollPage.waitForFunction(() => window.__academicTestMessages.some(m => m.type === "diff.scroll" && m.loadId === 3));
    });

    await t.test("releases preview URLs, canvases and old Workers through repeated reload and close", async t => {
        const resourcePage = await browser.newPage({ viewport: { width: 900, height: 900 } });
        resourcePage.setDefaultTimeout(5_000);
        t.after(() => resourcePage.close());
        const workers = new Set();
        resourcePage.on("worker", worker => {
            workers.add(worker);
            worker.on("close", () => workers.delete(worker));
        });
        await resourcePage.addInitScript(() => {
            window.__liveUrls = new Set();
            window.__previewCanvases = [];
            const create = URL.createObjectURL.bind(URL);
            const revoke = URL.revokeObjectURL.bind(URL);
            URL.createObjectURL = blob => {
                const url = create(blob);
                window.__liveUrls.add(url);
                return url;
            };
            URL.revokeObjectURL = url => { window.__liveUrls.delete(url); revoke(url); };
            const toBlob = HTMLCanvasElement.prototype.toBlob;
            HTMLCanvasElement.prototype.toBlob = function (...args) {
                window.__previewCanvases.push(this);
                return toBlob.apply(this, args);
            };
            window.__completedLoads = [];
            window.addEventListener("academic-pdf-document-loaded", event => window.__completedLoads.push(event.detail));
        });
        await resourcePage.goto(`${origin}/__viewer_test__.html`);
        await resourcePage.waitForFunction(() => window.__academicTestMessages.some(m => m.type === "webview.ready"));
        for (let loadId = 1; loadId <= 4; loadId++) {
            await resourcePage.evaluate(async ({ loadId, path }) => {
                const data = await (await fetch(path)).arrayBuffer();
                window.postMessage({ type: "document.load", loadId, data, isEmptyRevision: false,
                    fingerprint: `resource-${loadId}`, preserveView: false }, "*");
            }, { loadId, path: fixturePath });
            await resourcePage.waitForFunction(id => window.__completedLoads.some(load => load.loadId === id && load.available), loadId);
            await resourcePage.waitForFunction(() => window.__liveUrls.size === 1);
            const encoded = await resourcePage.evaluate(() => window.__academicTestDebug.filter(m => m.event === "linkPreviewEncoded").length);
            const link = resourcePage.locator(".academic-citation-link").first();
            await link.waitFor();
            const rect = await link.boundingBox();
            assert(rect);
            await resourcePage.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
            await resourcePage.keyboard.down("Control");
            await waitForPreview(resourcePage);
            await resourcePage.waitForFunction(count => window.__academicTestDebug.filter(m => m.event === "linkPreviewEncoded").length > count, encoded);
            await resourcePage.keyboard.up("Control");
            await resourcePage.waitForFunction(() => window.__previewCanvases.every(canvas => canvas.width === 0 && canvas.height === 0));
            assert.equal(await resourcePage.evaluate(() => window.__liveUrls.size), 2);
            assert.equal(workers.size, 1);
        }
        await resourcePage.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
        assert.equal(await resourcePage.evaluate(() => window.__liveUrls.size), 0);
        await resourcePage.close();
        assert.equal(workers.size, 0);
    });

    await t.test("keeps the latest of back-to-back document loads", async () => {
        const reloadPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        const reloadPageErrors = [];
        reloadPage.on("pageerror", error => reloadPageErrors.push(error.stack || error.message));
        await reloadPage.goto(`${origin}/__viewer_diff_test__.html`);
        await reloadPage.waitForFunction(() => window.__academicTestMessages.some(
            message => message.type === "webview.ready"
        ));

        const staleData = createTextPdfPages(["stale page one", "stale page two"]);
        const latestData = createTextPdf("latest document");
        await reloadPage.evaluate(({ stale, latest }) => {
            window.postMessage({
                type: "document.load",
                loadId: 1,
                data: Uint8Array.from(stale).buffer,
                isEmptyRevision: false,
                fingerprint: "stale-load",
                preserveView: false
            }, "*");
            window.postMessage({
                type: "document.load",
                loadId: 2,
                data: Uint8Array.from(latest).buffer,
                isEmptyRevision: false,
                fingerprint: "latest-load",
                preserveView: false
            }, "*");
        }, { stale: [...staleData], latest: [...latestData] });
        await reloadPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "opened" && message.fingerprint === "latest-load"
        ));
        await reloadPage.evaluate(stale => {
            window.postMessage({
                type: "document.load",
                loadId: 1,
                data: Uint8Array.from(stale).buffer,
                isEmptyRevision: false,
                fingerprint: "stale-load-after-latest",
                preserveView: false
            }, "*");
        }, [...staleData]);
        await reloadPage.evaluate(original => {
            window.postMessage({
                type: "diff.setEnabled",
                enabled: true,
                sessionId: 1,
                role: "modified",
                originalData: Uint8Array.from(original).buffer,
                originalFingerprint: "latest-load-original",
                originalIsEmptyRevision: false,
                modifiedIsEmptyRevision: false
            }, "*");
        }, [...latestData]);
        await reloadPage.waitForFunction(() => window.__academicTestDebug.some(
            message => message.event === "diffComputed" && message.fingerprint === "latest-load"
        ), undefined, { timeout: 5_000 });

        assert.equal(await reloadPage.evaluate(() => window.PDFViewerApplication.pdfDocument?.numPages), 1);
        assert.equal(await reloadPage.evaluate(() => window.__academicTestDebug.filter(
            message => message.event === "opened"
        ).at(-1)?.fingerprint), "latest-load");
        assert.equal(await reloadPage.evaluate(() => window.__academicTestDebug.some(
            message => message.fingerprint === "stale-load-after-latest"
        )), false);
        assert.deepEqual(reloadPageErrors, []);
        await reloadPage.close();
    });
});

async function waitForPreview(page) {
    try {
        await page.waitForFunction(() => document.querySelector(
            ".academic-citation-popup.is-open .academic-citation-popup__image"
        ), undefined, { timeout: 5_000 });
    } catch (error) {
        const state = await page.evaluate(() => ({
            currentScale: window.PDFViewerApplication.pdfViewer.currentScale,
            debugEvents: window.__academicTestDebug.map(message => message.event),
            linkRect: document.querySelector(".academic-citation-link")?.getBoundingClientRect().toJSON(),
            popupOpen: document.querySelector(".academic-citation-popup")?.classList.contains("is-open")
        }));
        throw new Error(`Preview did not open: ${JSON.stringify(state)}`, { cause: error });
    }
}

async function openPreparedDiffPage(browser, origin, viewerPathname) {
    const viewerPage = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const pageErrors = [];
    viewerPage.on("pageerror", error => pageErrors.push(error.message));
    await viewerPage.goto(`${origin}${viewerPathname}`);
    await viewerPage.waitForFunction(() => window.__academicTestMessages.some(
        message => message.type === "webview.ready"
    ));
    await viewerPage.evaluate(async pdfPath => {
        const data = await (await fetch(pdfPath)).arrayBuffer();
        window.postMessage({
            type: "document.load",
            loadId: 1,
            data,
            isEmptyRevision: false,
            fingerprint: "visible-page-diff",
            preserveView: false
        }, "*");
    }, fixturePath);
    await viewerPage.waitForFunction(() => window.__academicTestDebug.some(
        message => message.event === "firstPageRendered"
    ));
    await viewerPage.evaluate(() => {
        const viewer = window.PDFViewerApplication.pdfViewer;
        viewer.currentScaleValue = "2";
        viewer.currentPageNumber = 2;
    });
    await viewerPage.waitForFunction(() => {
        const viewer = window.PDFViewerApplication.pdfViewer;
        return viewer.currentPageNumber === 2 && viewer.getPageView(1)?.renderingState === 3;
    });
    await viewerPage.evaluate(() => {
        const viewer = window.PDFViewerApplication.pdfViewer;
        viewer.currentPageNumber = 1;
        viewer.container.scrollTop = 0;
    });
    await viewerPage.waitForFunction(() => {
        const viewer = window.PDFViewerApplication.pdfViewer;
        const containerRect = viewer.container.getBoundingClientRect();
        const secondPage = viewer.getPageView(1);
        return viewer.currentPageNumber === 1
            && viewer.container.scrollTop === 0
            && secondPage?.renderingState === 3
            && secondPage.div.getBoundingClientRect().top >= containerRect.bottom;
    }, undefined, { timeout: 5_000 });
    return { viewerPage, pageErrors };
}

async function browserLaunchOptions() {
    if (process.env.PLAYWRIGHT_BROWSER_EXECUTABLE) {
        await access(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE);
        return { executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE, headless: true };
    }
    return { channel: "msedge", headless: true };
}

async function buildViewerHtml(configOverrides = {}) {
    const { readViewerHtml, renderViewerHtml } = loadSource("extension/viewerHtml.ts", {
        Uri: { joinPath: (_root, ...parts) => ({ toString: () => `/${parts.join("/")}` }) }
    });
    const source = readViewerHtml({ asAbsolutePath: relative => resolve(projectRoot, relative) });
    const html = renderViewerHtml(source, {}, {
        cspSource: "'self'", asWebviewUri: value => value
    }, {
        debug: true,
        linkPreviewEnabled: true,
        linkPreviewResolutionScale: 1,
        mouseNavigationEnabled: true,
        mouseButtonMapping: "standard",
        defaultSidebar: "pages",
        syncTexMode: "doubleclick",
        ...configOverrides
    });
    // The extension HTML and CSP remain intact; only the VS Code API is simulated.
    return html.replace(/(?=<script\s)/, '<script src="/test/viewer/harnessPrelude.js"></script>\n');
}

async function serveRequest(
    requestUrl,
    viewerHtml,
    diffViewerHtml,
    originalDiffViewerHtml,
    outlineSidebarHtml,
    response
) {
    try {
        const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
        if (pathname === "/__viewer_test__.html"
            || pathname === "/__viewer_diff_test__.html"
            || pathname === "/__viewer_original_diff_test__.html"
            || pathname === "/__viewer_outline_test__.html") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(pathname === "/__viewer_diff_test__.html"
                ? diffViewerHtml
                : pathname === "/__viewer_original_diff_test__.html"
                    ? originalDiffViewerHtml
                    : pathname === "/__viewer_outline_test__.html"
                        ? outlineSidebarHtml
                        : viewerHtml);
            return;
        }
        const path = resolve(projectRoot, pathname.replace(/^\/+/, ""));
        if (path !== projectRoot && !path.startsWith(`${projectRoot}${sep}`)) {
            response.writeHead(403).end();
            return;
        }
        const data = await readFile(path);
        response.writeHead(200, { "Content-Type": contentType(path) });
        response.end(data);
    } catch {
        response.writeHead(404).end();
    }
}

function contentType(path) {
    return ({
        ".bcmap": "application/octet-stream",
        ".css": "text/css; charset=utf-8",
        ".ftl": "text/plain; charset=utf-8",
        ".gif": "image/gif",
        ".html": "text/html; charset=utf-8",
        ".icc": "application/octet-stream",
        ".js": "text/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".pdf": "application/pdf",
        ".pfb": "application/octet-stream",
        ".svg": "image/svg+xml",
        ".ttf": "font/ttf",
        ".wasm": "application/wasm"
    })[extname(path)] || "application/octet-stream";
}


function createLinkBorderPdf(userUnit) {
    const borders = [
        "/Border [0 0 1] /C [0 1 0]",
        "/BS << /W 2 /S /D /D [3 2] >> /C [0 1 0]",
        "/BS << /W 1 /S /U >> /C [0 1 0]",
        "/Border [0 0 0] /C [0 1 0]",
        "/Border [0 0 1] /C []"
    ];
    const stream = borders.map((_, index) =>
        `BT /F1 24 Tf 72 ${700 - index * 50} Td ([1]) Tj ET\n`
    ).join("");
    return createPdfFromObjects([
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /UserUnit ${userUnit} /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R /Annots [6 0 R 7 0 R 8 0 R 9 0 R 10 0 R] >>\nendobj\n`,
        `4 0 obj\n<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream\nendobj\n`,
        "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
        ...borders.map((border, index) => {
            const y = 700 - index * 50;
            return `${6 + index} 0 obj\n<< /Type /Annot /Subtype /Link /Rect [72 ${y} 102 ${y + 28}] ${border} /Dest [3 0 R /XYZ 72 400 null] >>\nendobj\n`;
        })
    ]);
}

function createTextPdf(text) {
    return createTextPdfPages([text]);
}

function createTextPdfPages(pageTexts) {
    assert(pageTexts.length > 0);
    return createPdfFromStrings(pageTexts);
}

function createTextPdfPagesWithGeometries(pageTexts, pageGeometries) {
    assert.equal(pageTexts.length, pageGeometries.length);
    return createTextPdfWithCommands(pageTexts.map(text => [
        `(${text.replace(/([\\()])/g, "\\$1")}) Tj`
    ]), { pageGeometries });
}

function createTextPdfWithCommands(pages, options = {}) {
    const firstPageObject = 3;
    const fontObject = firstPageObject + pages.length * 2;
    const pageObjects = Array.from({ length: pages.length }, (_, index) => firstPageObject + index * 2);
    const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        `2 0 obj\n<< /Type /Pages /Kids [${pageObjects.map(id => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>\nendobj\n`
    ];
    for (const [index, commands] of pages.entries()) {
        const geometry = options.pageGeometries?.[index] || options;
        const mediaBox = geometry.mediaBox || [0, 0, 612, 792];
        const userUnit = geometry.userUnit || 1;
        const pageObject = pageObjects[index];
        const contentObject = pageObject + 1;
        const stream = `BT\n/F1 24 Tf\n72 700 Td\n${commands.join("\n")}\nET\n`;
        objects.push(
            `${pageObject} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${mediaBox.join(" ")}] /UserUnit ${userUnit} /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>\nendobj\n`,
            `${contentObject} 0 obj\n<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream\nendobj\n`
        );
    }
    objects.push(`${fontObject} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
    return createPdfFromObjects(objects);
}

function createPdfFromStrings(pageTexts) {
    return createTextPdfWithCommands(pageTexts.map(text => [
        `(${text.replace(/([\\()])/g, "\\$1")}) Tj`
    ]));
}

function createPdfFromObjects(objects) {
    let body = "%PDF-1.4\n";
    const offsets = [0];
    for (const object of objects) {
        offsets.push(Buffer.byteLength(body, "ascii"));
        body += object;
    }
    const xrefOffset = Buffer.byteLength(body, "ascii");
    body += `xref\n0 ${objects.length + 1}\n`;
    body += "0000000000 65535 f \n";
    for (const offset of offsets.slice(1)) {
        body += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
    body += `startxref\n${xrefOffset}\n%%EOF\n`;
    return Buffer.from(body, "ascii");
}
