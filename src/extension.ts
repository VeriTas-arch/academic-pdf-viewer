import * as vscode from 'vscode';

import { PDF_VIEW_TYPE, PdfEditorProvider } from './extension/pdfEditorProvider';

export function activate(context: vscode.ExtensionContext) {
    const provider = new PdfEditorProvider(context);

    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, provider, {
            supportsMultipleEditorsPerDocument: true,
        }),
        vscode.commands.registerCommand('academicPdfViewer.navigateBack', () => {
            provider.postToActive({ type: 'navigation.back' });
        }),
        vscode.commands.registerCommand('academicPdfViewer.navigateForward', () => {
            provider.postToActive({ type: 'navigation.forward' });
        }),
    );
}

export function deactivate(): void {
    // No extension-wide resources to dispose.
}
