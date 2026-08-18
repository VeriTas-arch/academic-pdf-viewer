import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, sep } from 'node:path';

import type { ExtensionToWebviewMessage, NavigationDirection, WebviewToExtensionMessage } from '../shared/protocol';
import type { DevLogFields, DevLogger } from './devLogger';

export const PDF_VIEW_TYPE = 'academicPdfViewer.pdf';

const VIEWER_HTML_RELATIVE_PATH = ['assets', 'pdfviewer', 'lib', 'web', 'viewer.html'];
const MAX_GIT_OUTPUT_BYTES = 512 * 1024 * 1024;

async function readPdfData(uri: vscode.Uri, logger?: DevLogger): Promise<Uint8Array> {
    const startedAt = Date.now();
    const fields = describePdfUri(uri);
    const source = uri.scheme === 'git' ? 'gitBlob' : 'workspaceFs';
    logger?.info('pdf.read.start', { ...fields, source });

    try {
        const data = uri.scheme === 'git'
            ? await readGitBlob(uri, logger)
            : await vscode.workspace.fs.readFile(uri);
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
        const data = await runGit(['cat-file', 'blob', objectName], repositoryRoot, true);
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

function runGit(args: string[], cwd: string, missingIsEmpty = false): Promise<Buffer> {
    const configuredGitPath = vscode.workspace.getConfiguration('git').get<string>('path');
    return new Promise((resolve, reject) => {
        execFile(configuredGitPath || 'git', args, {
            cwd,
            encoding: null,
            maxBuffer: MAX_GIT_OUTPUT_BYTES,
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
            if (this.activePanel === panel) {
                this.activePanel = this.panels.values().next().value;
            }
        });

        panelDisposables.push(
            panel.webview.onDidReceiveMessage((message: WebviewToExtensionMessage) => {
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
        await Promise.all([
            this.resolveCustomEditor(documents.original, panels.original),
            this.resolveCustomEditor(documents.modified, panels.modified),
        ]);
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
                durationMs: message.durationMs,
                pages: message.pages,
                pageNumber: message.pageNumber,
            };
            if (message.event === 'failed') {
                this.logger?.error('pdfjs.failed', message.error ?? 'Unknown PDF.js error', fields);
            } else {
                this.logger?.info(`pdfjs.${message.event}`, fields);
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
        const data = new ArrayBuffer(document.data.byteLength);
        new Uint8Array(data).set(document.data);

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
            standardFontDataUrl: `${libUri('web', 'standard_fonts')}/`,
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
<script>
window.addEventListener("keydown", function (event) {
  if (event.keyCode === 80 && (event.ctrlKey || event.metaKey) && !event.altKey) {
    if (event.shiftKey && !event.repeat) {
      window.dispatchEvent(new CustomEvent("academic-pdf-show-commands"));
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}, true);
</script>
<script src="${escapeHtmlAttribute(libUri('web', 'viewer.js'))}"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'reader.js'))}"></script>
<script src="${escapeHtmlAttribute(assetUri('academic', 'citationPreview.js'))}"></script>
<script src="${escapeHtmlAttribute(libUri('main.js'))}"></script>`;

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
