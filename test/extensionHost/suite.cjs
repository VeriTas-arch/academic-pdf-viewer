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
    const api = await extension.activate();
    assert.equal(extension.isActive, true);
    assert.equal(typeof api?.tex?.synctexForward, 'function', 'The exported SyncTeX forward API was not available.');
    assert.equal(
        typeof api?.tex?.onDidRequestInverseSyncTex,
        'function',
        'The exported inverse SyncTeX event was not available.',
    );

    let inverseEvent;
    const inverseSubscription = api.tex.onDidRequestInverseSyncTex(event => {
        inverseEvent = event;
    });

    const commands = await vscode.commands.getCommands(true);
    for (const command of [
        'academicPdfViewer.reload',
        'academicPdfViewer.tex.synctexForward',
        'academicPdfViewer.tex.synctexForwardFromCursor',
        'academicPdfViewer.tex.synctexInverse',
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
    const cancellationSource = new vscode.CancellationTokenSource();
    const cancelledGitRead = readPdfData(missingGitPdf, undefined, cancellationSource.token);
    cancellationSource.cancel();
    await assert.rejects(
        cancelledGitRead,
        error => error instanceof vscode.CancellationError,
        'A cancelled Git PDF read should reject with CancellationError.',
    );
    cancellationSource.dispose();

    const missingGitData = await readPdfData(missingGitPdf);
    assert.equal(missingGitData.byteLength, 0, 'A missing Git revision should be treated as an empty PDF.');

    const invalidGitRef = vscode.Uri.from({
        scheme: 'git',
        path: missingGitPdfPath,
        query: JSON.stringify({ path: missingGitPdfPath, ref: 'refs/heads/__academic_pdf_viewer_missing_ref__' }),
    });
    await assert.rejects(
        readPdfData(invalidGitRef),
        /Git rev-parse failed/,
        'An invalid Git ref should not be treated as an empty PDF revision.',
    );

    const ordinaryPdf = vscode.Uri.file(path.join(fixtureRoot, 'lewm.pdf'));
    await vscode.commands.executeCommand('vscode.openWith', ordinaryPdf, viewType);
    await waitFor(activeCustomEditor, 'the ordinary PDF custom editor');

    const forwardRequest = {
        type: 'synctex.forward',
        pdfUri: ordinaryPdf.toString(),
        pageNumber: 1,
        x: 72,
        y: 72,
        targetBox: { x: 60, y: 66, width: 240, height: 12 },
    };
    assert.equal(
        api.tex.synctexForward(forwardRequest),
        true,
        'The exported API should accept a forward request for the open canonical PDF URI.',
    );
    assert.equal(
        await vscode.commands.executeCommand('academicPdfViewer.tex.synctexForward', forwardRequest),
        true,
        'The command API should accept the same canonical forward request.',
    );
    assert.equal(
        api.tex.synctexForward({ ...forwardRequest, pdfUri: ordinaryPdf.fsPath }),
        false,
        'A filesystem path must not be treated as the canonical PDF URI.',
    );
    assert.equal(
        api.tex.synctexForward({
            ...forwardRequest,
            targetBox: { ...forwardRequest.targetBox, width: 0 },
        }),
        false,
        'A non-positive SyncTeX target box must be rejected.',
    );
    assert.equal(
        await vscode.commands.executeCommand('academicPdfViewer.tex.synctexForward', {
            ...forwardRequest,
            pageNumber: 0,
        }),
        false,
        'The command API should reject malformed forward requests.',
    );
    assert.equal(
        await vscode.commands.executeCommand('academicPdfViewer.tex.synctexInverse'),
        false,
        'The context-menu command should reject execution without a pending PDF-page request.',
    );
    assert.equal(inverseEvent, undefined, 'Rejected integration commands must not emit an inverse event.');

    await vscode.commands.executeCommand('academicPdfViewer.reload');
    await closeAllEditors();
    inverseSubscription.dispose();
}

module.exports = { run };
