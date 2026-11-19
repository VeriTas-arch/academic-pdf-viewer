import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { loadSource } = createRequire(import.meta.url)("../helpers/extensionSource.cjs");
const fixturePath = "/test/fixtures/viewer-smoke.pdf";

test("bundled PDF.js viewer preserves extension behavior", { timeout: 60_000 }, async t => {
    const html = buildViewerHtml();
    const diffHtml = buildViewerHtml({
        diffRole: "modified",
        diffLabel: "Working tree"
    });
    const server = createServer((request, response) => {
        void serveRequest(
            request.url || "/",
            html,
            diffHtml,
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
    const executablePath = process.env.PLAYWRIGHT_BROWSER_EXECUTABLE;
    const browser = await chromium.launch(executablePath ? { executablePath } : { channel: "msedge" });
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
    await waitForFirstPage(page, 1);

    await t.test("opens a PDF with an offline bundled Worker", async () => {
        assert.deepEqual([...externalRequests, ...failedRequests, ...httpErrors, ...pageErrors], []);
        assert(page.workers().length > 0);
    });

    await t.test("renders from ranges and cancels a blocked range load on replacement", async () => {
        const rangePage = await browser.newPage();
        try {
            const padding = "x".repeat(1200 * 1024);
            const pageCommands = "0 0 0 rg 0 0 4 4 re f\n";
            const bytes = createPdfFromObjects([
                "1 0 obj\n<< /Type /Catalog /Pages 2 0 R /AcroForm 6 0 R >>\nendobj\n",
                "2 0 obj\n<< /Type /Pages /Count 1 /Kids [3 0 R] >>\nendobj\n",
                "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R /Annots [7 0 R] >>\nendobj\n",
                `4 0 obj\n<< /Length ${pageCommands.length} >>\nstream\n${pageCommands}endstream\nendobj\n`,
                `5 0 obj\n<< /Length ${padding.length} >>\nstream\n${padding}\nendstream\nendobj\n`,
                "6 0 obj\n<< /Fields [7 0 R] /DA (/Helv 12 Tf 0 g) /DR << /Font << /Helv 8 0 R >> >> >>\nendobj\n",
                "7 0 obj\n<< /Type /Annot /Subtype /Widget /FT /Tx /T (Topic) /V (Before) /Rect [70 690 240 720] /P 3 0 R /F 4 >>\nendobj\n",
                "8 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
            ]);
            await rangePage.route("**/__range_fixture__.pdf", route => route.fulfill({ body: bytes }));
            await rangePage.goto(`${origin}/__viewer_test__.html`);
            await rangePage.waitForFunction(() => window.__academicTestMessages.some(message => message.type === "webview.ready"));
            await rangePage.evaluate(async () => {
                const data = await (await fetch("/__range_fixture__.pdf")).arrayBuffer();
                window.__rangedFixture = data;
                window.__rangeSent = 0;
                window.__closedRanges = [];
                window.__loadCompletions = [];
                window.addEventListener("academic-pdf-document-loaded", event => window.__loadCompletions.push(event.detail));
                window.addEventListener("academic-test-message", ({ detail: request }) => {
                    if (request.type === "document.rangeClose") {
                        window.__closedRanges.push(request.loadId);
                    }
                    if (request.type === "document.rangeRequest" && !window.__blockRange
                        && !window.__closedRanges.includes(request.loadId)) {
                        window.__rangeSent += request.length;
                        window.postMessage({
                            type: "document.rangeData", loadId: request.loadId, requestId: request.requestId,
                            data: data.slice(request.begin, request.begin + request.length)
                        }, "*");
                    }
                });
                window.__loadRange = (loadId, fingerprint) => window.postMessage({
                    type: "document.loadRange", loadId, size: data.byteLength, data: data.slice(0, 65536),
                    filename: "large.pdf", fingerprint, preserveView: false
                }, "*");
                window.__loadRange(1, "large-range");
            });
            await waitForFirstPage(rangePage, 1);
            assert(await rangePage.evaluate(() => window.__rangeSent + 65536 < window.__rangedFixture.byteLength / 2));
            await rangePage.locator(".textWidgetAnnotation input").fill("Saved when reloaded");
            const saved = rangePage.waitForEvent("download");
            await rangePage.evaluate(() => window.__loadRange(2, "range-after-form-save"));
            assert.equal((await saved).suggestedFilename(), "large.pdf");
            await rangePage.waitForFunction(() => window.__loadCompletions.some(result =>
                result.loadId === 2 && result.available
            ), undefined, { timeout: 8_000 });
            await rangePage.evaluate(() => window.__loadRange(3, "range-before-replacement"));
            await waitForFirstPage(rangePage, 3);
            const beforeBlockedRead = await rangePage.evaluate(() => {
                const offset = window.__academicTestMessages.length;
                window.__blockRange = true;
                window.PDFViewerApplication.pdfDocument.getData().catch(() => {});
                return offset;
            });
            await rangePage.waitForFunction(offset => window.__academicTestMessages.slice(offset).some(message =>
                message.type === "document.rangeRequest" && message.loadId === 3
            ), beforeBlockedRead);
            await rangePage.evaluate(async pdfPath => {
                const data = await (await fetch(pdfPath)).arrayBuffer();
                window.postMessage({
                    type: "document.load", loadId: 4, data, isEmptyRevision: false,
                    fingerprint: "range-replacement", preserveView: false
                }, "*");
            }, fixturePath);
            await waitForFirstPage(rangePage, 4);
            assert(await rangePage.evaluate(() => window.__academicTestMessages.some(message =>
                message.type === "document.rangeClose" && message.loadId === 3
            )));
            await rangePage.evaluate(async pdfPath => {
                const data = await (await fetch(pdfPath)).arrayBuffer();
                const adapter = window.academicPdfJsAdapter;
                const restore = adapter.restoreSidebarState;
                adapter.restoreSidebarState = () => {
                    adapter.restoreSidebarState = restore;
                    throw new Error("Injected viewer state restoration failure");
                };
                window.postMessage({
                    type: "document.load", loadId: 5, data, isEmptyRevision: false,
                    fingerprint: "failed-restore", preserveView: true
                }, "*");
                window.__retryAfterRestore = () => window.postMessage({
                    type: "document.load", loadId: 6, data, isEmptyRevision: false,
                    fingerprint: "recovered-restore", preserveView: false
                }, "*");
            }, fixturePath);
            await rangePage.waitForFunction(() => window.__loadCompletions.some(result =>
                result.loadId === 5 && !result.available
            ), undefined, { timeout: 8_000 });
            await rangePage.evaluate(() => window.__retryAfterRestore());
            await rangePage.waitForFunction(() => window.__loadCompletions.some(result =>
                result.loadId === 6 && result.available
            ), undefined, { timeout: 8_000 });
        } finally {
            await rangePage.close();
        }
    });

    await t.test("routes workbench shortcuts and restores PDF navigation history", async () => {
        await page.keyboard.press("Control+P");
        await page.waitForFunction(() => window.__academicTestMessages.some(message => message.type === "workbench.quickOpen"));
        assert.equal(await page.evaluate(() => window.__academicPrintCalls), 0);
        await page.locator("#next").click();
        await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentPageNumber === 2);
        await page.keyboard.press("Alt+ArrowLeft");
        await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentPageNumber === 1);
        await page.keyboard.press("Alt+ArrowRight");
        await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentPageNumber === 2);
        await page.locator("#previous").click();
        await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentPageNumber === 1);
    });

    await t.test("opens an internal link preview in either Control-hover order", async () => {
        const link = page.locator(".academic-citation-link").first();
        await link.hover();
        await page.keyboard.down("Control");
        await waitForPreview(page);
        await page.keyboard.up("Control");
        const popup = page.locator(".academic-citation-popup.is-open");
        await popup.waitFor({ state: "hidden" });
        await page.mouse.move(4, 4);
        await page.keyboard.down("Control");
        await link.hover();
        await waitForPreview(page);
        await page.keyboard.up("Control");
    });

    await t.test("applies a SyncTeX request for the loaded PDF and emits inverse search on the page", async () => {
        const request = { type: "synctex.forward", requestId: "forward", loadId: 1, pageNumber: 2, x: 72, y: 72 };
        await page.evaluate(message => window.postMessage(message, "*"), request);
        await page.waitForFunction(id => window.__academicTestMessages.some(message =>
            message.type === "synctex.forwardResult" && message.requestId === id && message.status === "applied"
        ), request.requestId);
        assert.equal(await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentPageNumber), request.pageNumber);

        await page.locator(`.page[data-page-number="${request.pageNumber}"]`)
            .dblclick({ position: { x: 20, y: 20 }, timeout: 5_000 });
        await page.waitForFunction(pageNumber => window.__academicTestMessages.some(message =>
            message.type === "synctex.inverse" && message.pageNumber === pageNumber
        ), request.pageNumber);
    });

    await t.test("shows real PDF revision changes and clears them after a failed comparison", async t => {
        const diffPage = await browser.newPage();
        t.after(() => diffPage.close());
        await diffPage.goto(`${origin}/__viewer_diff_test__.html`);
        await diffPage.waitForFunction(() => window.__academicTestMessages.some(message => message.type === "webview.ready"));
        await diffPage.evaluate(async ({ pdfPath, original }) => {
            const modified = await (await fetch(pdfPath)).arrayBuffer();
            const pdfjs = window.pdfjsLib;
            window.pdfjsLib = { ...pdfjs, getDocument(options) {
                window.pdfjsLib = pdfjs;
                const task = pdfjs.getDocument(options);
                const gate = new Promise(resolve => { window.__continueComparison = resolve; });
                return { promise: gate.then(() => task.promise), destroy: () => task.destroy() };
            } };
            window.postMessage({
                type: "document.load", loadId: 1, data: modified,
                fingerprint: "modified", isEmptyRevision: false, preserveView: false
            }, "*");
            window.__compare = (sessionId, data) => window.postMessage({
                type: "diff.setEnabled", enabled: true, sessionId, role: "modified",
                originalData: Uint8Array.from(data).buffer,
                originalIsEmptyRevision: false, modifiedIsEmptyRevision: false
            }, "*");
            window.__compare(1, original);
        }, { pdfPath: fixturePath, original: [...createOriginalPdf()] });

        await diffPage.waitForFunction(() => typeof window.__continueComparison === "function");
        const showedChangesBeforeOriginal = await diffPage.evaluate(async () => {
            window.postMessage({ type: "diff.navigate", sessionId: 1, direction: "next" }, "*");
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return window.__academicTestMessages.some(message => message.type === "diff.pageResult");
        });
        assert.equal(showedChangesBeforeOriginal, false);
        await diffPage.evaluate(() => window.__continueComparison());
        const region = diffPage.locator(".academicPdfDiffRegion").first();
        await region.waitFor({ state: "visible" });
        await diffPage.evaluate(() => window.__compare(2, [1]));
        await diffPage.waitForFunction(() => window.__academicTestMessages.some(message =>
            message.type === "diff.failed" && message.sessionId === 2
        ));
        await region.waitFor({ state: "hidden" });
        assert(await diffPage.evaluate(() => window.PDFViewerApplication.pdfDocument !== null));
    });

    await t.test("preserves zoom after a Control-wheel change and reload", async () => {
        const previousScale = await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale);
        await page.mouse.move(150, 150);
        await page.keyboard.down("Control");
        await page.mouse.wheel(0, -60);
        await page.keyboard.up("Control");
        await page.waitForFunction(previous => window.PDFViewerApplication.pdfViewer.currentScale > previous, previousScale);
        const scale = await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale);
        await page.evaluate(async pdfPath => {
            const loaded = new Promise(resolve => window.addEventListener("academic-pdf-document-loaded", resolve, { once: true }));
            const data = await (await fetch(pdfPath)).arrayBuffer();
            window.postMessage({
                type: "document.load", loadId: 2, data,
                isEmptyRevision: false, fingerprint: "zoom-reload", preserveView: true
            }, "*");
            await loaded;
        }, fixturePath);
        assert.equal(await page.evaluate(() => window.PDFViewerApplication.pdfViewer.currentScale), scale);
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
        for (let loadId = 1; loadId <= 2; loadId++) {
            await resourcePage.evaluate(async ({ loadId, path }) => {
                const data = await (await fetch(path)).arrayBuffer();
                window.postMessage({ type: "document.load", loadId, data, isEmptyRevision: false,
                    fingerprint: `resource-${loadId}`, preserveView: false }, "*");
            }, { loadId, path: fixturePath });
            await resourcePage.waitForFunction(id => window.__completedLoads.some(load => load.loadId === id && load.available), loadId);
            await resourcePage.waitForFunction(() => window.__liveUrls.size === 1);
            const previousCanvases = await resourcePage.evaluate(() => window.__previewCanvases.length);
            const link = resourcePage.locator(".academic-citation-link").first();
            await link.waitFor();
            const rect = await link.boundingBox();
            assert(rect);
            await resourcePage.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
            await resourcePage.keyboard.down("Control");
            await waitForPreview(resourcePage);
            await resourcePage.waitForFunction(count => window.__previewCanvases.length > count, previousCanvases);
            await resourcePage.keyboard.up("Control");
            await resourcePage.waitForFunction(() => window.__previewCanvases.every(canvas => canvas.width === 0 && canvas.height === 0));
            assert.equal(workers.size, 1);
        }
        await resourcePage.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
        assert.equal(await resourcePage.evaluate(() => window.__liveUrls.size), 0);
        await resourcePage.close();
        assert.equal(workers.size, 0);
    });
});

function waitForPreview(page) {
    return page.locator(".academic-citation-popup.is-open .academic-citation-popup__image").waitFor();
}

function waitForFirstPage(page, loadId) {
    return page.waitForFunction(id => performance.getEntriesByName("Academic PDF Viewer: first page")
        .some(entry => entry.detail === id), loadId, { timeout: 8_000 });
}

function buildViewerHtml(configOverrides = {}) {
    const { readViewerHtml, renderViewerHtml } = loadSource("extension/viewerHtml.ts", {
        Uri: { joinPath: (_root, ...parts) => ({ toString: () => `/${parts.join("/")}` }) }
    });
    const source = readViewerHtml({ asAbsolutePath: relative => resolve(projectRoot, relative) });
    const html = renderViewerHtml(source, {}, {
        cspSource: "'self'", asWebviewUri: value => value
    }, {
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
    response
) {
    try {
        const pathname = decodeURIComponent(new URL(requestUrl, "http://127.0.0.1").pathname);
        if (pathname === "/__viewer_test__.html" || pathname === "/__viewer_diff_test__.html") {
            response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            response.end(pathname === "/__viewer_test__.html" ? viewerHtml : diffViewerHtml);
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


function createOriginalPdf() {
    const stream = "BT /F1 24 Tf 72 700 Td (Original text) Tj ET";
    return createPdfFromObjects([
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
        `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
        "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
    ]);
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
