const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

const { readPdfData } = require('../../out/extension/pdfDataSource.js');

const extensionId = 'ovolab-veritas.academic-pdf-viewer';
const viewType = 'academicPdfViewer.pdf';

async function waitFor(predicate, description, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = await predicate();
        if (value) {
            return value;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${description}.`);
}

function activeCustomEditor() {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    return input instanceof vscode.TabInputCustom && input.viewType === viewType ? input : undefined;
}

async function closeAllEditors() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(
        () => vscode.window.tabGroups.all.every(group => group.tabs.length === 0),
        'all editors to close',
    );
}

async function run() {
    const extension = vscode.extensions.getExtension(extensionId);
    assert(extension, `Extension ${extensionId} was not loaded.`);
    await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
        'academicPdfViewer.reload',
        'academicPdfViewer.toggleDiffHighlights',
        'academicPdfViewer.previousDiffChange',
        'academicPdfViewer.nextDiffChange',
    ]) {
        assert(commands.includes(command), `Command ${command} was not registered.`);
    }

    const fixtureRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert(fixtureRoot, 'The manual test workspace was not opened.');

    const missingGitPdfPath = path.join(fixtureRoot, '__missing_git_revision__.pdf');
    const missingGitPdf = vscode.Uri.from({
        scheme: 'git',
        path: missingGitPdfPath,
        query: JSON.stringify({ path: missingGitPdfPath, ref: 'HEAD' }),
    });
    const missingGitData = await readPdfData(missingGitPdf);
    assert.equal(missingGitData.byteLength, 0, 'A missing Git revision should be treated as an empty PDF.');

    const ordinaryPdf = vscode.Uri.file(path.join(fixtureRoot, 'lewm.pdf'));
    await vscode.commands.executeCommand('vscode.openWith', ordinaryPdf, viewType);
    await waitFor(activeCustomEditor, 'the ordinary PDF custom editor');
    await vscode.commands.executeCommand('academicPdfViewer.reload');
    await closeAllEditors();
}

module.exports = { run };
