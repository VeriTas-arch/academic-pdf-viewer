const assert = require('node:assert/strict');
const test = require('node:test');
const { loadSource, EventEmitter, CancellationError, CancellationTokenSource } = require('./helpers/extensionSource.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, reader) {
    const errors = [];
    const vscode = {
        EventEmitter, CancellationError, CancellationTokenSource,
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        commands: { executeCommand: async () => undefined },
        window: { showErrorMessage: message => errors.push(message) },
        Uri: { joinPath: () => ({}) },
    };
    const context = { subscriptions: [], extensionUri: {} };
    const { PdfEditorProvider } = loadSource('extension/pdfEditorProvider.ts', vscode, {
        './viewerHtml': { readViewerHtml: () => '', renderViewerHtml: () => '' },
        './pdfDataSource': { readPdfData: reader, describePdfUri: () => ({}) },
    });
    const provider = new PdfEditorProvider(context);
    t.after(() => { for (const item of context.subscriptions) item.dispose(); });
    async function open(name) {
        const messages = [];
        const received = new EventEmitter();
        const disposed = new EventEmitter();
        const viewState = new EventEmitter();
        const uri = { scheme: 'file', fsPath: name, toString: () => `file:///${name}` };
        const document = { uri, data: new Uint8Array([1]) };
        const panel = {
            active: true, visible: true,
            onDidDispose: disposed.event,
            onDidChangeViewState: viewState.event,
            webview: {
                onDidReceiveMessage: received.event,
                postMessage: async message => { messages.push(message); return true; },
            },
        };
        await provider.resolveCustomEditor(document, panel, { isCancellationRequested: false });
        received.fire({ type: 'webview.ready' });
        await tick();
        messages.length = 0;
        return {
            panel, document, messages, received, dispose: () => disposed.fire(),
            hide: () => { panel.visible = false; panel.active = false; viewState.fire({ webviewPanel: panel }); },
            show: () => { panel.visible = true; panel.active = true; viewState.fire({ webviewPanel: panel }); },
        };
    }
    const first = await open('paper.pdf');
    return { provider, first, open, errors };
}
function pendingReads() {
    const requests = [];
    const reader = (uri, _logger, token) => new Promise((resolve, reject) => {
        const listener = token.onCancellationRequested(() => reject(new CancellationError()));
        requests.push({ uri, token, resolve: data => { listener.dispose(); resolve(data); }, reject });
    });
    return { reader, requests };
}
function pair(f, second) {
    const session = {
        originalPanel: f.first.panel, modifiedPanel: second.panel,
        originalDocument: f.first.document,
        originalInfo: { role: 'original', label: 'HEAD' }, modifiedInfo: { role: 'modified', label: 'Working tree' },
        highlightsEnabled: false,
    };
    f.provider.diffSessionsByPanel.set(f.first.panel, session);
    f.provider.diffSessionsByPanel.set(second.panel, session);
    return session;
}

test('a newer reload cancels its predecessor and only publishes the latest PDF', async t => {
    const reads = pendingReads();
    const f = await fixture(t, reads.reader);
    const first = f.provider.reloadActive();
    const second = f.provider.reloadActive();
    assert.equal(reads.requests[0].token.isCancellationRequested, true);
    assert.equal(reads.requests[1].token.isCancellationRequested, false);
    reads.requests[1].resolve(new Uint8Array([2]));
    await Promise.all([first, second]);
    assert.deepEqual([...f.first.document.data], [2]);
    assert.equal(f.first.messages.filter(message => message.type === 'document.load').length, 1);
    assert.deepEqual(f.errors, []);
});

test('closing a panel cancels its pending reload and suppresses late errors', async t => {
    const reads = pendingReads();
    const f = await fixture(t, reads.reader);
    const reload = f.provider.reloadActive();
    f.first.dispose();
    await reload;
    assert.equal(reads.requests[0].token.isCancellationRequested, true);
    assert.deepEqual(f.first.messages, []);
    assert.deepEqual(f.errors, []);
});

test('provider disposal cancels pending reloads and clears navigation timers', async t => {
    const reads = pendingReads();
    const f = await fixture(t, reads.reader);
    const reload = f.provider.reloadActive();
    f.provider.navigationKeyLocks.set('back', setTimeout(() => assert.fail('disposed timer fired'), 100));
    f.provider.dispose();
    await reload;
    assert.equal(reads.requests[0].token.isCancellationRequested, true);
    assert.equal(f.provider.navigationKeyLocks.size, 0);
    assert.equal(f.provider.panelStates.size, 0);
    assert.deepEqual(f.errors, []);
});

test('a failed diff-side read cancels the other side without replacing either document', async t => {
    const reads = pendingReads();
    const f = await fixture(t, reads.reader);
    const second = await f.open('modified.pdf');
    pair(f, second);
    f.provider.activePanel = second.panel;
    const reload = f.provider.reloadActive();
    reads.requests[0].reject(new Error('fixture read failed'));
    await reload;
    assert.equal(reads.requests[1].token.isCancellationRequested, true);
    assert.deepEqual([...f.first.document.data], [1]);
    assert.deepEqual([...second.document.data], [1]);
    assert.equal(f.errors.length, 1);
});

test('closing either diff side cancels both reads', async t => {
    const reads = pendingReads();
    const f = await fixture(t, reads.reader);
    const second = await f.open('modified.pdf');
    pair(f, second);
    f.provider.activePanel = second.panel;
    const reload = f.provider.reloadActive();
    f.first.dispose();
    await reload;
    assert(reads.requests.every(request => request.token.isCancellationRequested));
    assert.deepEqual(f.errors, []);
});

test('diff scroll rejects stale loads and tags the target load with highlights disabled', async t => {
    const f = await fixture(t, async () => new Uint8Array([2]));
    const second = await f.open('modified.pdf');
    pair(f, second);
    const sourceId = f.provider.panelStates.get(f.first.panel).postedDocumentLoadId;
    const targetId = f.provider.panelStates.get(second.panel).postedDocumentLoadId;
    const scroll = { type: 'diff.scroll', pageNumber: 1, pageRatio: 0.5, documentRatio: 0.5 };
    f.first.received.fire({ ...scroll, loadId: sourceId + 100 });
    f.first.received.fire(scroll);
    assert.deepEqual(second.messages, []);
    f.first.received.fire({ ...scroll, loadId: sourceId });
    assert.deepEqual(second.messages, [{ ...scroll, type: 'diff.applyScroll', loadId: targetId }]);
    second.messages.length = 0;
    f.provider.beginDocumentLoad([second.panel]);
    f.first.received.fire({ ...scroll, loadId: sourceId });
    assert.deepEqual(second.messages, []);
});

test('restores enabled highlights after both hidden diff webviews become ready again', async t => {
    const f = await fixture(t, async () => new Uint8Array([2]));
    const second = await f.open('modified.pdf');
    pair(f, second);
    f.provider.activePanel = second.panel;
    await f.provider.setDiffHighlights(true);
    f.first.hide();
    second.hide();
    f.first.messages.length = second.messages.length = 0;
    f.first.show();
    f.first.received.fire({ type: 'webview.ready' });
    await tick();
    assert.equal(f.first.messages.some(message => message.type === 'diff.setEnabled'), false);
    second.show();
    second.received.fire({ type: 'webview.ready' });
    await tick();
    for (const side of [f.first, second]) {
        const controls = side.messages.filter(message => message.type === 'diff.setEnabled');
        assert.equal(controls.length, 1);
        assert.equal(controls[0].enabled, true);
    }
});
