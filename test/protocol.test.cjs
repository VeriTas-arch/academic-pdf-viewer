const assert = require('node:assert/strict');
const test = require('node:test');

const {
    DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE,
    isWebviewToExtensionMessage,
    normalizeLinkPreviewResolutionScale,
} = require('../src/shared/protocol.ts');

test('accepts supported webview messages', () => {
    assert.equal(isWebviewToExtensionMessage({ type: 'webview.ready' }), true);
    assert.equal(isWebviewToExtensionMessage({ type: 'workbench.showCommands' }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'navigation.keyUp',
        direction: 'back',
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.pageResult',
        pageNumber: 2,
        originalRegions: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.4 }],
    }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.removedPageRange',
        fromPage: 3,
        toPage: 5,
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
        pageNumber: 0,
        originalRegions: [],
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.pageResult',
        pageNumber: 1,
        originalRegions: [{ left: 0.8, top: 0, width: 0.3, height: 0.1 }],
    }), false);
    assert.equal(isWebviewToExtensionMessage({
        type: 'diff.removedPageRange',
        fromPage: 5,
        toPage: 3,
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
