import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';

import type { MouseButtonMapping, SidebarView } from '../shared/protocol';

const VIEWER_HTML_RELATIVE_PATH = ['assets', 'pdfviewer', 'lib', 'web', 'viewer.html'];

interface ViewerHtmlOptions {
    debug: boolean;
    diffRole?: 'original' | 'modified';
    diffLabel?: string;
    linkPreviewEnabled: boolean;
    linkPreviewResolutionScale: number;
    mouseNavigationEnabled: boolean;
    mouseButtonMapping: MouseButtonMapping;
    defaultSidebar: SidebarView;
    syncTexMode: 'off' | 'doubleclick' | 'rightclick';
}

export function readViewerHtml(context: vscode.ExtensionContext): string {
    const viewerPath = context.asAbsolutePath(VIEWER_HTML_RELATIVE_PATH.join('/'));
    let html = readFileSync(viewerPath, 'utf8');
    if (!html.includes('<title>PDF.js viewer</title>')) {
        throw new Error('Unsupported PDF.js viewer.html: missing title marker.');
    }
    const cspPattern = /\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>\s*/i;
    if (!cspPattern.test(html)) {
        throw new Error('Unsupported PDF.js viewer.html: missing Content-Security-Policy marker.');
    }
    html = html.replace(cspPattern, '\n');

    const markers = [
        '<link rel="resource" type="application/l10n" href="locale/locale.json" />',
        '<script src="../build/pdf.mjs" type="module"></script>',
        '<link rel="stylesheet" href="viewer.css" />',
        '<script src="viewer.mjs" type="module"></script>',
    ];
    for (const marker of markers) {
        if (!html.includes(marker)) {
            throw new Error(`Unsupported PDF.js viewer.html: missing marker ${marker}`);
        }
        html = html.replace(marker, '');
    }
    return html;
}

export function renderViewerHtml(
    viewerHtml: string,
    extensionUri: vscode.Uri,
    webview: vscode.Webview,
    options: ViewerHtmlOptions,
): string {
    const assetUri = (...paths: string[]): string => webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'assets', ...paths),
    ).toString();
    const libUri = (...paths: string[]): string => webview.asWebviewUri(
        vscode.Uri.joinPath(extensionUri, 'assets', 'pdfviewer', 'lib', ...paths),
    ).toString();
    const settings = {
        cMapUrl: `${libUri('web', 'cmaps')}/`,
        debug: options.debug,
        iccUrl: `${libUri('web', 'iccs')}/`,
        imageResourcesPath: `${libUri('web', 'images')}/`,
        standardFontDataUrl: `${libUri('web', 'standard_fonts')}/`,
        wasmUrl: `${libUri('web', 'wasm')}/`,
        workerSrc: libUri('build', 'pdf.worker.mjs'),
        diffRole: options.diffRole,
        diffLabel: options.diffLabel,
        linkPreviewEnabled: options.linkPreviewEnabled,
        linkPreviewResolutionScale: options.linkPreviewResolutionScale,
        mouseNavigationEnabled: options.mouseNavigationEnabled,
        mouseButtonMapping: options.mouseButtonMapping,
        defaultSidebar: options.defaultSidebar,
        syncTexMode: options.syncTexMode,
    };
    const config = escapeHtmlAttribute(JSON.stringify(settings));

    // The webview reads the bundled worker into a blob URL before PDF.js
    // starts it, because workers cannot directly load webview resources.
    const injectedHead = `
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; connect-src ${webview.cspSource}; script-src 'wasm-unsafe-eval' blob: ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src blob: data: ${webview.cspSource}; media-src blob:; font-src data: ${webview.cspSource}; worker-src blob: ${webview.cspSource}; form-action 'none';">
<meta id="pdf-preview-config" data-config="${config}">
<link rel="resource" type="application/l10n" href="${escapeHtmlAttribute(libUri('web', 'locale', 'locale.json'))}">
<link rel="stylesheet" href="${escapeHtmlAttribute(libUri('web', 'viewer.css'))}">
<link rel="stylesheet" href="${escapeHtmlAttribute(libUri('pdf.css'))}">
<link rel="stylesheet" href="${escapeHtmlAttribute(assetUri('academic', 'reader.css'))}">
<link rel="stylesheet" href="${escapeHtmlAttribute(assetUri('academic', 'citationPreview.css'))}">
<script src="${escapeHtmlAttribute(assetUri('academic', 'pdfjsAdapter.js'))}"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'pdfViewerBootstrap.js'))}"></script>
<script src="${escapeHtmlAttribute(libUri('build', 'pdf.mjs'))}" type="module"></script>
<script src="${escapeHtmlAttribute(libUri('web', 'viewer.mjs'))}" type="module"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'reader.js'))}"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'citationPreview.js'))}" type="module"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'pdfDiff.js'))}" type="module"></script>`;

    return viewerHtml
        .replace('<title>PDF.js viewer</title>', `${injectedHead}\n<title>Academic PDF Viewer</title>`)
        .trim();
}

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
