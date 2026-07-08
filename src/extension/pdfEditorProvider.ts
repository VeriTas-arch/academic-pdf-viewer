import * as vscode from 'vscode';
import { readFileSync } from 'node:fs';

import type { ExtensionToWebviewMessage, NavigationDirection, WebviewToExtensionMessage } from '../shared/protocol';

export const PDF_VIEW_TYPE = 'academicPdfViewer.pdf';

const VIEWER_HTML_RELATIVE_PATH = ['assets', 'pdfviewer', 'lib', 'web', 'viewer.html'];

class PdfDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}

    dispose(): void {}
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
    private static readonly navigationKeyFallbackReleaseMs = 800;

    private readonly panels = new Set<vscode.WebviewPanel>();
    private readonly navigationKeyLocks = new Map<NavigationDirection, ReturnType<typeof setTimeout>>();
    private activePanel: vscode.WebviewPanel | undefined;
    private readonly viewerHtml: string;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.viewerHtml = readViewerHtml(context);
    }

    openCustomDocument(uri: vscode.Uri): PdfDocument {
        return new PdfDocument(uri);
    }

    async resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
        this.panels.add(panel);
        this.activePanel = panel;

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'assets'),
                vscode.Uri.joinPath(document.uri, '..'),
                ...(vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? []),
            ],
        };

        panel.onDidChangeViewState(event => {
            if (event.webviewPanel.active) {
                this.activePanel = event.webviewPanel;
            }
        });

        panel.onDidDispose(() => {
            this.panels.delete(panel);
            if (this.activePanel === panel) {
                this.activePanel = this.panels.values().next().value;
            }
        });

        panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
            this.handleWebviewMessage(message);
        });

        panel.webview.html = this.createHtml(panel.webview, document.uri);
    }

    postToActive(message: ExtensionToWebviewMessage): void {
        void this.activePanel?.webview.postMessage(message);
    }

    navigate(direction: NavigationDirection): void {
        if (this.navigationKeyLocks.has(direction)) {
            this.armNavigationKeyFallbackRelease(direction);
            return;
        }

        this.armNavigationKeyFallbackRelease(direction);
        this.postToActive({
            type: direction === 'back' ? 'navigation.back' : 'navigation.forward',
        });
    }

    private handleWebviewMessage(message: WebviewToExtensionMessage): void {
        if (message.type === 'navigation.keyUp') {
            this.releaseNavigationKeyLock(message.direction);
        }
    }

    private armNavigationKeyFallbackRelease(direction: NavigationDirection): void {
        const existingTimer = this.navigationKeyLocks.get(direction);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        const timer = setTimeout(() => {
            this.navigationKeyLocks.delete(direction);
        }, PdfEditorProvider.navigationKeyFallbackReleaseMs);
        this.navigationKeyLocks.set(direction, timer);
    }

    private releaseNavigationKeyLock(direction: NavigationDirection): void {
        const timer = this.navigationKeyLocks.get(direction);
        if (!timer) {
            return;
        }

        clearTimeout(timer);
        this.navigationKeyLocks.delete(direction);
    }

    private createHtml(webview: vscode.Webview, pdfUri: vscode.Uri): string {
        const webviewPdfUri = webview.asWebviewUri(pdfUri);
        const assetUri = (...paths: string[]): string => webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'assets', ...paths),
        ).toString();
        const libUri = (...paths: string[]): string => webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'pdfviewer', 'lib', ...paths),
        ).toString();
        const settings = {
            cMapUrl: `${libUri('web', 'cmaps')}/`,
            path: webviewPdfUri.toString(),
            standardFontDataUrl: `${libUri('web', 'standard_fonts')}/`,
            defaults: {
                cursor: 'text',
                scale: 'auto',
                sidebar: false,
                scrollMode: 'vertical',
                spreadMode: 'none',
            },
        };
        const config = escapeHtmlAttribute(JSON.stringify(settings));

        const injectedHead = `
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource}; style-src 'unsafe-inline' ${webview.cspSource}; img-src blob: data: ${webview.cspSource}; font-src ${webview.cspSource}; worker-src blob: ${webview.cspSource};">
<meta id="pdf-preview-config" data-config="${config}">
<link rel="resource" type="application/l10n" href="${escapeHtmlAttribute(libUri('web', 'locale', 'locale.properties'))}">
<link rel="stylesheet" href="${escapeHtmlAttribute(libUri('web', 'viewer.css'))}">
<link rel="stylesheet" href="${escapeHtmlAttribute(libUri('pdf.css'))}">
<link rel="stylesheet" href="${escapeHtmlAttribute(assetUri('academic', 'reader.css'))}">
<link rel="stylesheet" href="${escapeHtmlAttribute(assetUri('academic', 'citationPreview.css'))}">
<script src="${escapeHtmlAttribute(libUri('build', 'pdf.js'))}"></script>
<script src="${escapeHtmlAttribute(libUri('build', 'pdf.worker.js'))}"></script>
<script src="${escapeHtmlAttribute(libUri('web', 'viewer.js'))}"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'reader.js'))}"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'citationPreview.js'))}"></script>
<script src="${escapeHtmlAttribute(libUri('main.js'))}"></script>`;

        return this.viewerHtml
            .replace('<title>PDF.js viewer</title>', `${injectedHead}\n<title>Academic PDF Viewer</title>`)
            .trim();
    }
}

function readViewerHtml(context: vscode.ExtensionContext): string {
    const viewerPath = context.asAbsolutePath(VIEWER_HTML_RELATIVE_PATH.join('/'));
    return readFileSync(viewerPath, 'utf8')
        .replace('<link rel="resource" type="application/l10n" href="locale/locale.json">', '')
        .replace('<link rel="resource" type="application/l10n" href="locale/locale.properties">', '')
        .replace('<script src="../build/pdf.js"></script>', '')
        .replace('<script src="../build/pdf.mjs" type="module"></script>', '')
        .replace('<link rel="stylesheet" href="viewer.css">', '')
        .replace('<script src="viewer.js"></script>', '')
        .replace('<script src="viewer.mjs" type="module"></script>', '');
}

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
