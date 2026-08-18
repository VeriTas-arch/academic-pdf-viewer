import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';

import {
    isWebviewToExtensionMessage,
    type ExtensionToWebviewMessage,
    type NavigationDirection,
    type WebviewToExtensionMessage,
} from '../shared/protocol';
import type { DevLogFields, DevLogger } from './devLogger';

export const PDF_VIEW_TYPE = 'academicPdfViewer.pdf';

const VIEWER_HTML_RELATIVE_PATH = ['assets', 'pdfviewer', 'lib', 'web', 'viewer.html'];
const MAX_PDF_BYTES = 512 * 1024 * 1024;

async function readPdfData(uri: vscode.Uri, logger?: DevLogger): Promise<Uint8Array> {
    const startedAt = Date.now();
    const fields = describePdfUri(uri);
    const source = uri.scheme === 'git' ? 'gitBlob' : 'workspaceFs';
    logger?.info('pdf.read.start', { ...fields, source });

    try {
        let data: Uint8Array;
        if (uri.scheme === 'git') {
            data = await readGitBlob(uri, logger);
        } else {
            const stat = await vscode.workspace.fs.stat(uri);
            assertPdfSize(stat.size);
            data = await vscode.workspace.fs.readFile(uri);
        }
        assertPdfSize(data.byteLength);
        logger?.info('pdf.read.done', {
            ...fields,
            source,
            bytes: data.byteLength,
            durationMs: Date.now() - startedAt,
        });
        return data;
    } catch (error) {
        logger?.error('pdf.read.failed', error, {
            ...fields,
            source,
            durationMs: Date.now() - startedAt,
        });
        throw error;
    }
}

async function readGitBlob(uri: vscode.Uri, logger?: DevLogger): Promise<Uint8Array> {
    const startedAt = Date.now();
    const query = JSON.parse(uri.query) as Record<string, unknown>;
    if (typeof query.path !== 'string' || typeof query.ref !== 'string') {
        throw new Error(`Invalid Git URI: ${uri.toString()}`);
    }

    const repositoryRoot = (await runGit(['rev-parse', '--show-toplevel'], dirname(query.path)))
        .toString('utf8')
        .trim();
    const repositoryPath = relative(repositoryRoot, query.path);
    if (repositoryPath === '..' || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) {
        throw new Error(`PDF is outside its Git repository: ${query.path}`);
    }

    const gitPath = repositoryPath.replace(/\\/g, '/');
    const objectName = query.ref === '~' || query.ref === ''
        ? `:${gitPath}`
        : `${query.ref}:${gitPath}`;
    const fields = { repositoryRoot, objectName };
    logger?.info('git.blob.start', fields);

    try {
        const sizeOutput = await runGit(['cat-file', '-s', '--', objectName], repositoryRoot, true);
        if (sizeOutput.byteLength === 0) {
            logger?.warn('git.blob.missing', {
                ...fields,
                bytes: 0,
                durationMs: Date.now() - startedAt,
            });
            return new Uint8Array();
        }

        const size = Number(sizeOutput.toString('utf8').trim());
        if (!Number.isSafeInteger(size) || size < 0) {
            throw new Error(`Git returned an invalid PDF size for ${objectName}.`);
        }
        assertPdfSize(size);

        const data = await runGit(['cat-file', 'blob', '--', objectName], repositoryRoot, true);
        const resultFields = {
            ...fields,
            bytes: data.byteLength,
            durationMs: Date.now() - startedAt,
        };
        if (data.byteLength === 0) {
            logger?.warn('git.blob.missing', resultFields);
        } else {
            logger?.info('git.blob.done', resultFields);
        }
        return data;
    } catch (error) {
        logger?.error('git.blob.failed', error, {
            ...fields,
            durationMs: Date.now() - startedAt,
        });
        throw error;
    }
}

function describePdfUri(uri: vscode.Uri): DevLogFields {
    if (uri.scheme !== 'git') {
        return { scheme: uri.scheme, path: uri.fsPath };
    }

    try {
        const query = JSON.parse(uri.query) as Record<string, unknown>;
        return { scheme: uri.scheme, path: query.path, ref: query.ref };
    } catch {
        return { scheme: uri.scheme, uri: uri.toString() };
    }
}

function copyToArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
}

function assertPdfSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('PDF has an invalid file size.');
    }
    if (size > MAX_PDF_BYTES) {
        throw new Error('PDF exceeds the 512 MiB safety limit.');
    }
}

function runGit(args: string[], cwd: string, missingIsEmpty = false): Promise<Buffer> {
    const configuredGitPath = vscode.workspace.getConfiguration('git').get<string>('path');
    return new Promise((resolve, reject) => {
        execFile(configuredGitPath || 'git', args, {
            cwd,
            encoding: null,
            maxBuffer: MAX_PDF_BYTES,
        }, (error, stdout, stderr) => {
            if (!error) {
                resolve(stdout);
                return;
            }
            if (missingIsEmpty && error.code === 128) {
                resolve(Buffer.alloc(0));
                return;
            }

            const detail = stderr.toString('utf8').trim() || error.message;
            reject(new Error(`Git ${args[0]} failed: ${detail}`));
        });
    });
}

class PdfDocument implements vscode.CustomDocument {
    constructor(
        public readonly uri: vscode.Uri,
        public data: Uint8Array,
    ) { }

    dispose(): void { }
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
    private static readonly navigationKeyFallbackReleaseMs = 800;

    private readonly panels = new Set<vscode.WebviewPanel>();
    private readonly panelDocuments = new Map<vscode.WebviewPanel, PdfDocument>();
    private readonly diffTargetPanels = new Map<vscode.WebviewPanel, vscode.WebviewPanel>();
    private readonly diffOriginalDocuments = new Map<vscode.WebviewPanel, PdfDocument>();
    private readonly diffHighlightsEnabled = new Set<vscode.WebviewPanel>();
    private readonly navigationKeyLocks = new Map<NavigationDirection, ReturnType<typeof setTimeout>>();
    private activePanel: vscode.WebviewPanel | undefined;
    private readonly viewerHtml: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger?: DevLogger,
    ) {
        this.viewerHtml = readViewerHtml(context);
    }

    async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
        const data = await readPdfData(uri, this.logger);
        return new PdfDocument(uri, data);
    }

    async resolveCustomEditor(document: PdfDocument, panel: vscode.WebviewPanel): Promise<void> {
        this.logger?.info('editor.resolve', {
            ...describePdfUri(document.uri),
            bytes: document.data.byteLength,
        });
        this.panels.add(panel);
        this.panelDocuments.set(panel, document);
        this.activePanel = panel;
        const panelDisposables: vscode.Disposable[] = [];

        panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'assets'),
            ],
        };

        panelDisposables.push(
            panel.onDidChangeViewState(event => {
                if (event.webviewPanel.active) {
                    this.activePanel = event.webviewPanel;
                }
            }),
        );

        panel.onDidDispose(() => {
            for (const disposable of panelDisposables) {
                disposable.dispose();
            }
            this.panels.delete(panel);
            this.panelDocuments.delete(panel);
            this.forgetDiffPanel(panel);
            if (this.activePanel === panel) {
                this.activePanel = this.panels.values().next().value;
            }
        });

        panelDisposables.push(
            panel.webview.onDidReceiveMessage((message: unknown) => {
                if (!isWebviewToExtensionMessage(message)) {
                    this.logger?.warn('webview.message.rejected');
                    return;
                }
                this.handleWebviewMessage(message, panel, document);
            }),
        );

        panel.webview.html = this.createHtml(panel.webview, document.uri);
    }

    async resolveCustomEditorSideBySideDiff(
        documents: vscode.CustomEditorDiffDocuments<PdfDocument>,
        panels: vscode.CustomEditorSideBySideDiffWebviewPanels,
    ): Promise<void> {
        this.logger?.info('diff.resolve', {
            originalUri: documents.original.uri.toString(),
            originalBytes: documents.original.data.byteLength,
            modifiedUri: documents.modified.uri.toString(),
            modifiedBytes: documents.modified.data.byteLength,
        });
        this.diffTargetPanels.set(panels.original, panels.modified);
        this.diffTargetPanels.set(panels.modified, panels.modified);
        this.diffOriginalDocuments.set(panels.modified, documents.original);
        await Promise.all([
            this.resolveCustomEditor(documents.original, panels.original),
            this.resolveCustomEditor(documents.modified, panels.modified),
        ]);
    }

    async toggleDiffHighlights(): Promise<boolean | undefined> {
        const modifiedPanel = this.activePanel && this.diffTargetPanels.get(this.activePanel);
        const originalDocument = modifiedPanel && this.diffOriginalDocuments.get(modifiedPanel);
        if (!modifiedPanel || !originalDocument) {
            return undefined;
        }

        const enabled = !this.diffHighlightsEnabled.has(modifiedPanel);
        const message: ExtensionToWebviewMessage = enabled
            ? {
                type: 'diff.setEnabled',
                enabled: true,
                originalData: copyToArrayBuffer(originalDocument.data),
                originalFingerprint: originalDocument.uri.toString(),
                originalIsEmptyRevision: originalDocument.data.byteLength === 0,
            }
            : { type: 'diff.setEnabled', enabled: false };
        const delivered = await modifiedPanel.webview.postMessage(message);
        if (!delivered) {
            this.logger?.warn('visualDiff.toggle.notDelivered', { enabled });
            return undefined;
        }

        if (enabled) {
            this.diffHighlightsEnabled.add(modifiedPanel);
        } else {
            this.diffHighlightsEnabled.delete(modifiedPanel);
        }
        this.logger?.info('visualDiff.toggled', {
            enabled,
            originalUri: originalDocument.uri.toString(),
            modifiedUri: this.panelDocuments.get(modifiedPanel)?.uri.toString(),
        });
        return enabled;
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

    async reloadActive(): Promise<void> {
        const panel = this.activePanel;
        const document = panel && this.panelDocuments.get(panel);
        if (!panel || !document) {
            return;
        }

        try {
            document.data = await readPdfData(document.uri, this.logger);
            await this.postDocument(panel, document, true);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Unable to reload PDF: ${detail}`);
        }
    }

    async toggleLinkPreviewActive(): Promise<boolean | undefined> {
        const document = this.activePanel && this.panelDocuments.get(this.activePanel);
        if (!document) {
            return undefined;
        }
        const documentUri = document.uri;

        const configuration = vscode.workspace.getConfiguration('academicPdfViewer', documentUri);
        const setting = 'linkPreview.enabled';
        const enabled = configuration.get<boolean>(setting, true);
        const inspected = configuration.inspect<boolean>(setting);
        const target = inspected?.workspaceValue !== undefined
            ? vscode.ConfigurationTarget.Workspace
            : vscode.ConfigurationTarget.Global;

        await configuration.update(setting, !enabled, target);
        this.refreshLinkPreviewConfiguration();
        return vscode.workspace.getConfiguration('academicPdfViewer', documentUri).get<boolean>(setting, true);
    }

    refreshLinkPreviewConfiguration(): void {
        for (const panel of this.panels) {
            const document = this.panelDocuments.get(panel);
            if (!document) {
                continue;
            }
            void panel.webview.postMessage({
                type: 'linkPreview.setEnabled',
                enabled: this.isLinkPreviewEnabled(document.uri),
            } satisfies ExtensionToWebviewMessage);
        }
    }

    private handleWebviewMessage(
        message: WebviewToExtensionMessage,
        panel: vscode.WebviewPanel,
        document: PdfDocument,
    ): void {
        if (message.type === 'webview.ready') {
            this.logger?.info('webview.ready', {
                ...describePdfUri(document.uri),
                bytes: document.data.byteLength,
            });
            void this.postDocument(panel, document, false).catch(() => undefined);
        } else if (message.type === 'pdf.debug') {
            const fields = {
                ...describePdfUri(document.uri),
                fingerprint: message.fingerprint,
                originalFingerprint: message.originalFingerprint,
                durationMs: message.durationMs,
                pages: message.pages,
                pageNumber: message.pageNumber,
                regions: message.regions,
                changedPixels: message.changedPixels,
                strategy: message.strategy,
                sizeBytes: message.sizeBytes,
                workerSource: message.workerSource,
            };
            if (message.event === 'failed'
                || message.event === 'diffFailed'
                || message.event === 'unhandledRejection'
                || message.event === 'windowError') {
                let event = `pdfjs.${message.event}`;
                if (message.event === 'diffFailed') {
                    event = 'visualDiff.failed';
                }
                this.logger?.error(event, message.error ?? 'Unknown PDF.js error', fields);
            } else if (message.event === 'diffTextFallback') {
                this.logger?.warn('visualDiff.textFallback', { ...fields, error: message.error });
            } else if (message.event === 'workerSourceFallback') {
                this.logger?.warn('pdfjs.workerSourceFallback', { ...fields, error: message.error });
            } else {
                const event = message.event === 'diffComputed'
                    ? 'visualDiff.computed'
                    : `pdfjs.${message.event}`;
                this.logger?.info(event, fields);
            }
        } else if (message.type === 'navigation.keyUp') {
            this.releaseNavigationKeyLock(message.direction);
        } else if (message.type === 'workbench.showCommands') {
            void vscode.commands.executeCommand('workbench.action.showCommands');
        }
    }

    private async postDocument(
        panel: vscode.WebviewPanel,
        document: PdfDocument,
        preserveView: boolean,
    ): Promise<void> {
        const startedAt = Date.now();
        const data = copyToArrayBuffer(document.data);

        const fields = {
            ...describePdfUri(document.uri),
            bytes: document.data.byteLength,
            isEmptyRevision: document.data.byteLength === 0,
            preserveView,
        };
        try {
            const delivered = await panel.webview.postMessage({
                type: 'document.load',
                data,
                isEmptyRevision: document.data.byteLength === 0,
                fingerprint: document.uri.toString(),
                preserveView,
            } satisfies ExtensionToWebviewMessage);
            const resultFields = { ...fields, delivered, durationMs: Date.now() - startedAt };
            if (delivered) {
                this.logger?.info('webview.document.posted', resultFields);
            } else {
                this.logger?.warn('webview.document.notDelivered', resultFields);
            }
        } catch (error) {
            this.logger?.error('webview.document.failed', error, {
                ...fields,
                durationMs: Date.now() - startedAt,
            });
            throw error;
        }
    }

    private forgetDiffPanel(panel: vscode.WebviewPanel): void {
        const modifiedPanel = this.diffTargetPanels.get(panel);
        this.diffTargetPanels.delete(panel);
        if (modifiedPanel !== panel) {
            return;
        }

        for (const [candidate, target] of this.diffTargetPanels) {
            if (target === panel) {
                this.diffTargetPanels.delete(candidate);
            }
        }
        this.diffOriginalDocuments.delete(panel);
        this.diffHighlightsEnabled.delete(panel);
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
        const assetUri = (...paths: string[]): string => webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'assets', ...paths),
        ).toString();
        const libUri = (...paths: string[]): string => webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'assets', 'pdfviewer', 'lib', ...paths),
        ).toString();
        const settings = {
            cMapUrl: `${libUri('web', 'cmaps')}/`,
            debug: this.logger !== undefined,
            iccUrl: `${libUri('web', 'iccs')}/`,
            imageResourcesPath: `${libUri('web', 'images')}/`,
            sandboxBundleSrc: libUri('build', 'pdf.sandbox.mjs'),
            standardFontDataUrl: `${libUri('web', 'standard_fonts')}/`,
            wasmUrl: `${libUri('web', 'wasm')}/`,
            workerSrc: libUri('build', 'pdf.worker.mjs'),
            linkPreviewEnabled: this.isLinkPreviewEnabled(pdfUri),
            defaults: {
                cursor: 'text',
                scale: 'auto',
                sidebar: false,
                scrollMode: 'vertical',
                spreadMode: 'none',
            },
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
<script src="${escapeHtmlAttribute(libUri('main.js'))}"></script>
<script src="${escapeHtmlAttribute(libUri('build', 'pdf.mjs'))}" type="module"></script>
<script src="${escapeHtmlAttribute(libUri('web', 'viewer.mjs'))}" type="module"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'reader.js'))}"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'citationPreview.js'))}"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'pdfDiff.js'))}"></script>`;

        return this.viewerHtml
            .replace('<title>PDF.js viewer</title>', `${injectedHead}\n<title>Academic PDF Viewer</title>`)
            .trim();
    }

    private isLinkPreviewEnabled(documentUri: vscode.Uri): boolean {
        return vscode.workspace
            .getConfiguration('academicPdfViewer', documentUri)
            .get<boolean>('linkPreview.enabled', true);
    }
}

function readViewerHtml(context: vscode.ExtensionContext): string {
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

function escapeHtmlAttribute(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
