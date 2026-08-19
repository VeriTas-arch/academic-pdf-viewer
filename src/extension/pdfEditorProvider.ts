import * as vscode from 'vscode';

import {
    DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE,
    isWebviewToExtensionMessage,
    normalizeLinkPreviewResolutionScale,
    type DiffNavigationDirection,
    type DiffRole,
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

interface DiffPanelInfo {
    role: 'original' | 'modified';
    label: string;
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
    private static readonly navigationKeyFallbackReleaseMs = 800;

    private readonly panels = new Set<vscode.WebviewPanel>();
    private readonly panelDocuments = new Map<vscode.WebviewPanel, PdfDocument>();
    private readonly diffTargetPanels = new Map<vscode.WebviewPanel, vscode.WebviewPanel>();
    private readonly diffOriginalDocuments = new Map<vscode.WebviewPanel, PdfDocument>();
    private readonly diffOriginalPanels = new Map<vscode.WebviewPanel, vscode.WebviewPanel>();
    private readonly diffPanelInfo = new Map<vscode.WebviewPanel, DiffPanelInfo>();
    private readonly diffHighlightsEnabled = new Set<vscode.WebviewPanel>();
    private readonly diffSessionIds = new Map<vscode.WebviewPanel, number>();
    private readonly navigationKeyLocks = new Map<NavigationDirection, ReturnType<typeof setTimeout>>();
    private nextDiffSessionId = 1;
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
        if (panel.active || !this.activePanel) {
            this.setActivePanel(panel);
        }
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
                    this.setActivePanel(event.webviewPanel);
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
                this.refreshDiffContext();
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
                diffRole: this.diffPanelInfo.get(panel)?.role,
                diffLabel: this.diffPanelInfo.get(panel)?.label,
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
        this.diffOriginalPanels.set(panels.modified, panels.original);
        this.diffPanelInfo.set(panels.original, {
            role: 'original',
            label: describeDiffRevision(documents.original.uri, 'original'),
        });
        this.diffPanelInfo.set(panels.modified, {
            role: 'modified',
            label: describeDiffRevision(documents.modified.uri, 'modified'),
        });
        await Promise.all([
            this.resolveCustomEditor(documents.original, panels.original),
            this.resolveCustomEditor(documents.modified, panels.modified),
        ]);
        this.refreshDiffContext();
    }

    async toggleDiffHighlights(): Promise<boolean | undefined> {
        const modifiedPanel = this.activePanel && this.diffTargetPanels.get(this.activePanel);
        if (!modifiedPanel) {
            return undefined;
        }
        return this.setDiffHighlights(!this.diffHighlightsEnabled.has(modifiedPanel));
    }

    async setDiffHighlights(enabled: boolean): Promise<boolean | undefined> {
        const modifiedPanel = this.activePanel && this.diffTargetPanels.get(this.activePanel);
        if (!modifiedPanel) {
            return undefined;
        }
        return this.setDiffHighlightsForPanel(modifiedPanel, enabled);
    }

    private async setDiffHighlightsForPanel(
        modifiedPanel: vscode.WebviewPanel,
        enabled: boolean,
    ): Promise<boolean | undefined> {
        const originalDocument = modifiedPanel && this.diffOriginalDocuments.get(modifiedPanel);
        const originalPanel = modifiedPanel && this.diffOriginalPanels.get(modifiedPanel);
        const modifiedDocument = modifiedPanel && this.panelDocuments.get(modifiedPanel);
        if (!originalPanel || !originalDocument || !modifiedDocument) {
            return undefined;
        }

        const sessionId = this.beginDiffSession(modifiedPanel);
        const modifiedMessage: ExtensionToWebviewMessage = enabled
            ? {
                type: 'diff.setEnabled',
                enabled: true,
                sessionId,
                role: 'modified',
                originalData: copyToArrayBuffer(originalDocument.data),
                originalFingerprint: originalDocument.uri.toString(),
                originalIsEmptyRevision: originalDocument.data.byteLength === 0,
                modifiedIsEmptyRevision: modifiedDocument.data.byteLength === 0,
            }
            : { type: 'diff.setEnabled', enabled: false, sessionId };
        const originalMessage: ExtensionToWebviewMessage = enabled
            ? {
                type: 'diff.setEnabled',
                enabled: true,
                sessionId,
                role: 'original',
                allPagesChanged: modifiedDocument.data.byteLength === 0
                    && originalDocument.data.byteLength > 0,
            }
            : { type: 'diff.setEnabled', enabled: false, sessionId };
        const originalDelivered = await originalPanel.webview.postMessage(originalMessage);
        const modifiedDelivered = originalDelivered
            ? await modifiedPanel.webview.postMessage(modifiedMessage)
            : false;
        if (this.diffSessionIds.get(modifiedPanel) !== sessionId) {
            return this.diffHighlightsEnabled.has(modifiedPanel);
        }
        if (!this.isCurrentDiffPair(modifiedPanel, originalPanel)
            || !originalDelivered
            || !modifiedDelivered) {
            const disableMessage = {
                type: 'diff.setEnabled',
                enabled: false,
                sessionId,
            } satisfies ExtensionToWebviewMessage;
            await Promise.allSettled([
                originalPanel.webview.postMessage(disableMessage),
                modifiedPanel.webview.postMessage(disableMessage),
            ]);
            this.diffHighlightsEnabled.delete(modifiedPanel);
            this.refreshDiffContext();
            this.logger?.warn('visualDiff.toggle.notDelivered', { enabled });
            return undefined;
        }

        if (enabled) {
            this.diffHighlightsEnabled.add(modifiedPanel);
        } else {
            this.diffHighlightsEnabled.delete(modifiedPanel);
        }
        this.refreshDiffContext();
        this.logger?.info('visualDiff.toggled', {
            enabled,
            sessionId,
            originalUri: originalDocument.uri.toString(),
            modifiedUri: this.panelDocuments.get(modifiedPanel)?.uri.toString(),
        });
        return enabled;
    }

    navigateDiffChange(direction: DiffNavigationDirection): boolean {
        const panel = this.activePanel;
        const modifiedPanel = panel && this.diffTargetPanels.get(panel);
        const sessionId = modifiedPanel && this.diffSessionIds.get(modifiedPanel);
        if (!panel
            || !modifiedPanel
            || sessionId === undefined
            || !this.diffHighlightsEnabled.has(modifiedPanel)) {
            return false;
        }
        void panel.webview.postMessage({
            type: 'diff.navigate',
            sessionId,
            direction,
        } satisfies ExtensionToWebviewMessage);
        return true;
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
            const modifiedPanel = this.diffTargetPanels.get(panel);
            const originalPanel = modifiedPanel && this.diffOriginalPanels.get(modifiedPanel);
            const originalDocument = modifiedPanel && this.diffOriginalDocuments.get(modifiedPanel);
            const modifiedDocument = modifiedPanel && this.panelDocuments.get(modifiedPanel);
            if (modifiedPanel && originalPanel && originalDocument && modifiedDocument) {
                const [originalData, modifiedData] = await Promise.all([
                    readPdfData(originalDocument.uri, this.logger),
                    readPdfData(modifiedDocument.uri, this.logger),
                ]);
                originalDocument.data = originalData;
                modifiedDocument.data = modifiedData;
                this.beginDiffSession(modifiedPanel);
                await Promise.all([
                    this.postDocument(originalPanel, originalDocument, true),
                    this.postDocument(modifiedPanel, modifiedDocument, true),
                ]);
                if (this.diffHighlightsEnabled.has(modifiedPanel)) {
                    await this.setDiffHighlightsForPanel(modifiedPanel, true);
                }
                return;
            }

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
        } else if (message.type === 'diff.pageResult') {
            if (!this.isCurrentModifiedSession(panel, message.sessionId)) {
                return;
            }
            this.forwardToOriginal(panel, {
                type: 'diff.applyPage',
                sessionId: message.sessionId,
                pageNumber: message.pageNumber,
                regions: message.originalRegions,
            });
        } else if (message.type === 'diff.removedPageRange') {
            if (!this.isCurrentModifiedSession(panel, message.sessionId)) {
                return;
            }
            this.forwardToOriginal(panel, {
                type: 'diff.setRemovedPageRange',
                sessionId: message.sessionId,
                fromPage: message.fromPage,
                toPage: message.toPage,
            });
        } else if (message.type === 'diff.navigationRequest') {
            const modifiedPanel = this.currentDiffSession(panel, message.sessionId);
            if (!modifiedPanel || this.diffPanelInfo.get(panel)?.role !== message.role) {
                return;
            }
            void modifiedPanel.webview.postMessage({
                type: 'diff.scanForChange',
                sessionId: message.sessionId,
                requestId: message.requestId,
                role: message.role,
                direction: message.direction,
                startPage: message.startPage,
            } satisfies ExtensionToWebviewMessage);
        } else if (message.type === 'diff.navigationResult') {
            if (!this.isCurrentModifiedSession(panel, message.sessionId)) {
                return;
            }
            const targetPanel = this.panelForDiffRole(panel, message.role);
            if (!targetPanel) {
                return;
            }
            void targetPanel.webview.postMessage({
                type: 'diff.revealChange',
                sessionId: message.sessionId,
                requestId: message.requestId,
                pageNumber: message.pageNumber,
                index: message.index,
                regions: message.regions,
            } satisfies ExtensionToWebviewMessage);
        } else if (message.type === 'diff.scroll') {
            const modifiedPanel = this.diffTargetPanels.get(panel);
            const originalPanel = modifiedPanel && this.diffOriginalPanels.get(modifiedPanel);
            const targetPanel = modifiedPanel === panel ? originalPanel : modifiedPanel;
            if (targetPanel && targetPanel !== panel) {
                void targetPanel.webview.postMessage({
                    type: 'diff.applyScroll',
                    pageNumber: message.pageNumber,
                    pageRatio: message.pageRatio,
                    documentRatio: message.documentRatio,
                } satisfies ExtensionToWebviewMessage);
            }
        } else if (message.type === 'pdf.debug') {
            logPdfDebugMessage(this.logger, document.uri, message);
        } else if (message.type === 'navigation.keyUp') {
            this.releaseNavigationKeyLock(message.direction);
        } else if (message.type === 'workbench.showCommands') {
            void vscode.commands.executeCommand('workbench.action.showCommands');
        }
    }

    private forwardToOriginal(
        sourcePanel: vscode.WebviewPanel,
        message: ExtensionToWebviewMessage,
    ): void {
        const modifiedPanel = this.diffTargetPanels.get(sourcePanel);
        if (modifiedPanel !== sourcePanel) {
            return;
        }
        const originalPanel = this.diffOriginalPanels.get(modifiedPanel);
        void originalPanel?.webview.postMessage(message);
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
        if (!modifiedPanel) {
            this.diffPanelInfo.delete(panel);
            return;
        }

        const originalPanel = this.diffOriginalPanels.get(modifiedPanel);
        const sessionId = this.beginDiffSession(modifiedPanel);
        const disableMessage = {
            type: 'diff.setEnabled',
            enabled: false,
            sessionId,
        } satisfies ExtensionToWebviewMessage;
        if (originalPanel && originalPanel !== panel) {
            void originalPanel.webview.postMessage(disableMessage);
        }
        if (modifiedPanel !== panel) {
            void modifiedPanel.webview.postMessage(disableMessage);
        }

        this.diffTargetPanels.delete(modifiedPanel);
        this.diffPanelInfo.delete(modifiedPanel);
        if (originalPanel) {
            this.diffTargetPanels.delete(originalPanel);
            this.diffPanelInfo.delete(originalPanel);
        }
        this.diffOriginalDocuments.delete(modifiedPanel);
        this.diffOriginalPanels.delete(modifiedPanel);
        this.diffHighlightsEnabled.delete(modifiedPanel);
        this.diffSessionIds.delete(modifiedPanel);
        this.refreshDiffContext();
    }

    private beginDiffSession(modifiedPanel: vscode.WebviewPanel): number {
        const sessionId = this.nextDiffSessionId++;
        this.diffSessionIds.set(modifiedPanel, sessionId);
        return sessionId;
    }

    private currentDiffSession(
        panel: vscode.WebviewPanel,
        sessionId: number,
    ): vscode.WebviewPanel | undefined {
        const modifiedPanel = this.diffTargetPanels.get(panel);
        if (!modifiedPanel || this.diffSessionIds.get(modifiedPanel) !== sessionId) {
            return undefined;
        }
        return modifiedPanel;
    }

    private isCurrentModifiedSession(panel: vscode.WebviewPanel, sessionId: number): boolean {
        return this.currentDiffSession(panel, sessionId) === panel;
    }

    private isCurrentDiffPair(
        modifiedPanel: vscode.WebviewPanel,
        originalPanel: vscode.WebviewPanel,
    ): boolean {
        return this.diffTargetPanels.get(modifiedPanel) === modifiedPanel
            && this.diffTargetPanels.get(originalPanel) === modifiedPanel
            && this.diffOriginalPanels.get(modifiedPanel) === originalPanel;
    }

    private panelForDiffRole(
        modifiedPanel: vscode.WebviewPanel,
        role: DiffRole,
    ): vscode.WebviewPanel | undefined {
        return role === 'modified'
            ? modifiedPanel
            : this.diffOriginalPanels.get(modifiedPanel);
    }

    private setActivePanel(panel: vscode.WebviewPanel): void {
        this.activePanel = panel;
        this.refreshDiffContext();
    }

    private refreshDiffContext(): void {
        const modifiedPanel = this.activePanel && this.diffTargetPanels.get(this.activePanel);
        void vscode.commands.executeCommand(
            'setContext',
            'academicPdfViewer.diffActive',
            modifiedPanel !== undefined,
        );
        void vscode.commands.executeCommand(
            'setContext',
            'academicPdfViewer.diffHighlightsEnabled',
            modifiedPanel !== undefined && this.diffHighlightsEnabled.has(modifiedPanel),
        );
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

function describeDiffRevision(uri: vscode.Uri, role: 'original' | 'modified'): string {
    if (uri.scheme === 'file') {
        return role === 'modified' ? 'Working Tree' : 'Original';
    }
    if (uri.scheme !== 'git') {
        return role === 'original' ? 'Original' : 'Modified';
    }

    try {
        const query = JSON.parse(uri.query) as Record<string, unknown>;
        if (query.ref === '~' || query.ref === '') {
            return 'Index';
        }
        if (typeof query.ref === 'string' && query.ref.length > 0) {
            return query.ref.length > 24 ? query.ref.slice(0, 12) : query.ref;
        }
    } catch {
        // Fall back to the semantic role when VS Code changes its Git URI shape.
    }
    return role === 'original' ? 'Original' : 'Modified';
}
