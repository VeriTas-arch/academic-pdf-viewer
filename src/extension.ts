import * as vscode from 'vscode';

import {
    PDF_VIEW_TYPE,
    PdfEditorProvider,
} from './extension/pdfEditorProvider';
import { registerSyncTexCliBridge } from './extension/synctexCliBridge';
import {
    isSyncTexForwardRequest,
    type SyncTexForwardRequest,
    type SyncTexInverseEvent,
} from './shared/protocol';

export interface AcademicPdfViewerApi {
    readonly tex: {
        readonly onDidRequestInverseSyncTex: vscode.Event<SyncTexInverseEvent>;
        synctexForward(request: SyncTexForwardRequest): boolean;
    };
}

export function activate(context: vscode.ExtensionContext): AcademicPdfViewerApi {
    const manifest = context.extension.packageJSON as { enabledApiProposals?: string[] };
    const diffEnabled = manifest.enabledApiProposals?.includes('customEditorDiffs') === true;
    const provider = new PdfEditorProvider(context, diffEnabled);
    const editorProvider = diffEnabled ? provider : {
        openCustomDocument: provider.openCustomDocument.bind(provider),
        resolveCustomEditor: provider.resolveCustomEditor.bind(provider),
    };
    const tex = {
        onDidRequestInverseSyncTex: provider.onDidRequestInverseSyncTex,
        synctexForward: (request: unknown) => isSyncTexForwardRequest(request) && provider.synctexForward(request),
    };
    registerSyncTexCliBridge(context, tex, PDF_VIEW_TYPE);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, editorProvider, {
            supportsMultipleEditorsPerDocument: true,
        }),
        vscode.commands.registerCommand('academicPdfViewer.navigateBack', () => {
            provider.navigate('back');
        }),
        vscode.commands.registerCommand('academicPdfViewer.navigateForward', () => {
            provider.navigate('forward');
        }),
        vscode.commands.registerCommand('academicPdfViewer.reload', () => {
            return provider.reloadActive();
        }),
        vscode.commands.registerCommand('academicPdfViewer.tex.synctexForward', tex.synctexForward),
        vscode.commands.registerCommand('academicPdfViewer.tex.synctexInverse', () => (
            provider.inverseSyncTexFromContextMenu()
        )),
        vscode.commands.registerCommand('academicPdfViewer.toggleLinkPreview', async () => {
            const enabled = await provider.toggleLinkPreviewActive();
            if (enabled !== undefined) {
                void vscode.window.showInformationMessage(`PDF link preview ${enabled ? 'enabled' : 'disabled'}.`);
            }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('academicPdfViewer.linkPreview')) {
                provider.refreshLinkPreviewConfiguration();
            }
            if (event.affectsConfiguration('academicPdfViewer.navigation.mouseButtons')
                || event.affectsConfiguration('academicPdfViewer.navigation.mouseButtonMapping')) {
                provider.refreshMouseNavigationConfiguration();
            }
            if (event.affectsConfiguration('academicPdfViewer.navigation.defaultSidebar')) {
                provider.refreshSidebarConfiguration();
            }
            if (event.affectsConfiguration('academicPdfViewer.tex.synctex')) {
                provider.refreshSyncTexConfiguration();
            }
        }),
    );

    if (diffEnabled) {
        const setDiffHighlights = async (enabled?: boolean): Promise<void> => {
            try {
                const result = await provider.setDiffHighlights(enabled);
                if (result === undefined) {
                    void vscode.window.showInformationMessage('PDF diff highlights are only available in a PDF diff editor.');
                } else {
                    void vscode.window.showInformationMessage(`PDF diff highlights ${result ? 'enabled' : 'disabled'}.`);
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Unable to update PDF diff highlights: ${detail}`);
            }
        };
        context.subscriptions.push(
            vscode.commands.registerCommand('academicPdfViewer.toggleDiffHighlights', () => setDiffHighlights()),
            vscode.commands.registerCommand('academicPdfViewer.enableDiffHighlights', () => setDiffHighlights(true)),
            vscode.commands.registerCommand('academicPdfViewer.disableDiffHighlights', () => setDiffHighlights(false)),
            vscode.commands.registerCommand('academicPdfViewer.previousDiffChange', () => {
                if (!provider.navigateDiffChange('previous')) {
                    void vscode.window.showInformationMessage('Enable PDF diff highlights before navigating changes.');
                }
            }),
            vscode.commands.registerCommand('academicPdfViewer.nextDiffChange', () => {
                if (!provider.navigateDiffChange('next')) {
                    void vscode.window.showInformationMessage('Enable PDF diff highlights before navigating changes.');
                }
            }),
        );
    }

    return { tex };
}
