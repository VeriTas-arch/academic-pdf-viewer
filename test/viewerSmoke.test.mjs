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
    const server = createServer((request, response) => {
        void serveRequest(request.url || "/", html, response);
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

async function browserLaunchOptions() {
    if (process.env.PLAYWRIGHT_BROWSER_EXECUTABLE) {
        await access(process.env.PLAYWRIGHT_BROWSER_EXECUTABLE);
        return { executablePath: process.env.PLAYWRIGHT_BROWSER_EXECUTABLE, headless: true };
    }
    return { channel: "msedge", headless: true };
}

async function buildViewerHtml() {
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
        linkPreviewResolutionScale: 1
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
<script src="/assets/academic/pdfViewerBootstrap.js"></script>
<script src="/assets/pdfviewer/lib/build/pdf.mjs" type="module"></script>
<script src="/assets/pdfviewer/lib/web/viewer.mjs" type="module"></script>
<script src="/assets/academic/reader.js"></script>
<script src="/assets/academic/citationPreview.js"></script>
<script src="/assets/academic/pdfDiff.js" type="module"></script>`;
    return html.replace("<title>PDF.js viewer</title>", `${head}\n<title>Academic PDF Viewer test</title>`);
}

async function serveRequest(requestUrl, viewerHtml, response) {
    try {
        const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
        if (pathname === "/__viewer_test__.html") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(viewerHtml);
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
