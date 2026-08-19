import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const viewerPath = resolve(projectRoot, "assets/pdfviewer/lib/web/viewer.html");
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
    const server = createServer((request, response) => {
        void serveRequest(request.url || "/", html, diffHtml, originalDiffHtml, response);
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
        });
        assert.equal(await page.evaluate(() => window.__academicTestDebug.some(message =>
            message.event === "viewerInitialized" && message.workerSource === "blob"
        )), true);
    });

    await t.test("routes Ctrl+Shift+P to the workbench", async () => {
        await page.keyboard.press("Control+Shift+P");
        await page.waitForFunction(() => window.__academicTestMessages.some(message => message.type === "workbench.showCommands"));
        assert.equal(await page.evaluate(() => window.__academicPrintCalls), 0);
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

    await t.test("restores a stationary preview after Control-wheel zoom", async () => {
        await page.mouse.move(target.x, target.y);
        await page.keyboard.down("Control");
        await waitForPreview(page);
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
            return { top: rect.top, height: rect.height };
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
        const selectedChangeIds = await diffPage.locator(
            '.page[data-page-number="1"] .academicPdfDiffRegion--selected'
        ).evaluateAll(markers => [...new Set(markers.map(marker => marker.dataset.changeId))]);
        assert.equal(selectedChangeIds.length, 1);
        assert.match(selectedChangeIds[0] ?? "", /^1:text-\d+$/u);
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
    let html = await readFile(viewerPath, "utf8");
    html = html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/i, "\n");
    const markers = [
        '<link rel="resource" type="application/l10n" href="locale/locale.json" />',
        '<script src="../build/pdf.mjs" type="module"></script>',
        '<link rel="stylesheet" href="viewer.css" />',
        '<script src="viewer.mjs" type="module"></script>'
    ];
    for (const marker of markers) {
        assert(html.includes(marker), `Missing PDF.js viewer marker: ${marker}`);
        html = html.replace(marker, "");
    }
    const config = escapeHtmlAttribute(JSON.stringify({
        cMapUrl: "/assets/pdfviewer/lib/web/cmaps/",
        debug: true,
        iccUrl: "/assets/pdfviewer/lib/web/iccs/",
        imageResourcesPath: "/assets/pdfviewer/lib/web/images/",
        standardFontDataUrl: "/assets/pdfviewer/lib/web/standard_fonts/",
        wasmUrl: "/assets/pdfviewer/lib/web/wasm/",
        workerSrc: "/assets/pdfviewer/lib/build/pdf.worker.mjs",
        linkPreviewEnabled: true,
        linkPreviewResolutionScale: 1,
        ...configOverrides
    }));
    const head = `
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; worker-src 'self' blob:;">
<meta id="pdf-preview-config" data-config="${config}">
<link rel="resource" type="application/l10n" href="/assets/pdfviewer/lib/web/locale/locale.json">
<link rel="stylesheet" href="/assets/pdfviewer/lib/web/viewer.css">
<link rel="stylesheet" href="/assets/pdfviewer/lib/pdf.css">
<link rel="stylesheet" href="/assets/academic/reader.css">
<link rel="stylesheet" href="/assets/academic/citationPreview.css">
<script src="/test/viewer/harnessPrelude.js"></script>
<script src="/assets/academic/pdfjsAdapter.js"></script>
<script src="/assets/academic/pdfViewerBootstrap.js"></script>
<script src="/assets/pdfviewer/lib/build/pdf.mjs" type="module"></script>
<script src="/assets/pdfviewer/lib/web/viewer.mjs" type="module"></script>
<script src="/assets/academic/reader.js"></script>
<script src="/assets/academic/citationPreview.js"></script>
<script src="/assets/academic/pdfDiff.js" type="module"></script>`;
    return html.replace("<title>PDF.js viewer</title>", `${head}\n<title>Academic PDF Viewer test</title>`);
}

async function serveRequest(requestUrl, viewerHtml, diffViewerHtml, originalDiffViewerHtml, response) {
    try {
        const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
        if (pathname === "/__viewer_test__.html"
            || pathname === "/__viewer_diff_test__.html"
            || pathname === "/__viewer_original_diff_test__.html") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(pathname === "/__viewer_diff_test__.html"
                ? diffViewerHtml
                : pathname === "/__viewer_original_diff_test__.html"
                    ? originalDiffViewerHtml
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

function escapeHtmlAttribute(value) {
    return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function createTextPdf(text) {
    return createTextPdfPages([text]);
}

function createTextPdfPages(pageTexts) {
    assert(pageTexts.length > 0);
    const firstPageObject = 3;
    const fontObject = firstPageObject + pageTexts.length * 2;
    const pageObjects = pageTexts.map((_, index) => firstPageObject + index * 2);
    const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        `2 0 obj\n<< /Type /Pages /Kids [${pageObjects.map(id => `${id} 0 R`).join(" ")}] /Count ${pageTexts.length} >>\nendobj\n`
    ];
    for (const [index, text] of pageTexts.entries()) {
        const pageObject = pageObjects[index];
        const contentObject = pageObject + 1;
        const escapedText = text.replace(/([\\()])/g, "\\$1");
        const stream = `BT\n/F1 24 Tf\n72 700 Td\n(${escapedText}) Tj\nET\n`;
        objects.push(
            `${pageObject} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${contentObject} 0 R >>\nendobj\n`,
            `${contentObject} 0 obj\n<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream\nendobj\n`
        );
    }
    objects.push(`${fontObject} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
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
