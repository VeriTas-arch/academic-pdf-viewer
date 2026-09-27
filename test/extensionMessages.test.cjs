const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
    path.resolve(__dirname, '..', 'assets', 'academic', 'extensionMessages.js'),
    'utf8',
);
const sandbox = { ArrayBuffer, window: {} };
vm.runInNewContext(source, sandbox, { filename: 'extensionMessages.js' });
const { isMessage } = sandbox.window.academicExtensionMessages;

const change = { regions: [{ left: 0.1, top: 0.2, width: 0.3, height: 0.1 }] };

test('accepts supported extension-to-webview messages', () => {
    for (const message of [
        { type: 'navigation.back' },
        { type: 'navigation.forward' },
        { type: 'navigation.configure', mouseButtonsEnabled: true, mouseButtonMapping: 'standard' },
        { type: 'sidebar.configure', defaultSidebar: 'outline' },
        { type: 'synctex.configure', mode: 'doubleclick' },
        {
            type: 'synctex.forward',
            requestId: '1',
            loadId: 1,
            pageNumber: 2,
            x: 72,
            y: 144,
            targetBox: { x: 60, y: 132, width: 240, height: 12 },
        },
        { type: 'synctex.forwardCancel', requestId: '1', loadId: 1 },
        {
            type: 'document.load',
            loadId: 1,
            data: new ArrayBuffer(1),
            isEmptyRevision: false,
            fingerprint: 'file:///paper.pdf',
            preserveView: true,
        },
        { type: 'diff.setEnabled', enabled: false, sessionId: 1 },
        { type: 'diff.setEnabled', enabled: true, sessionId: 1, role: 'original', allPagesChanged: false },
        {
            type: 'diff.setEnabled',
            enabled: true,
            sessionId: 1,
            role: 'modified',
            modifiedIsEmptyRevision: true,
        },
        {
            type: 'diff.setEnabled',
            enabled: true,
            sessionId: 1,
            role: 'modified',
            originalData: new ArrayBuffer(1),
            originalFingerprint: 'git:/paper.pdf',
            originalIsEmptyRevision: false,
            modifiedIsEmptyRevision: false,
        },
        { type: 'diff.applyPage', sessionId: 1, pageNumber: 1, changes: [change] },
        { type: 'diff.setRemovedPageRange', sessionId: 1, fromPage: 2, toPage: 4 },
        { type: 'diff.applyScroll', pageNumber: 1, pageRatio: 0.25, documentRatio: 0.5 },
        { type: 'diff.navigate', sessionId: 1, direction: 'next' },
        {
            type: 'diff.scanForChange',
            sessionId: 1,
            requestId: 2,
            role: 'modified',
            direction: 'previous',
            startPage: 3,
        },
        {
            type: 'diff.revealChange',
            sessionId: 1,
            requestId: 2,
            pageNumber: 3,
            index: 0,
            changes: [change],
        },
        { type: 'linkPreview.configure', enabled: true, resolutionScale: 2 },
    ]) {
        assert.equal(isMessage(message), true, message.type);
    }
});

test('rejects malformed and unsupported extension-to-webview messages', () => {
    for (const message of [
        null,
        {},
        { type: 'unknown' },
        { type: 'navigation.configure', mouseButtonsEnabled: true, mouseButtonMapping: 'invalid' },
        { type: 'sidebar.configure', defaultSidebar: 'bookmarks' },
        { type: 'synctex.configure', mode: 'click' },
        { type: 'synctex.forward', requestId: '1', loadId: 0, pageNumber: 1, x: 0, y: 0 },
        {
            type: 'synctex.forward',
            requestId: '1',
            loadId: 1,
            pageNumber: 1,
            x: 0,
            y: 0,
            targetBox: { x: 0, y: 0, width: 0, height: 1 },
        },
        {
            type: 'document.load',
            loadId: 1,
            data: new ArrayBuffer(0),
            isEmptyRevision: false,
            fingerprint: 'file:///paper.pdf',
            preserveView: false,
        },
        {
            type: 'diff.setEnabled',
            enabled: true,
            sessionId: 1,
            role: 'modified',
            modifiedIsEmptyRevision: false,
        },
        {
            type: 'diff.applyPage',
            sessionId: 1,
            pageNumber: 1,
            changes: [{ regions: [{ left: 0.9, top: 0, width: 0.2, height: 0.1 }] }],
        },
        {
            type: 'diff.revealChange',
            sessionId: 1,
            requestId: 1,
            pageNumber: 1,
            index: 1,
            changes: [change],
        },
        { type: 'linkPreview.configure', enabled: true, resolutionScale: Number.NaN },
    ]) {
        assert.equal(isMessage(message), false, message?.type);
    }
});
