const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');
const test = require('node:test');
const { loadSource, EventEmitter } = require('./helpers/extensionSource.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
    const calls = [];
    const commands = new Map();
    const configuration = new EventEmitter();
    const inverse = new EventEmitter();
    const logs = [];
    const errors = [];
    const opens = [];
    const forwarded = [];
    let outputDisposed = false;
    const append = value => { assert.equal(outputDisposed, false); logs.push(value); };
    const sourcePath = path.resolve('manual-tests/source.tex');
    const fileUri = fsPath => ({ scheme: 'file', fsPath, toString: () => pathToFileURL(fsPath).href });
    const vscode = {
        Uri: { file: fileUri, parse: value => fileUri(fileURLToPath(value)) },
        FileType: { File: 1 }, ViewColumn: { One: 1, Beside: 2 },
        TextEditorRevealType: { InCenterIfOutsideViewport: 0 },
        Position: class { constructor(line, character) { Object.assign(this, { line, character }); } },
        Range: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        Selection: class { constructor(start, end) { Object.assign(this, { start, end }); } },
        workspace: {
            isTrusted: true,
            getConfiguration: () => ({ get: (key, fallback) => key === 'tex.bridge.enabled' ? true : fallback }),
            onDidChangeConfiguration: configuration.event,
            fs: { stat: async () => ({ type: 1 }) },
            openTextDocument: async uri => {
                opens.push(uri.fsPath);
                return { lineCount: 1, lineAt: () => ({ text: 'source', range: {} }) };
            },
        },
        window: {
            activeTextEditor: { document: { uri: fileUri(sourcePath) }, selection: { active: { line: 2, character: 4 } } },
            createOutputChannel: () => ({ append, appendLine: append, show() {}, dispose() { outputDisposed = true; } }),
            showErrorMessage: value => errors.push(value),
            showTextDocument: async () => ({ revealRange() {} }),
        },
        commands: {
            registerCommand: (name, callback) => { commands.set(name, callback); return { dispose: () => commands.delete(name) }; },
            executeCommand: async (...args) => opens.push(args),
        },
    };
    const context = { subscriptions: [] };
    const { registerSyncTexCliBridge, SYNCTEX_FORWARD_FROM_CURSOR_COMMAND } = loadSource(
        'extension/synctexCliBridge.ts', vscode, { './pdfEditorProvider': { PDF_VIEW_TYPE: 'academicPdfViewer.pdf' } });
    registerSyncTexCliBridge(context, {
        onDidRequestInverseSyncTex: inverse.event,
        synctexForward: request => { forwarded.push(request); return true; },
    }, request => new Promise((resolve, reject) => calls.push({ request, resolve, reject })));
    const dispose = () => { for (const item of context.subscriptions) item.dispose(); };
    t.after(dispose);
    return {
        calls, configuration, inverse, logs, errors, opens, forwarded, vscode, dispose,
        forward: commands.get(SYNCTEX_FORWARD_FROM_CURSOR_COMMAND),
        inverseEvent: { pdfUri: pathToFileURL(path.resolve('manual-tests/source.pdf')).href, pageNumber: 1, x: 1, y: 1 },
    };
}
const forwardResult = marker => ({ stdout: `Page:1\nx:1\ny:1\nMarker:${marker}`, stderr: '' });

test('replaces forward processes and captures the cursor before asynchronous stat', async t => {
    const f = fixture(t);
    let releaseStat;
    f.vscode.workspace.fs.stat = () => new Promise(resolve => { releaseStat = resolve; });
    const first = f.forward();
    f.vscode.window.activeTextEditor.selection.active = { line: 50, character: 60 };
    releaseStat({ type: 1 });
    await tick();
    assert.match(f.calls[0].request.args[2], /^3:5:/);
    f.vscode.workspace.fs.stat = async () => ({ type: 1 });
    const second = f.forward();
    await tick();
    assert.equal(f.calls[0].request.signal.aborted, true);
    f.calls[0].resolve(forwardResult('stale'));
    assert.equal(await first, false);
    f.calls[1].resolve(forwardResult('current'));
    assert.equal(await second, true);
    assert.equal(f.forwarded.length, 1);
    assert.equal(f.logs.some(value => value.includes('Marker:stale')), false);
    assert.deepEqual(f.errors, []);
});

test('replaces inverse processes and opens only the latest source', async t => {
    const f = fixture(t);
    f.inverse.fire(f.inverseEvent);
    f.inverse.fire(f.inverseEvent);
    assert.equal(f.calls[0].request.signal.aborted, true);
    f.calls[0].resolve({ stdout: 'Input:old.tex\nLine:1\nColumn:1', stderr: '' });
    f.calls[1].resolve({ stdout: 'Input:current.tex\nLine:1\nColumn:1', stderr: '' });
    await tick();
    assert.equal(f.opens.length, 1);
    assert.equal(path.basename(f.opens[0]), 'current.tex');
    assert.deepEqual(f.errors, []);
});

test('configuration changes and bridge disposal abort pending requests without late UI or logs', async t => {
    const f = fixture(t);
    const first = f.forward();
    await tick();
    f.configuration.fire({ affectsConfiguration: section => section === 'academicPdfViewer.tex.bridge' });
    assert.equal(f.calls[0].request.signal.aborted, true);
    f.calls[0].resolve(forwardResult('disabled'));
    assert.equal(await first, false);
    const second = f.forward();
    await tick();
    f.inverse.fire(f.inverseEvent);
    const logCount = f.logs.length;
    f.dispose();
    assert.equal(f.calls[1].request.signal.aborted, true);
    assert.equal(f.calls[2].request.signal.aborted, true);
    f.calls[1].resolve(forwardResult('disposed'));
    f.calls[2].reject(new Error('late process failure'));
    assert.equal(await second, false);
    await tick();
    assert.equal(f.logs.length, logCount);
    assert.deepEqual(f.opens, []);
    assert.deepEqual(f.errors, []);
    assert.equal(await f.forward(), false);
});

test('untrusted workspaces never launch forward or inverse SyncTeX processes', async t => {
    const f = fixture(t);
    f.vscode.workspace.isTrusted = false;
    assert.equal(await f.forward(), false);
    f.inverse.fire(f.inverseEvent);
    await tick();
    assert.deepEqual(f.calls, []);
    assert.equal(f.errors.length, 2);
    assert(f.errors.every(value => value.includes('Trust this workspace')));
});
