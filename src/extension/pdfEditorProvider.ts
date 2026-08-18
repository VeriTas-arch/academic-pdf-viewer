import * as vscode from 'vscode';

import {
    DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE,
    isWebviewToExtensionMessage,
    normalizeLinkPreviewResolutionScale,
    type ExtensionToWebviewMessage,
    type NavigationDirection,
    type WebviewToExtensionMessage,
} from '../shared/protocol';
import type { DevLogger } from './devLogger';
import { describePdfUri, readPdfData } from './pdfDataSource';
import { logPdfDebugMessage } from './pdfDebug';
import { readViewerHtml, renderViewerHtml } from './viewerHtml';

export const PDF_VIEW_TYPE = 'academicPdfViewer.pdf';

function copyToArrayBuffer(data: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
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

        panel.webview.html = renderViewerHtml(
            this.viewerHtml,
            this.context.extensionUri,
            panel.webview,
            {
                debug: this.logger !== undefined,
                linkPreviewEnabled: this.isLinkPreviewEnabled(document.uri),
                linkPreviewResolutionScale: this.getLinkPreviewResolutionScale(document.uri),
            },
        );
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
                type: 'linkPreview.configure',
                enabled: this.isLinkPreviewEnabled(document.uri),
                resolutionScale: this.getLinkPreviewResolutionScale(document.uri),
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
            logPdfDebugMessage(this.logger, document.uri, message);
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

    private isLinkPreviewEnabled(documentUri: vscode.Uri): boolean {
        return vscode.workspace
            .getConfiguration('academicPdfViewer', documentUri)
            .get<boolean>('linkPreview.enabled', true);
    }

    private getLinkPreviewResolutionScale(documentUri: vscode.Uri): number {
        const value = vscode.workspace
            .getConfiguration('academicPdfViewer', documentUri)
            .get<number>('linkPreview.resolutionScale', DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE);
        return normalizeLinkPreviewResolutionScale(value);
    }
}
