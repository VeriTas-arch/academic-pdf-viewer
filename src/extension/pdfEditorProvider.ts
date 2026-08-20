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
import { assertPdfDiffPairSize } from './pdfSizeLimits';
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

interface DiffPairSession {
    originalPanel: vscode.WebviewPanel;
    modifiedPanel: vscode.WebviewPanel;
    originalDocument: PdfDocument;
    originalInfo: DiffPanelInfo;
    modifiedInfo: DiffPanelInfo;
    highlightsEnabled: boolean;
    sessionId?: number;
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
    private static readonly navigationKeyFallbackReleaseMs = 800;

    private readonly panelDocuments = new Map<vscode.WebviewPanel, PdfDocument>();
    private readonly diffSessionsByPanel = new Map<vscode.WebviewPanel, DiffPairSession>();
    private readonly latestDocumentLoadByPanel = new Map<vscode.WebviewPanel, number>();
    private readonly navigationKeyLocks = new Map<NavigationDirection, ReturnType<typeof setTimeout>>();
    private nextDiffSessionId = 1;
    private nextDocumentLoadId = 1;
    private activePanel: vscode.WebviewPanel | undefined;
    private readonly viewerHtml: string;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly logger?: DevLogger,
    ) {
        this.viewerHtml = readViewerHtml(context);
    }

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken,
    ): Promise<PdfDocument> {
        const data = await readPdfData(uri, this.logger, token);
        return new PdfDocument(uri, data);
    }

    async resolveCustomEditor(
        document: PdfDocument,
        panel: vscode.WebviewPanel,
        token: vscode.CancellationToken,
    ): Promise<void> {
        throwIfCancellationRequested(token);
        this.logger?.info('editor.resolve', {
            ...describePdfUri(document.uri),
            bytes: document.data.byteLength,
        });
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
            this.panelDocuments.delete(panel);
            this.latestDocumentLoadByPanel.delete(panel);
            this.forgetDiffPanel(panel);
            if (this.activePanel === panel) {
                this.activePanel = this.panelDocuments.keys().next().value;
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
                diffRole: this.diffPanelInfo(panel)?.role,
                diffLabel: this.diffPanelInfo(panel)?.label,
                linkPreviewEnabled: this.isLinkPreviewEnabled(document.uri),
                linkPreviewResolutionScale: this.getLinkPreviewResolutionScale(document.uri),
            },
        );
    }

    async resolveCustomEditorSideBySideDiff(
        documents: vscode.CustomEditorDiffDocuments<PdfDocument>,
        panels: vscode.CustomEditorSideBySideDiffWebviewPanels,
        token: vscode.CancellationToken,
    ): Promise<void> {
        throwIfCancellationRequested(token);
        assertPdfDiffPairSize(
            documents.original.data.byteLength,
            documents.modified.data.byteLength,
        );
        this.logger?.info('diff.resolve', {
            originalUri: documents.original.uri.toString(),
            originalBytes: documents.original.data.byteLength,
            modifiedUri: documents.modified.uri.toString(),
            modifiedBytes: documents.modified.data.byteLength,
        });
        const session: DiffPairSession = {
            originalPanel: panels.original,
            modifiedPanel: panels.modified,
            originalDocument: documents.original,
            originalInfo: {
                role: 'original',
                label: describeDiffRevision(documents.original.uri, 'original'),
            },
            modifiedInfo: {
                role: 'modified',
                label: describeDiffRevision(documents.modified.uri, 'modified'),
            },
            highlightsEnabled: false,
        };
        this.diffSessionsByPanel.set(panels.original, session);
        this.diffSessionsByPanel.set(panels.modified, session);
        await Promise.all([
            this.resolveCustomEditor(documents.original, panels.original, token),
            this.resolveCustomEditor(documents.modified, panels.modified, token),
        ]);
        this.refreshDiffContext();
    }

    async setDiffHighlights(enabled?: boolean): Promise<boolean | undefined> {
        const session = this.activePanel && this.diffSessionsByPanel.get(this.activePanel);
        if (!session) {
            return undefined;
        }
        return this.setDiffHighlightsForSession(
            session,
            enabled ?? !session.highlightsEnabled,
        );
    }

    private async setDiffHighlightsForSession(
        session: DiffPairSession,
        enabled: boolean,
    ): Promise<boolean | undefined> {
        const { modifiedPanel, originalPanel, originalDocument } = session;
        const modifiedDocument = this.panelDocuments.get(modifiedPanel);
        if (!this.isCurrentDiffPair(session) || !modifiedDocument) {
            return undefined;
        }

        const sessionId = this.beginDiffSession(session);
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
        const [originalDelivered, modifiedDelivered] = await Promise.all([
            originalPanel.webview.postMessage(originalMessage),
            modifiedPanel.webview.postMessage(modifiedMessage),
        ]);
        if (session.sessionId !== sessionId) {
            return session.highlightsEnabled;
        }
        if (!this.isCurrentDiffPair(session)
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
            session.highlightsEnabled = false;
            this.refreshDiffContext();
            this.logger?.warn('visualDiff.toggle.notDelivered', { enabled });
            return undefined;
        }

        session.highlightsEnabled = enabled;
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
        const session = panel && this.diffSessionsByPanel.get(panel);
        const sessionId = session?.sessionId;
        if (!panel
            || !session
            || sessionId === undefined
            || !session.highlightsEnabled) {
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

        const session = this.diffSessionsByPanel.get(panel);
        const modifiedDocument = session && this.panelDocuments.get(session.modifiedPanel);
        const reloadPanels = session && modifiedDocument
            ? [session.originalPanel, session.modifiedPanel]
            : [panel];
        const loadId = this.beginDocumentLoad(reloadPanels);

        try {
            if (session && modifiedDocument) {
                const { originalDocument, originalPanel, modifiedPanel } = session;
                const [originalData, modifiedData] = await Promise.all([
                    readPdfData(originalDocument.uri, this.logger),
                    readPdfData(modifiedDocument.uri, this.logger),
                ]);
                if (!this.isCurrentDocumentLoad(reloadPanels, loadId)) {
                    return;
                }
                assertPdfDiffPairSize(originalData.byteLength, modifiedData.byteLength);
                originalDocument.data = originalData;
                modifiedDocument.data = modifiedData;
                this.beginDiffSession(session);
                await Promise.all([
                    this.postDocument(originalPanel, originalDocument, true, loadId),
                    this.postDocument(modifiedPanel, modifiedDocument, true, loadId),
                ]);
                if (!this.isCurrentDocumentLoad(reloadPanels, loadId)) {
                    return;
                }
                if (session.highlightsEnabled) {
                    await this.setDiffHighlightsForSession(session, true);
                }
                return;
            }

            const data = await readPdfData(document.uri, this.logger);
            if (!this.isCurrentDocumentLoad(reloadPanels, loadId)) {
                return;
            }
            document.data = data;
            await this.postDocument(panel, document, true, loadId);
        } catch (error) {
            if (!this.isCurrentDocumentLoad(reloadPanels, loadId)) {
                return;
            }
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
        for (const [panel, document] of this.panelDocuments) {
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
                changes: message.originalChanges,
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
            const session = this.currentDiffSession(panel, message.sessionId);
            if (!session || this.diffPanelInfo(panel)?.role !== message.role) {
                return;
            }
            void session.modifiedPanel.webview.postMessage({
                type: 'diff.scanForChange',
                sessionId: message.sessionId,
                requestId: message.requestId,
                role: message.role,
                direction: message.direction,
                startPage: message.startPage,
            } satisfies ExtensionToWebviewMessage);
        } else if (message.type === 'diff.navigationResult') {
            const session = this.currentDiffSession(panel, message.sessionId);
            if (!session || session.modifiedPanel !== panel) {
                return;
            }
            const targetPanel = this.panelForDiffRole(session, message.role);
            void targetPanel.webview.postMessage({
                type: 'diff.revealChange',
                sessionId: message.sessionId,
                requestId: message.requestId,
                pageNumber: message.pageNumber,
                index: message.index,
                changes: message.changes,
            } satisfies ExtensionToWebviewMessage);
        } else if (message.type === 'diff.scroll') {
            const session = this.diffSessionsByPanel.get(panel);
            const targetPanel = session && panel === session.modifiedPanel
                ? session.originalPanel
                : session?.modifiedPanel;
            if (targetPanel) {
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
        const session = this.diffSessionsByPanel.get(sourcePanel);
        if (!session || session.modifiedPanel !== sourcePanel) {
            return;
        }
        void session.originalPanel.webview.postMessage(message);
    }

    private async postDocument(
        panel: vscode.WebviewPanel,
        document: PdfDocument,
        preserveView: boolean,
        reservedLoadId?: number,
    ): Promise<void> {
        const startedAt = Date.now();
        const data = copyToArrayBuffer(document.data);
        const loadId = reservedLoadId ?? this.beginDocumentLoad([panel]);

        const fields = {
            ...describePdfUri(document.uri),
            bytes: document.data.byteLength,
            isEmptyRevision: document.data.byteLength === 0,
            preserveView,
        };
        try {
            const delivered = await panel.webview.postMessage({
                type: 'document.load',
                loadId,
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
        const session = this.diffSessionsByPanel.get(panel);
        if (!session) {
            return;
        }

        const { originalPanel, modifiedPanel } = session;
        const sessionId = this.beginDiffSession(session);
        const disableMessage = {
            type: 'diff.setEnabled',
            enabled: false,
            sessionId,
        } satisfies ExtensionToWebviewMessage;
        if (originalPanel !== panel) {
            void originalPanel.webview.postMessage(disableMessage);
        }
        if (modifiedPanel !== panel) {
            void modifiedPanel.webview.postMessage(disableMessage);
        }

        this.diffSessionsByPanel.delete(originalPanel);
        this.diffSessionsByPanel.delete(modifiedPanel);
        session.highlightsEnabled = false;
        session.sessionId = undefined;
        this.refreshDiffContext();
    }

    private beginDiffSession(session: DiffPairSession): number {
        const sessionId = this.nextDiffSessionId++;
        session.sessionId = sessionId;
        return sessionId;
    }

    private beginDocumentLoad(panels: vscode.WebviewPanel[]): number {
        const loadId = this.nextDocumentLoadId++;
        for (const panel of panels) {
            this.latestDocumentLoadByPanel.set(panel, loadId);
        }
        return loadId;
    }

    private isCurrentDocumentLoad(panels: vscode.WebviewPanel[], loadId: number): boolean {
        return panels.every(panel => this.panelDocuments.has(panel)
            && this.latestDocumentLoadByPanel.get(panel) === loadId);
    }

    private currentDiffSession(
        panel: vscode.WebviewPanel,
        sessionId: number,
    ): DiffPairSession | undefined {
        const session = this.diffSessionsByPanel.get(panel);
        if (!session || session.sessionId !== sessionId) {
            return undefined;
        }
        return session;
    }

    private isCurrentModifiedSession(panel: vscode.WebviewPanel, sessionId: number): boolean {
        return this.currentDiffSession(panel, sessionId)?.modifiedPanel === panel;
    }

    private isCurrentDiffPair(session: DiffPairSession): boolean {
        return this.diffSessionsByPanel.get(session.modifiedPanel) === session
            && this.diffSessionsByPanel.get(session.originalPanel) === session;
    }

    private panelForDiffRole(
        session: DiffPairSession,
        role: DiffRole,
    ): vscode.WebviewPanel {
        return role === 'modified'
            ? session.modifiedPanel
            : session.originalPanel;
    }

    private diffPanelInfo(panel: vscode.WebviewPanel): DiffPanelInfo | undefined {
        const session = this.diffSessionsByPanel.get(panel);
        if (!session) {
            return undefined;
        }
        return panel === session.originalPanel ? session.originalInfo : session.modifiedInfo;
    }

    private setActivePanel(panel: vscode.WebviewPanel): void {
        this.activePanel = panel;
        this.refreshDiffContext();
    }

    private refreshDiffContext(): void {
        const session = this.activePanel && this.diffSessionsByPanel.get(this.activePanel);
        void Promise.all([
            vscode.commands.executeCommand(
                'setContext',
                'academicPdfViewer.diffActive',
                session !== undefined,
            ),
            vscode.commands.executeCommand(
                'setContext',
                'academicPdfViewer.diffHighlightsEnabled',
                session?.highlightsEnabled ?? false,
            ),
        ]);
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

function throwIfCancellationRequested(token: vscode.CancellationToken): void {
    if (token.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}
