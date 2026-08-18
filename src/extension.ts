import * as vscode from 'vscode';

import { createDevLogger } from './extension/devLogger';
import { PDF_VIEW_TYPE, PdfEditorProvider } from './extension/pdfEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    const logger = createDevLogger(context);
    logger?.info('extension.activate', {
        extensionMode: 'development',
        version: context.extension.packageJSON.version,
    });
    const provider = new PdfEditorProvider(context, logger);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, provider, {
            supportsMultipleEditorsPerDocument: true,
        }),
        vscode.commands.registerCommand('academicPdfViewer.navigateBack', () => {
            provider.navigate('back');
        }),
        vscode.commands.registerCommand('academicPdfViewer.navigateForward', () => {
            provider.navigate('forward');
        }),
        vscode.commands.registerCommand('academicPdfViewer.reload', () => {
            provider.reloadActive();
        }),
        vscode.commands.registerCommand('academicPdfViewer.toggleLinkPreview', async () => {
            const enabled = await provider.toggleLinkPreviewActive();
            if (enabled !== undefined) {
                void vscode.window.showInformationMessage(`PDF link preview ${enabled ? 'enabled' : 'disabled'}.`);
            }
        }),
        vscode.commands.registerCommand('academicPdfViewer.toggleDiffHighlights', async () => {
            try {
                const enabled = await provider.toggleDiffHighlights();
                if (enabled === undefined) {
                    void vscode.window.showInformationMessage('PDF diff highlights are only available in a PDF diff editor.');
                } else {
                    void vscode.window.showInformationMessage(`PDF diff highlights ${enabled ? 'enabled' : 'disabled'}.`);
                }
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                void vscode.window.showErrorMessage(`Unable to toggle PDF diff highlights: ${detail}`);
            }
        }),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('academicPdfViewer.linkPreview.enabled')) {
                provider.refreshLinkPreviewConfiguration();
            }
        }),
    );
}
