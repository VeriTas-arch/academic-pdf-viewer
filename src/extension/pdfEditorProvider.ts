import { basename } from 'node:path';
import * as vscode from 'vscode';

import {
    DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE,
    PDF_RANGE_CHUNK_BYTES,
    PDF_RANGE_CONCURRENCY,
    isWebviewToExtensionMessage,
    normalizeLinkPreviewResolutionScale,
    sanitizePdfDiffChanges,
    type DiffNavigationDirection,
    type ExtensionToWebviewMessage,
    type MouseButtonMapping,
    type NavigationDirection,
    type SidebarView,
    type SyncTexForwardRequest,
    type SyncTexInverseEvent,
    type SyncTexMode,
    type WebviewToExtensionMessage,
} from '../shared/protocol';
import { openPdfRangeFile, preparePdfData, readPdfData, type PdfDataSource, type PdfRangeFile } from './pdfDataSource';
import { assertPdfDiffPairSize } from './pdfSizeLimits';
import { readViewerHtml, renderViewerHtml } from './viewerHtml';

export const PDF_VIEW_TYPE = 'academicPdfViewer.pdf';
const minimumRemoteRangeSize = 1024 * 1024;
const workbenchCommands = {
    'workbench.openFile': 'workbench.action.files.openFile',
    'workbench.quickOpen': 'workbench.action.quickOpen',
    'workbench.showCommands': 'workbench.action.showCommands',
} as const;

interface PendingSyncTexContextMenu {
    pageNumber: number;
    x: number;
    y: number;
    context?: string;
    offset?: number;
}

interface PendingSyncTexForward {
    requestId: string;
    pageNumber: number;
    x: number;
    y: number;
    targetBox?: SyncTexForwardRequest['targetBox'];
    postedLoadId?: number;
}

interface PanelState {
    document: PdfDocument;
    ready: boolean;
    startingDocument?: boolean;
    ranges: Map<number, { file: PdfRangeFile; lastRequestId: number; inFlight: number }>;
    latestDocumentLoadId?: number;
    postedDocumentLoadId?: number;
    pendingSyncTexForward?: PendingSyncTexForward;
    pendingSyncTexContextMenu?: PendingSyncTexContextMenu;
    reloadCancellation?: vscode.CancellationTokenSource;
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
    if (data.buffer instanceof ArrayBuffer && data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
        return data.buffer;
    }
    const copy = new ArrayBuffer(data.byteLength);
    new Uint8Array(copy).set(data);
    return copy;
}

class PdfDocument implements vscode.CustomDocument {
    pendingData?: Promise<Uint8Array>;
    data?: Uint8Array;

    constructor(
        public readonly uri: vscode.Uri,
        public size: number,
        public source?: PdfDataSource,
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
    restoredLoadIds?: readonly [number, number];
}

export class PdfEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
    private static readonly navigationKeyFallbackReleaseMs = 800;

    private readonly panelStates = new Map<vscode.WebviewPanel, PanelState>();
    private readonly diffSessionsByPanel = new Map<vscode.WebviewPanel, DiffPairSession>();
    private readonly navigationKeyLocks = new Map<NavigationDirection, ReturnType<typeof setTimeout>>();
    private nextDiffSessionId = 1;
    private nextDocumentLoadId = 1;
    private nextSyncTexRequestId = 1;
    private activePanel: vscode.WebviewPanel | undefined;
    private readonly diffContext = new Map<string, boolean>();
    private readonly viewerHtml: string;
    private readonly inverseSyncTexEmitter = new vscode.EventEmitter<SyncTexInverseEvent>();

    /** Emits validated inverse SyncTeX requests from the PDF webview. */
    readonly onDidRequestInverseSyncTex = this.inverseSyncTexEmitter.event;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly diffEnabled = false,
    ) {
        this.viewerHtml = readViewerHtml(context);
        context.subscriptions.push(this, this.inverseSyncTexEmitter);
    }

    dispose(): void {
        for (const panel of this.panelStates.keys()) {
            this.cancelReload(panel);
            this.closeRange(panel);
        }
        for (const timer of this.navigationKeyLocks.values()) {
            clearTimeout(timer);
        }
        this.navigationKeyLocks.clear();
        this.panelStates.clear();
        this.diffSessionsByPanel.clear();
        this.activePanel = undefined;
    }

    async openCustomDocument(
        uri: vscode.Uri,
        _openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken,
    ): Promise<PdfDocument> {
        const source = await preparePdfData(uri, token);
        return new PdfDocument(uri, source.size, source);
    }

    private isRemoteFile(uri: vscode.Uri): boolean {
        return uri.scheme === 'file' && !!vscode.env?.remoteName
            && this.context.extension.extensionKind === vscode.ExtensionKind.Workspace;
    }

    private bufferDocument(document: PdfDocument, token?: vscode.CancellationToken): Promise<Uint8Array> {
        if (document.data) {
            return Promise.resolve(document.data);
        }
        if (!document.pendingData) {
            const pending = readPdfData(document.uri, token, document.source).then(data => {
                if (document.pendingData === pending) {
                    document.data = data;
                    document.size = data.byteLength;
                    document.source = undefined;
                }
                return data;
            }).finally(() => {
                if (document.pendingData === pending) {
                    document.pendingData = undefined;
                }
            });
            document.pendingData = pending;
        }
        return document.pendingData;
    }

    resolveCustomEditor(
        document: PdfDocument,
        panel: vscode.WebviewPanel,
        token: vscode.CancellationToken,
    ): void {
        throwIfCancellationRequested(token);
        this.panelStates.set(panel, { document, ready: false, ranges: new Map() });
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
                } else {
                    const state = this.panelStates.get(event.webviewPanel);
                    if (state) {
                        state.pendingSyncTexContextMenu = undefined;
                    }
                }
                if (!event.webviewPanel.visible) {
                    const state = this.panelStates.get(event.webviewPanel);
                    if (state) {
                        state.ready = false;
                        state.startingDocument = false;
                    }
                    this.closeRange(panel);
                    this.cancelPostedSyncTexForward(event.webviewPanel);
                }
            }),
        );

        panel.onDidDispose(() => {
            for (const disposable of panelDisposables) {
                disposable.dispose();
            }
            this.cancelReload(panel);
            this.closeRange(panel);
            this.panelStates.delete(panel);
            this.forgetDiffPanel(panel);
            if (this.activePanel === panel) {
                this.activePanel = this.findFallbackActivePanel();
                this.refreshDiffContext();
            }
        });

        panelDisposables.push(
            panel.webview.onDidReceiveMessage((message: unknown) => {
                if (!isWebviewToExtensionMessage(message)) {
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
                diffRole: this.diffPanelInfo(panel)?.role,
                diffLabel: this.diffPanelInfo(panel)?.label,
                linkPreviewEnabled: this.isLinkPreviewEnabled(document.uri),
                linkPreviewResolutionScale: this.getLinkPreviewResolutionScale(document.uri),
                mouseNavigationEnabled: this.isMouseNavigationEnabled(),
                mouseButtonMapping: this.getMouseButtonMapping(),
                defaultSidebar: this.getDefaultSidebar(),
                syncTexMode: this.getSyncTexMode(document.uri),
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
            documents.original.data?.byteLength ?? documents.original.size,
            documents.modified.data?.byteLength ?? documents.modified.size,
        );
        const [originalData, modifiedData] = await Promise.all([
            this.bufferDocument(documents.original, token),
            this.bufferDocument(documents.modified, token),
        ]);
        throwIfCancellationRequested(token);
        assertPdfDiffPairSize(originalData.byteLength, modifiedData.byteLength);
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
        try {
            this.resolveCustomEditor(documents.original, panels.original, token);
            this.resolveCustomEditor(documents.modified, panels.modified, token);
        } catch (error) {
            this.forgetDiffPanel(panels.original);
            throw error;
        }
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
        const modifiedDocument = this.panelStates.get(modifiedPanel)?.document;
        if (!this.isCurrentDiffPair(session) || !modifiedDocument?.data || !originalDocument.data) {
            return undefined;
        }

        const sessionId = this.beginDiffSession(session);
        const modifiedMessage: ExtensionToWebviewMessage = enabled
            ? modifiedDocument.data.byteLength === 0
                ? {
                    type: 'diff.setEnabled',
                    enabled: true,
                    sessionId,
                    role: 'modified',
                    modifiedIsEmptyRevision: true,
                }
                : {
                    type: 'diff.setEnabled',
                    enabled: true,
                    sessionId,
                    role: 'modified',
                    originalData: toArrayBuffer(originalDocument.data),
                    originalIsEmptyRevision: originalDocument.data.byteLength === 0,
                    modifiedIsEmptyRevision: false,
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
        const delivery = await Promise.allSettled([
            originalPanel.webview.postMessage(originalMessage),
            modifiedPanel.webview.postMessage(modifiedMessage),
        ]);
        if (session.sessionId !== sessionId) {
            return session.highlightsEnabled;
        }
        if (!this.isCurrentDiffPair(session)
            || delivery.some(result => result.status !== 'fulfilled' || !result.value)) {
            const disableMessage = {
                type: 'diff.setEnabled',
                enabled: false,
                sessionId,
            } satisfies ExtensionToWebviewMessage;
            await Promise.allSettled([
                originalPanel.webview.postMessage(disableMessage),
                modifiedPanel.webview.postMessage(disableMessage),
            ]);
            if (session.sessionId === sessionId) {
                session.highlightsEnabled = false;
                this.refreshDiffContext();
            }
            const failure = delivery.find(result => result.status === 'rejected');
            if (failure) {
                throw failure.reason;
            }
            return undefined;
        }

        session.highlightsEnabled = enabled;
        this.refreshDiffContext();
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
        this.notify(panel, {
            type: 'diff.navigate',
            sessionId,
            direction,
        });
        return true;
    }

    /** Queues a forward SyncTeX location for the best matching PDF editor panel. */
    synctexForward(request: SyncTexForwardRequest): boolean {
        const panel = this.findSyncTexPanel(request.pdfUri);
        if (!panel) {
            return false;
        }

        const targetUri = this.panelStates.get(panel)?.document.uri.toString();
        for (const [candidate, state] of this.panelStates) {
            if (state.document.uri.toString() === targetUri) {
                this.cancelPostedSyncTexForward(candidate);
                state.pendingSyncTexForward = undefined;
            }
        }
        const state = this.panelStates.get(panel);
        if (!state) {
            return false;
        }
        state.pendingSyncTexForward = {
            requestId: String(this.nextSyncTexRequestId++),
            pageNumber: request.pageNumber,
            x: request.x,
            y: request.y,
            ...(request.targetBox ? { targetBox: { ...request.targetBox } } : {}),
        };
        this.postPendingSyncTexForward(panel);
        return true;
    }

    navigate(direction: NavigationDirection): void {
        const locked = this.navigationKeyLocks.has(direction);
        this.armNavigationKeyFallbackRelease(direction);
        const panel = this.activePanel;
        if (locked || !panel) {
            return;
        }
        this.notify(panel, {
            type: direction === 'back' ? 'navigation.back' : 'navigation.forward',
        });
    }

    async reloadActive(): Promise<void> {
        const panel = this.activePanel;
        const document = panel && this.panelStates.get(panel)?.document;
        if (!panel || !document) {
            return;
        }

        const session = this.diffSessionsByPanel.get(panel);
        const modifiedDocument = session && this.panelStates.get(session.modifiedPanel)?.document;
        const reloadPanels = session && modifiedDocument
            ? [session.originalPanel, session.modifiedPanel]
            : [panel];
        const loadId = this.beginDocumentLoad(reloadPanels);
        const cancellation = new vscode.CancellationTokenSource();
        for (const reloadPanel of reloadPanels) {
            const state = this.panelStates.get(reloadPanel);
            if (state) {
                state.reloadCancellation = cancellation;
            }
        }

        try {
            if (session && modifiedDocument) {
                const { originalDocument, originalPanel, modifiedPanel } = session;
                const [originalSource, modifiedSource] = await Promise.all([
                    preparePdfData(originalDocument.uri, cancellation.token),
                    preparePdfData(modifiedDocument.uri, cancellation.token),
                ]);
                throwIfCancellationRequested(cancellation.token);
                assertPdfDiffPairSize(originalSource.size, modifiedSource.size);
                const [originalData, modifiedData] = await Promise.all([
                    readPdfData(originalDocument.uri, cancellation.token, originalSource),
                    readPdfData(modifiedDocument.uri, cancellation.token, modifiedSource),
                ]);
                if (!this.isCurrentDocumentLoad(reloadPanels, loadId)) {
                    return;
                }
                assertPdfDiffPairSize(originalData.byteLength, modifiedData.byteLength);
                originalDocument.data = originalData;
                originalDocument.size = originalData.byteLength;
                modifiedDocument.data = modifiedData;
                modifiedDocument.size = modifiedData.byteLength;
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

            let source: PdfDataSource | undefined;
            if (this.isRemoteFile(document.uri)) {
                source = await preparePdfData(document.uri, cancellation.token);
                if (!this.isCurrentDocumentLoad(reloadPanels, loadId)) {
                    return;
                }
                if (source.size >= minimumRemoteRangeSize) {
                    await this.postDocument(panel, document, true, loadId, source.size);
                    return;
                }
            }
            const data = await readPdfData(document.uri, cancellation.token, source);
            if (!this.isCurrentDocumentLoad(reloadPanels, loadId)) {
                return;
            }
            document.pendingData = undefined;
            document.data = data;
            document.size = data.byteLength;
            await this.postDocument(panel, document, true, loadId);
        } catch (error) {
            if (!this.isCurrentDocumentLoad(reloadPanels, loadId)) {
                return;
            }
            const detail = error instanceof Error ? error.message : String(error);
            void vscode.window.showErrorMessage(`Unable to reload PDF: ${detail}`);
        } finally {
            cancellation.cancel();
            for (const reloadPanel of reloadPanels) {
                const state = this.panelStates.get(reloadPanel);
                if (state?.reloadCancellation === cancellation) {
                    state.reloadCancellation = undefined;
                }
            }
            cancellation.dispose();
        }
    }

    async toggleLinkPreviewActive(): Promise<boolean | undefined> {
        const document = this.activePanel && this.panelStates.get(this.activePanel)?.document;
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
        return vscode.workspace.getConfiguration('academicPdfViewer', documentUri).get<boolean>(setting, true);
    }

    refreshLinkPreviewConfiguration(): void {
        for (const [panel, state] of this.panelStates) {
            this.notify(panel, {
                type: 'linkPreview.configure',
                enabled: this.isLinkPreviewEnabled(state.document.uri),
                resolutionScale: this.getLinkPreviewResolutionScale(state.document.uri),
            });
        }
    }

    refreshMouseNavigationConfiguration(): void {
        const mouseButtonsEnabled = this.isMouseNavigationEnabled();
        const mouseButtonMapping = this.getMouseButtonMapping();
        for (const panel of this.panelStates.keys()) {
            this.notify(panel, { type: 'navigation.configure', mouseButtonsEnabled, mouseButtonMapping });
        }
    }

    refreshSidebarConfiguration(): void {
        const defaultSidebar = this.getDefaultSidebar();
        for (const panel of this.panelStates.keys()) {
            this.notify(panel, { type: 'sidebar.configure', defaultSidebar });
        }
    }

    /** Applies the current SyncTeX trigger mode to all open PDF webviews. */
    refreshSyncTexConfiguration(): void {
        for (const [panel, state] of this.panelStates) {
            state.pendingSyncTexContextMenu = undefined;
            this.notify(panel, { type: 'synctex.configure', mode: this.getSyncTexMode(state.document.uri) });
        }
    }

    private handleWebviewMessage(
        message: WebviewToExtensionMessage,
        panel: vscode.WebviewPanel,
        document: PdfDocument,
    ): void {
        const state = this.panelStates.get(panel);
        if (!state) {
            return;
        }
        if (message.type === 'webview.ready' || message.type === 'webview.documentReady') {
            if (message.type === 'webview.ready') {
                state.ready = true;
                state.pendingSyncTexContextMenu = undefined;
                this.notify(panel, { type: 'synctex.configure', mode: this.getSyncTexMode(document.uri) });
                this.postPendingSyncTexForward(panel);
            } else if (this.diffSessionsByPanel.has(panel)) {
                return;
            }
            if (state.startingDocument) {
                return;
            }
            state.startingDocument = true;
            const loadId = this.beginDocumentLoad([panel]);
            void this.postDocument(panel, document, false, loadId).then(
                () => this.restoreDiffHighlights(panel, loadId).catch(error => {
                    console.error('Could not restore PDF diff highlights.', error);
                }),
                error => {
                    if (this.isCurrentDocumentLoad([panel], loadId)) {
                        console.error('Could not open the PDF.', error);
                        this.notify(panel, { type: 'document.loadError', loadId });
                    }
                },
            );
        } else if (message.type === 'document.rangeRequest') {
            void this.replyToRange(panel, state, message);
        } else if (message.type === 'document.rangeClose') {
            this.closeRange(panel, message.loadId);
        } else if (message.type === 'synctex.forwardResult') {
            const pending = state.pendingSyncTexForward;
            if (!pending
                || pending.requestId !== message.requestId
                || pending.postedLoadId !== message.loadId) {
                return;
            }
            state.pendingSyncTexForward = undefined;
        } else if (message.type === 'synctex.inverseClear') {
            state.pendingSyncTexContextMenu = undefined;
        } else if (message.type === 'synctex.inverse') {
            const mode = this.getSyncTexMode(document.uri);
            const expectedMode = message.trigger === 'rightClick' ? 'rightclick' : 'doubleclick';
            if (mode !== expectedMode) {
                state.pendingSyncTexContextMenu = undefined;
                return;
            }
            if (message.trigger === 'rightClick') {
                state.pendingSyncTexContextMenu = {
                    pageNumber: message.pageNumber,
                    x: message.x,
                    y: message.y,
                    context: message.context,
                    offset: message.offset,
                };
            } else {
                this.inverseSyncTexEmitter.fire({
                    type: 'synctex.inverse',
                    pdfUri: document.uri.toString(),
                    pageNumber: message.pageNumber,
                    x: message.x,
                    y: message.y,
                    trigger: 'doubleClick',
                    ...(message.context !== undefined && message.offset !== undefined
                        ? { context: message.context, offset: message.offset }
                        : {}),
                } satisfies SyncTexInverseEvent);
            }
        } else if (message.type === 'diff.failed') {
            const session = this.diffSessionsByPanel.get(panel);
            if (session?.modifiedPanel === panel && session.sessionId === message.sessionId) {
                void this.setDiffHighlightsForSession(session, false).catch(error => {
                    console.error('Could not disable PDF diff highlights.', error);
                });
                void vscode.window.showErrorMessage('Unable to compare the PDF revisions. PDF diff highlights were disabled.');
            }
        } else if (message.type === 'diff.pageResult') {
            const session = this.currentDiffSession(panel, message.sessionId);
            if (!session || session.modifiedPanel !== panel) {
                return;
            }
            this.notify(session.originalPanel, {
                type: 'diff.applyPage',
                sessionId: message.sessionId,
                pageNumber: message.pageNumber,
                changes: sanitizePdfDiffChanges(message.originalChanges),
            });
        } else if (message.type === 'diff.removedPageRange') {
            const session = this.currentDiffSession(panel, message.sessionId);
            if (!session || session.modifiedPanel !== panel) {
                return;
            }
            this.notify(session.originalPanel, {
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
            this.notify(session.modifiedPanel, {
                type: 'diff.scanForChange',
                sessionId: message.sessionId,
                requestId: message.requestId,
                role: message.role,
                direction: message.direction,
                startPage: message.startPage,
            });
        } else if (message.type === 'diff.navigationResult') {
            const session = this.currentDiffSession(panel, message.sessionId);
            if (!session || session.modifiedPanel !== panel) {
                return;
            }
            const targetPanel = message.role === 'modified' ? session.modifiedPanel : session.originalPanel;
            this.notify(targetPanel, {
                type: 'diff.revealChange',
                sessionId: message.sessionId,
                requestId: message.requestId,
                pageNumber: message.pageNumber,
                index: message.index,
                changes: sanitizePdfDiffChanges(message.changes),
            });
        } else if (message.type === 'diff.scroll') {
            if (!state.ready || state.latestDocumentLoadId !== message.loadId
                || state.postedDocumentLoadId !== message.loadId) {
                return;
            }
            const session = this.diffSessionsByPanel.get(panel);
            const targetPanel = session && panel === session.modifiedPanel
                ? session.originalPanel
                : session?.modifiedPanel;
            const targetState = targetPanel && this.panelStates.get(targetPanel);
            if (targetPanel && targetState?.ready && targetState.postedDocumentLoadId !== undefined
                && targetState.postedDocumentLoadId === targetState.latestDocumentLoadId) {
                this.notify(targetPanel, {
                    type: 'diff.applyScroll',
                    loadId: targetState.postedDocumentLoadId,
                    pageNumber: message.pageNumber,
                    pageRatio: message.pageRatio,
                    documentRatio: message.documentRatio,
                });
            }
        } else if (message.type === 'navigation.request') {
            if (!this.isMouseNavigationEnabled()) {
                return;
            }
            this.notify(panel, { type: message.direction === 'back' ? 'navigation.back' : 'navigation.forward' });
        } else if (message.type === 'navigation.keyUp') {
            this.releaseNavigationKeyLock(message.direction);
        } else {
            const command = workbenchCommands[message.type];
            void vscode.commands.executeCommand(command).then(undefined, error => {
                console.error(`Could not run ${command}.`, error);
            });
        }
    }

    private notify(panel: vscode.WebviewPanel, message: ExtensionToWebviewMessage): void {
        void panel.webview.postMessage(message).then(undefined, error => {
            console.error(`Could not send ${message.type} to the PDF viewer.`, error);
        });
    }

    private async postDocument(
        panel: vscode.WebviewPanel,
        document: PdfDocument,
        preserveView: boolean,
        reservedLoadId?: number,
        size = document.size,
    ): Promise<void> {
        const loadId = reservedLoadId ?? this.beginDocumentLoad([panel]);
        let file: PdfRangeFile | undefined;
        try {
            const fingerprint = document.uri.toString();
            let message: Extract<ExtensionToWebviewMessage, { type: 'document.load' | 'document.loadRange' }>;
            if (size >= minimumRemoteRangeSize && this.isRemoteFile(document.uri) && !this.diffSessionsByPanel.has(panel)) {
                file = await openPdfRangeFile(document.uri);
                const data = await file.read(0, Math.min(file.size, PDF_RANGE_CHUNK_BYTES));
                message = { type: 'document.loadRange', loadId, size: file.size, data, fingerprint, preserveView,
                    filename: basename(document.uri.fsPath) };
            } else {
                const data = await this.bufferDocument(document);
                message = { type: 'document.load', loadId, data: toArrayBuffer(data),
                    isEmptyRevision: data.byteLength === 0, fingerprint, preserveView };
            }
            const state = this.panelStates.get(panel);
            if (state?.latestDocumentLoadId !== loadId || !panel.visible) {
                return;
            }
            if (file) {
                document.size = file.size;
                if (preserveView) {
                    document.pendingData = undefined;
                    document.data = undefined;
                    document.source = undefined;
                }
                // PDF.js may still need the previous load's bytes to save edited form fields.
                state.ranges.set(loadId, { file, lastRequestId: 0, inFlight: 0 });
                file = undefined;
            }
            const delivered = await panel.webview.postMessage(message);
            if (delivered) {
                if (state?.latestDocumentLoadId === loadId) {
                    state.postedDocumentLoadId = loadId;
                    this.postPendingSyncTexForward(panel);
                }
            } else {
                this.closeRange(panel, loadId);
            }
        } catch (error) {
            this.closeRange(panel, loadId);
            throw error;
        } finally {
            await file?.close();
        }
    }

    private closeRange(panel: vscode.WebviewPanel, loadId?: number): void {
        const ranges = this.panelStates.get(panel)?.ranges;
        if (!ranges) {
            return;
        }
        for (const [id, { file }] of ranges) {
            if (loadId === undefined || id === loadId) {
                ranges.delete(id);
                void file.close().catch(error => console.error('Could not close the PDF range file.', error));
            }
        }
    }

    private async replyToRange(
        panel: vscode.WebviewPanel,
        state: PanelState,
        message: Extract<WebviewToExtensionMessage, { type: 'document.rangeRequest' }>,
    ): Promise<void> {
        const { loadId, requestId } = message;
        const range = state.ranges.get(loadId);
        if (!range || requestId <= range.lastRequestId
            || range.inFlight >= PDF_RANGE_CONCURRENCY) {
            return;
        }
        range.lastRequestId = requestId;
        range.inFlight++;
        try {
            const data = await range.file.read(message.begin, message.length).finally(() => { range.inFlight--; });
            if (state.ranges.has(loadId)) {
                await panel.webview.postMessage({
                    type: 'document.rangeData', loadId, requestId, data,
                } satisfies ExtensionToWebviewMessage);
            }
        } catch (error) {
            if (state.ranges.has(loadId)) {
                console.error('Could not read the PDF range.', error);
                this.closeRange(panel, loadId);
                await panel.webview.postMessage({ type: 'document.rangeError', loadId })
                    .then(undefined, () => undefined);
            }
        }
    }

    private async restoreDiffHighlights(panel: vscode.WebviewPanel, loadId: number): Promise<void> {
        if (!this.isCurrentDocumentLoad([panel], loadId)) {
            return;
        }
        const session = this.diffSessionsByPanel.get(panel);
        if (!session?.highlightsEnabled) {
            return;
        }
        const original = this.panelStates.get(session.originalPanel);
        const modified = this.panelStates.get(session.modifiedPanel);
        const originalId = original?.postedDocumentLoadId;
        const modifiedId = modified?.postedDocumentLoadId;
        if (!original?.ready || !modified?.ready || originalId === undefined || modifiedId === undefined
            || originalId !== original.latestDocumentLoadId || modifiedId !== modified.latestDocumentLoadId
            || (session.restoredLoadIds?.[0] === originalId && session.restoredLoadIds[1] === modifiedId)) {
            return;
        }
        session.restoredLoadIds = [originalId, modifiedId];
        await this.setDiffHighlightsForSession(session, true);
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
            this.notify(originalPanel, disableMessage);
        }
        if (modifiedPanel !== panel) {
            this.notify(modifiedPanel, disableMessage);
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
            const state = this.panelStates.get(panel);
            if (!state) {
                continue;
            }
            this.cancelReload(panel);
            state.latestDocumentLoadId = loadId;
            state.postedDocumentLoadId = undefined;
            state.pendingSyncTexContextMenu = undefined;
            this.cancelPostedSyncTexForward(panel);
        }
        return loadId;
    }

    private cancelReload(panel: vscode.WebviewPanel): void {
        const state = this.panelStates.get(panel);
        const cancellation = state?.reloadCancellation;
        if (cancellation) {
            state!.reloadCancellation = undefined;
            cancellation.cancel();
            cancellation.dispose();
        }
    }

    private isCurrentDocumentLoad(panels: vscode.WebviewPanel[], loadId: number): boolean {
        return panels.every(panel => this.panelStates.get(panel)?.latestDocumentLoadId === loadId);
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

    private isCurrentDiffPair(session: DiffPairSession): boolean {
        return this.diffSessionsByPanel.get(session.modifiedPanel) === session
            && this.diffSessionsByPanel.get(session.originalPanel) === session;
    }

    private diffPanelInfo(panel: vscode.WebviewPanel): DiffPanelInfo | undefined {
        const session = this.diffSessionsByPanel.get(panel);
        if (!session) {
            return undefined;
        }
        return panel === session.originalPanel ? session.originalInfo : session.modifiedInfo;
    }

    private findFallbackActivePanel(): vscode.WebviewPanel | undefined {
        const panels = [...this.panelStates.keys()];
        return panels.find(panel => panel.active)
            ?? panels.find(panel => panel.visible)
            ?? panels[0];
    }

    private setActivePanel(panel: vscode.WebviewPanel): void {
        if (!this.panelStates.has(panel)) {
            return;
        }
        if (this.activePanel !== panel) {
            for (const state of this.panelStates.values()) {
                state.pendingSyncTexContextMenu = undefined;
            }
        }
        this.activePanel = panel;
        this.refreshDiffContext();
    }

    private refreshDiffContext(): void {
        if (!this.diffEnabled) {
            return;
        }
        const session = this.activePanel && this.diffSessionsByPanel.get(this.activePanel);
        const next = {
            'academicPdfViewer.diffActive': !!session,
            'academicPdfViewer.diffHighlightsEnabled': session?.highlightsEnabled ?? false,
        };
        for (const [key, value] of Object.entries(next)) {
            if (value !== (this.diffContext.get(key) ?? false)) {
                this.diffContext.set(key, value);
                void vscode.commands.executeCommand('setContext', key, value).then(undefined, error => {
                    console.error('Could not update the PDF diff context.', error);
                });
            }
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

    private isLinkPreviewEnabled(documentUri: vscode.Uri): boolean {
        return vscode.workspace
            .getConfiguration('academicPdfViewer', documentUri)
            .get<boolean>('linkPreview.enabled', true);
    }

    private isMouseNavigationEnabled(): boolean {
        return vscode.workspace
            .getConfiguration('academicPdfViewer')
            .get<boolean>('navigation.mouseButtons', true);
    }

    private getMouseButtonMapping(): MouseButtonMapping {
        const value = vscode.workspace
            .getConfiguration('academicPdfViewer')
            .get<string>('navigation.mouseButtonMapping', 'standard');
        return value === 'swapped' ? 'swapped' : 'standard';
    }

    private getDefaultSidebar(): SidebarView {
        const value = vscode.workspace
            .getConfiguration('academicPdfViewer')
            .get<string>('navigation.defaultSidebar', 'pages');
        return value === 'outline' || value === 'attachments' || value === 'layers'
            ? value
            : 'pages';
    }

    /** Emits inverse SyncTeX for the position selected through the context menu. */
    inverseSyncTexFromContextMenu(): boolean {
        const panel = this.activePanel;
        if (!panel || !panel.active) {
            return false;
        }

        const state = this.panelStates.get(panel);
        const pending = state?.pendingSyncTexContextMenu;
        if (state) {
            state.pendingSyncTexContextMenu = undefined;
        }
        const document = state?.document;
        if (!pending
            || !document
            || this.getSyncTexMode(document.uri) !== 'rightclick') {
            return false;
        }
        this.inverseSyncTexEmitter.fire({
            type: 'synctex.inverse',
            pdfUri: document.uri.toString(),
            pageNumber: pending.pageNumber,
            x: pending.x,
            y: pending.y,
            trigger: 'rightClick',
            ...(pending.context !== undefined && pending.offset !== undefined
                ? { context: pending.context, offset: pending.offset }
                : {}),
        });
        return true;
    }

    /** Returns the configured inverse SyncTeX trigger mode. */
    private getSyncTexMode(documentUri: vscode.Uri): SyncTexMode {
        const value = vscode.workspace
            .getConfiguration('academicPdfViewer', documentUri)
            .get<string>('tex.synctex', 'doubleclick');
        return value === 'off' || value === 'rightclick' ? value : 'doubleclick';
    }

    private findSyncTexPanel(pdfUri: string): vscode.WebviewPanel | undefined {
        let canonicalUri: string;
        try {
            canonicalUri = vscode.Uri.parse(pdfUri, true).toString();
        } catch {
            return undefined;
        }
        if (canonicalUri !== pdfUri) {
            return undefined;
        }

        const matches = [...this.panelStates.entries()]
            .filter(([, state]) => state.document.uri.toString() === canonicalUri);
        const currentPanel = matches.find(([panel]) => panel.active)?.[0];
        if (currentPanel) {
            return currentPanel;
        }

        const recentPanel = this.activePanel
            && matches.some(([panel]) => panel === this.activePanel)
            ? this.activePanel
            : undefined;
        return recentPanel?.visible
            ? recentPanel
            : matches.find(([panel]) => panel.visible)?.[0] ?? recentPanel ?? matches[0]?.[0];
    }

    private postPendingSyncTexForward(panel: vscode.WebviewPanel): void {
        const state = this.panelStates.get(panel);
        const pending = state?.pendingSyncTexForward;
        const loadId = state?.postedDocumentLoadId;
        if (!pending
            || loadId === undefined
            || pending.postedLoadId === loadId
            || !panel.visible
            || !state?.ready) {
            return;
        }

        pending.postedLoadId = loadId;
        void panel.webview.postMessage({
            type: 'synctex.forward',
            requestId: pending.requestId,
            loadId,
            pageNumber: pending.pageNumber,
            x: pending.x,
            y: pending.y,
            ...(pending.targetBox ? { targetBox: pending.targetBox } : {}),
        } satisfies ExtensionToWebviewMessage).then(delivered => {
            const currentState = this.panelStates.get(panel);
            const current = currentState?.pendingSyncTexForward;
            if (currentState
                && !delivered
                && current?.requestId === pending.requestId
                && current.postedLoadId === loadId) {
                current.postedLoadId = undefined;
                currentState.ready = false;
            }
        }, error => {
            const current = this.panelStates.get(panel)?.pendingSyncTexForward;
            if (current?.requestId === pending.requestId
                && current.postedLoadId === loadId) {
                current.postedLoadId = undefined;
            }
            console.error('Could not send the SyncTeX location.', error);
        });
    }

    private cancelPostedSyncTexForward(panel: vscode.WebviewPanel): void {
        const pending = this.panelStates.get(panel)?.pendingSyncTexForward;
        const loadId = pending?.postedLoadId;
        if (!pending || loadId === undefined) {
            return;
        }

        pending.postedLoadId = undefined;
        this.notify(panel, {
            type: 'synctex.forwardCancel',
            requestId: pending.requestId,
            loadId,
        });
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
