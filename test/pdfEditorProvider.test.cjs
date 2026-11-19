const assert = require('node:assert/strict');
const test = require('node:test');
const { loadSource, EventEmitter, CancellationError, CancellationTokenSource } = require('./helpers/extensionSource.cjs');

const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, reader, rangeFile, size = rangeFile?.size ?? 1) {
    const errors = [];
    const vscode = {
        EventEmitter, CancellationError, CancellationTokenSource,
        workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
        commands: { executeCommand: async () => undefined },
        window: { showErrorMessage: message => errors.push(message) },
        Uri: { joinPath: () => ({}) },
    };
    const context = { subscriptions: [], extensionUri: {} };
    if (rangeFile) {
        vscode.env = { remoteName: 'ssh-remote' };
        vscode.ExtensionKind = { Workspace: 2 };
        vscode.workspace.fs = { stat: async () => ({ size: rangeFile.size }) };
        context.extension = { extensionKind: 2 };
    }
    const { PdfEditorProvider } = loadSource('extension/pdfEditorProvider.ts', vscode, {
        './viewerHtml': { readViewerHtml: () => '', renderViewerHtml: () => '' },
        './pdfDataSource': {
            preparePdfData: async () => ({ size }),
            readPdfData: reader,
            openPdfRangeFile: async () => rangeFile,
        },
    });
    const provider = new PdfEditorProvider(context);
    t.after(() => { for (const item of context.subscriptions) item.dispose(); });
    async function open(name, uncached = false) {
        const messages = [];
        const received = new EventEmitter();
        const disposed = new EventEmitter();
        const viewState = new EventEmitter();
        const uri = { scheme: 'file', fsPath: name, toString: () => `file:///${name}` };
        const document = rangeFile || uncached
            ? await provider.openCustomDocument(uri, {}, { isCancellationRequested: false })
            : { uri, data: new Uint8Array([1]) };
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
        received.fire({ type: 'webview.documentReady' });
        received.fire({ type: 'webview.ready' });
        await tick();
        if (!rangeFile && !uncached) messages.length = 0;
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
    const reader = (uri, token) => new Promise((resolve, reject) => {
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

test('a failed initial PDF read is attempted once across both readiness messages', async t => {
    let reads = 0;
    const f = await fixture(t, async () => {
        reads++;
        throw new Error('Cannot read PDF');
    });
    const panel = await f.open('unreadable.pdf', true);
    assert.equal(reads, 1);
    assert.equal(panel.messages.filter(message => message.type === 'document.loadError').length, 1);
});

test('buffered PDF reloads reuse dedicated storage and send only the bytes of a sliced buffer', async t => {
    const owned = new Uint8Array([1, 2]);
    const sliced = new Uint8Array([0, 3, 4, 0]).subarray(1, 3);
    const reads = [owned, sliced];
    const f = await fixture(t, async () => reads.shift());
    await f.provider.reloadActive();
    await f.provider.reloadActive();
    const [first, second] = f.first.messages.filter(message => message.type === 'document.load');
    assert.equal(first.data, owned.buffer);
    assert.deepEqual([...new Uint8Array(second.data)], [3, 4]);
});

test('a rejected diff delivery rolls back the peer and leaves highlights disabled', async t => {
    const f = await fixture(t, () => assert.fail('read the cached PDF again'));
    const second = await f.open('modified.pdf');
    const session = pair(f, second);
    second.panel.webview.postMessage = async message => {
        second.messages.push(message);
        if (message.enabled) throw new Error('Diff delivery failed');
        return true;
    };
    await assert.rejects(f.provider.setDiffHighlights(true), /Diff delivery failed/);
    assert.deepEqual(f.first.messages.map(message => message.enabled), [true, false]);
    assert.deepEqual(second.messages.map(message => message.enabled), [true, false]);
    assert.equal(session.highlightsEnabled, false);
});

test('only serves range requests for the current remote panel load', async t => {
    const reads = [];
    const closed = [];
    const f = await fixture(t, () => assert.fail('read the whole remote PDF'), {
        size: 2 * 1024 * 1024,
        async read(begin, length) {
            reads.push({ begin, length });
            return new ArrayBuffer(length);
        },
        async close() { closed.push(true); },
    });
    const initial = f.first.messages.filter(message => message.type === 'document.loadRange');
    assert.equal(initial.length, 1);
    assert.deepEqual(reads, [{ begin: 0, length: 64 * 1024 }]);
    const request = { type: 'document.rangeRequest', loadId: initial[0].loadId, requestId: 1, begin: 64 * 1024, length: 8192 };
    f.first.received.fire(request);
    await tick();
    assert.equal(f.first.messages.find(message => message.type === 'document.rangeData').data.byteLength, 8192);
    f.first.received.fire({ ...request, requestId: 2, length: 512 * 1024 + 1 });
    f.first.received.fire({ ...request, requestId: 3, loadId: request.loadId + 1 });
    assert.equal(reads.length, 2);
    f.first.dispose();
    f.first.received.fire(request);
    await tick();
    assert.equal(reads.length, 2);
    assert.equal(closed.length, 1);
});

test('a ranged replacement keeps the previous file readable until the viewer closes it', async t => {
    let closed = 0;
    const f = await fixture(t, () => assert.fail('read the whole remote PDF'), {
        size: 2 * 1024 * 1024,
        async read(_begin, length) { return new ArrayBuffer(length); },
        async close() { closed++; },
    });
    const initial = f.first.messages.find(message => message.type === 'document.loadRange');
    await f.provider.reloadActive();
    const replacement = f.first.messages.filter(message => message.type === 'document.loadRange').at(-1);
    assert.notEqual(replacement.loadId, initial.loadId);
    assert.equal(closed, 0);
    const request = { type: 'document.rangeRequest', loadId: initial.loadId, requestId: 1, begin: 65_536, length: 65_536 };
    f.first.received.fire(request);
    await tick();
    assert(f.first.messages.some(message => message.type === 'document.rangeData' && message.loadId === initial.loadId));
    f.first.received.fire({ type: 'document.rangeClose', loadId: initial.loadId });
    assert.equal(closed, 1);
});

test('diff reload rejects an oversized pair before reading either PDF', async t => {
    const f = await fixture(t, () => assert.fail('read a PDF before enforcing the pair limit'), undefined, 300 * 1024 * 1024);
    const second = await f.open('modified.pdf');
    pair(f, second);
    await f.provider.reloadActive();
    assert.match(f.errors[0], /combined safety limit/);
});

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

test('a failed diff-side read cancels the other side without replacing either document', async t => {
    const reads = pendingReads();
    const f = await fixture(t, reads.reader);
    const second = await f.open('modified.pdf');
    pair(f, second);
    f.provider.activePanel = second.panel;
    const reload = f.provider.reloadActive();
    await tick();
    reads.requests[0].reject(new Error('fixture read failed'));
    await reload;
    assert.equal(reads.requests[1].token.isCancellationRequested, true);
    assert.deepEqual([...f.first.document.data], [1]);
    assert.deepEqual([...second.document.data], [1]);
    assert.equal(f.errors.length, 1);
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

test('diff results only forward from the current modified panel and strip extra fields', async t => {
    const f = await fixture(t, async () => new Uint8Array([2]));
    const second = await f.open('modified.pdf');
    const session = pair(f, second);
    session.sessionId = 7;
    const changes = [{ regions: [{ left: 0, top: 0, width: 0.2, height: 0.1, extra: true }], extra: true }];
    const result = { type: 'diff.pageResult', sessionId: 7, pageNumber: 1, originalChanges: changes };
    const range = { type: 'diff.removedPageRange', sessionId: 7, fromPage: 2, toPage: 3 };
    for (const message of [result, range]) {
        f.first.received.fire(message);
        second.received.fire({ ...message, sessionId: 6 });
    }
    assert.deepEqual(f.first.messages, []);
    assert.deepEqual(second.messages, []);

    second.received.fire(result);
    second.received.fire(range);
    assert.deepEqual(f.first.messages, [
        { type: 'diff.applyPage', sessionId: 7, pageNumber: 1,
            changes: [{ regions: [{ left: 0, top: 0, width: 0.2, height: 0.1 }] }] },
        { type: 'diff.setRemovedPageRange', sessionId: 7, fromPage: 2, toPage: 3 },
    ]);
    f.first.messages.length = 0;
    f.first.dispose();
    second.received.fire(result);
    assert.deepEqual(f.first.messages, []);
});
