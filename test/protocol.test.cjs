const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE,
    isWebviewToExtensionMessage,
    normalizeLinkPreviewResolutionScale,
    sanitizePdfDiffChanges,
} = require('../src/shared/protocol.ts');

function diffChange(regions = [{ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }]) {
    return { regions };
}

test('accepts supported webview messages', () => {
    assert.equal(isWebviewToExtensionMessage({ type: 'webview.ready' }), true);
    assert.equal(isWebviewToExtensionMessage({ type: 'workbench.openFile' }), true);
    assert.equal(isWebviewToExtensionMessage({ type: 'workbench.quickOpen' }), true);
    assert.equal(isWebviewToExtensionMessage({ type: 'workbench.showCommands' }), true);
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
