const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE,
    isSyncTexForwardRequest,
    isWebviewToExtensionMessage,
    normalizeLinkPreviewResolutionScale,
    sanitizePdfDiffChanges,
} = require('../src/shared/protocol.ts');
const packageJson = require('../package.json');

function diffChange(regions = [{ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }]) {
    return { regions };
}

test('accepts supported webview messages', () => {
    assert.equal(isWebviewToExtensionMessage({ type: 'webview.ready' }), true);
    assert.equal(isWebviewToExtensionMessage({ type: 'workbench.openFile' }), true);
    assert.equal(isWebviewToExtensionMessage({ type: 'workbench.quickOpen' }), true);
    assert.equal(isWebviewToExtensionMessage({ type: 'workbench.showCommands' }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.inverse',
        pageNumber: 2,
        x: 144,
        y: 216,
        trigger: 'doubleClick',
        context: 'Forward and inverse synchronization',
        offset: 12,
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.inverse',
        pageNumber: 1,
        x: 0,
        y: 0,
        trigger: 'rightClick',
    }), true);
    assert.equal(isWebviewToExtensionMessage({ type: 'synctex.inverseClear' }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.forwardResult',
        requestId: 'synctex-1',
        loadId: 3,
        status: 'applied',
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.forwardResult',
        requestId: 'synctex-2',
        loadId: 3,
        status: 'rejected',
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'navigation.request',
        direction: 'forward',
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'navigation.keyUp',
        direction: 'back',
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.pageResult',
        sessionId: 3,
        pageNumber: 2,
        originalChanges: [diffChange()],
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.removedPageRange',
        sessionId: 3,
        fromPage: 3,
        toPage: 5,
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.navigationRequest',
        sessionId: 3,
        requestId: 1,
        role: 'original',
        direction: 'next',
        startPage: 4,
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.navigationResult',
        sessionId: 3,
        requestId: 1,
        role: 'original',
        pageNumber: 4,
        index: 0,
        changes: [diffChange()],
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.scroll',
        pageNumber: 2,
        pageRatio: 0.45,
        documentRatio: 0.4,
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'pdf.debug',
        event: 'windowError',
        error: 'Example error',
        source: 'viewer.mjs',
        line: 12,
        column: 4,
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'pdf.debug',
        event: 'linkPreviewRendered',
        pageNumber: 4,
        durationMs: 32,
        sizeBytes: 4_000_000,
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'pdf.debug',
        event: 'linkPreviewEncoded',
        pageNumber: 4,
        durationMs: 180,
        sizeBytes: 120_000,
    }), true);
});

test('rejects malformed and unsupported webview messages', () => {
    assert.equal(isWebviewToExtensionMessage(null), false);
    assert.equal(isWebviewToExtensionMessage({ type: 'unknown' }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'navigation.request',
        direction: 'sideways',
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'navigation.keyUp',
        direction: 'sideways',
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'pdf.debug',
        event: 'invented',
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'pdf.debug',
        event: 'opened',
        durationMs: Number.NaN,
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'pdf.debug',
        event: 'failed',
        error: 'x'.repeat(8 * 1024 + 1),
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.pageResult',
        sessionId: 1,
        pageNumber: 0,
        originalChanges: [],
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.pageResult',
        sessionId: 1,
        pageNumber: 1,
        originalChanges: [diffChange([{ left: 0.8, top: 0, width: 0.3, height: 0.1 }])],
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.pageResult',
        sessionId: 0,
        pageNumber: 1,
        originalChanges: [],
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.removedPageRange',
        sessionId: 1,
        fromPage: 5,
        toPage: 3,
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.navigationRequest',
        sessionId: 1,
        requestId: 1,
        role: 'original',
        direction: 'next',
        startPage: 0,
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.navigationResult',
        sessionId: 1,
        requestId: 1,
        role: 'modified',
        pageNumber: 2,
        index: 1,
        changes: [diffChange()],
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.scroll',
        pageNumber: 2,
        pageRatio: 1.1,
        documentRatio: 0.4,
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.scroll',
        pageNumber: 0,
        pageRatio: 0.5,
        documentRatio: 0.4,
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.scroll',
        pageNumber: 2,
        pageRatio: 0.5,
        documentRatio: Number.NaN,
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.inverse',
        pageNumber: 0,
        x: 0,
        y: 0,
        trigger: 'doubleClick',
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.inverse',
        pageNumber: 1,
        x: Number.POSITIVE_INFINITY,
        y: 0,
        trigger: 'doubleClick',
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.inverse',
        pageNumber: 1,
        x: 0,
        y: 0,
        trigger: 'middleClick',
    }), false);
    for (const invalidHint of [
        { context: 'text without offset' },
        { offset: 2 },
        { context: '', offset: 0 },
        { context: 'short', offset: -1 },
        { context: 'short', offset: 6 },
        { context: 'short', offset: 1.5 },
        { context: 'two\nlines', offset: 2 },
        { context: 'nul\0byte', offset: 2 },
        { context: 'x'.repeat(257), offset: 1 },
    ]) {
        assert.equal(isWebviewToExtensionMessage({
            type: 'synctex.inverse',
            pageNumber: 1,
            x: 0,
            y: 0,
            trigger: 'doubleClick',
            ...invalidHint,
        }), false);
    }
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.forward',
        pageNumber: 1,
        x: 0,
        y: 0,
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.forwardResult',
        requestId: '',
        loadId: 1,
        status: 'applied',
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.forwardResult',
        requestId: 'synctex-1',
        loadId: 0,
        status: 'applied',
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'synctex.forwardResult',
        requestId: 'synctex-1',
        loadId: 1,
        status: 'queued',
    }), false);
});

test('validates the public SyncTeX forward request contract', () => {
    const request = {
        type: 'synctex.forward',
        pdfUri: 'file:///workspace/paper.pdf',
        pageNumber: 2,
        x: 144,
        y: 216,
    };
    assert.equal(isSyncTexForwardRequest(request), true);
    assert.equal(isSyncTexForwardRequest({
        ...request,
        targetBox: { x: 100, y: 200, width: 300, height: 12 },
    }), true);
    assert.equal(isSyncTexForwardRequest({ ...request, type: 'synctex.inverse' }), false);
    assert.equal(isSyncTexForwardRequest({ ...request, pdfUri: '' }), false);
    assert.equal(isSyncTexForwardRequest({ ...request, pageNumber: 0 }), false);
    assert.equal(isSyncTexForwardRequest({ ...request, pageNumber: 1.5 }), false);
    assert.equal(isSyncTexForwardRequest({ ...request, x: Number.NaN }), false);
    assert.equal(isSyncTexForwardRequest({ ...request, y: Number.POSITIVE_INFINITY }), false);
    for (const targetBox of [
        null,
        { x: 0, y: 0, width: 0, height: 10 },
        { x: 0, y: 0, width: 10, height: -1 },
        { x: Number.NaN, y: 0, width: 10, height: 10 },
        { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
    ]) {
        assert.equal(isSyncTexForwardRequest({ ...request, targetBox }), false);
    }
});

test('keeps SyncTeX integration commands out of the palette and scopes the context action', () => {
    const contextMenu = packageJson.contributes.menus['webview/context']
        .find(item => item.command === 'academicPdfViewer.tex.synctexInverse');
    assert(contextMenu, 'The inverse SyncTeX webview context action was not contributed.');
    assert.match(contextMenu.when, /webviewId == academicPdfViewer\.pdf/);
    assert.match(contextMenu.when, /webviewSection == pdfPage/);
    assert.match(contextMenu.when, /config\.academicPdfViewer\.tex\.synctex == rightclick/);

    const paletteItems = packageJson.contributes.menus.commandPalette;
    for (const command of [
        'academicPdfViewer.tex.synctexForward',
        'academicPdfViewer.tex.synctexInverse',
    ]) {
        const item = paletteItems.find(candidate => candidate.command === command);
        assert(item, `The command ${command} did not declare its Command Palette visibility.`);
        assert.equal(item.when, 'false');
    }
});

test('normalizes link preview resolution scale', () => {
    assert.equal(normalizeLinkPreviewResolutionScale(undefined), DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE);
    assert.equal(normalizeLinkPreviewResolutionScale(Number.NaN), DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE);
    assert.equal(normalizeLinkPreviewResolutionScale(0.5), 1);
    assert.equal(normalizeLinkPreviewResolutionScale(2.5), 2.5);
    assert.equal(normalizeLinkPreviewResolutionScale(8), 4);
});

test('sanitizes validated PDF diff changes before forwarding', () => {
    const changes = [{
        id: 'legacy-id',
        kind: 'replace',
        strategy: 'text',
        ignored: { nested: true },
        regions: [{
            left: 0.1,
            top: 0.2,
            width: 0.3,
            height: 0.4,
            ignored: 'region metadata',
        }],
    }];
    const message = {
        type: 'diff.pageResult',
        sessionId: 1,
        pageNumber: 1,
        originalChanges: changes,
    };

    assert.equal(isWebviewToExtensionMessage(message), true);
    assert.deepEqual(sanitizePdfDiffChanges(message.originalChanges), [{
        regions: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }],
    }]);
});
