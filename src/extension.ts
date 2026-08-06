import * as vscode from 'vscode';

import { PDF_VIEW_TYPE, PdfEditorProvider } from './extension/pdfEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new PdfEditorProvider(context);

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
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('academicPdfViewer.linkPreview.enabled')) {
                provider.refreshLinkPreviewConfiguration();
            }
        }),
    );
}

export function deactivate(): void {
    // No extension-wide resources to dispose.
}
