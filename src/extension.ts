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
    const setDiffHighlights = async (enabled?: boolean): Promise<void> => {
        try {
            const result = enabled === undefined
                ? await provider.toggleDiffHighlights()
                : await provider.setDiffHighlights(enabled);
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
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('academicPdfViewer.linkPreview')) {
                provider.refreshLinkPreviewConfiguration();
            }
        }),
    );
}
