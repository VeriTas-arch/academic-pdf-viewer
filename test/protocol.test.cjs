const assert = require('node:assert/strict');
const test = require('node:test');

const { isWebviewToExtensionMessage } = require('../src/shared/protocol.ts');

test('accepts supported webview messages', () => {
    assert.equal(isWebviewToExtensionMessage({ type: 'webview.ready' }), true);
    assert.equal(isWebviewToExtensionMessage({ type: 'workbench.showCommands' }), true);
    assert.equal(isWebviewToExtensionMessage({
        type: 'navigation.keyUp',
        direction: 'back',
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
});
