const assert = require('node:assert/strict');
const vscode = require('vscode');

async function waitFor(predicate, description) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

async function run() {
    const extension = vscode.extensions.getExtension('ovolab-veritas.academic-pdf-viewer');
    assert(extension, 'The PDF viewer extension was not loaded.');
    const api = await extension.activate();
    const proposed = extension.packageJSON.enabledApiProposals?.includes('customEditorDiffs') ?? false;
    const commands = await vscode.commands.getCommands(true);
    assert.equal(commands.includes('academicPdfViewer.toggleDiffHighlights'), proposed);

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert(workspace, 'The fixture workspace was not opened.');
    const original = vscode.Uri.joinPath(workspace, 'original.pdf');
    const modified = vscode.Uri.joinPath(workspace, 'modified.pdf');
    const viewType = extension.packageJSON.contributes.customEditors[0].viewType;
    const request = pdfUri => ({ type: 'synctex.forward', pdfUri: pdfUri.toString(), pageNumber: 1, x: 72, y: 72 });

    await vscode.commands.executeCommand('vscode.openWith', original, viewType);
    await waitFor(() => {
        const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
        return input instanceof vscode.TabInputCustom && input.viewType === viewType;
    }, 'the custom PDF editor');
    assert.equal(await vscode.commands.executeCommand('academicPdfViewer.tex.synctexForward', request(original)), true);
    await vscode.commands.executeCommand('academicPdfViewer.reload');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => !api.tex.synctexForward(request(original)), 'the PDF editor to close');

    if (proposed) {
        await vscode.commands.executeCommand('vscode.diff', original, modified, 'PDF diff smoke');
        await waitFor(() => api.tex.synctexForward(request(original)) && api.tex.synctexForward(request(modified)),
            'both sides of the PDF diff');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
}

module.exports = { run };
