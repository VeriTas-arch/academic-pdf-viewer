const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');

const { PDF_RANGE_FRAME_BYTES, isSyncTexForwardRequest, isWebviewToExtensionMessage } = require('../src/shared/protocol.ts');
const sandbox = { window: {}, ArrayBuffer };
runInNewContext(readFileSync(join(__dirname, '../assets/academic/extensionMessages.js'), 'utf8'), sandbox);
const { isMessage: isExtensionToWebviewMessage } = sandbox.window.academicExtensionMessages;

test('PDF ranges require a valid load, bounds, and binary response', () => {
    const request = { type: 'document.rangeRequest', loadId: 1, requestId: 1, begin: 0, length: PDF_RANGE_FRAME_BYTES };
    assert(isWebviewToExtensionMessage(request));
    assert(!isWebviewToExtensionMessage({ ...request, begin: -1 }));
    assert(!isWebviewToExtensionMessage({ ...request, length: PDF_RANGE_FRAME_BYTES + 1 }));
    const response = { type: 'document.rangeData', loadId: request.loadId, requestId: request.requestId, data: new ArrayBuffer(request.length) };
    assert(isExtensionToWebviewMessage(response));
    assert(!isExtensionToWebviewMessage({ ...response, loadId: 0 }));
    assert(!isExtensionToWebviewMessage({ ...response, data: 'not binary' }));
});

test('both message boundaries reject malformed or oversized diff regions', () => {
    const region = { left: 0, top: 0, width: 0.5, height: 0.5 };
    const valid = [{ regions: [region] }];
    const hostAccepts = originalChanges => isWebviewToExtensionMessage({
        type: 'diff.pageResult', sessionId: 1, pageNumber: 1, originalChanges,
    });
    const viewerAccepts = changes => isExtensionToWebviewMessage({
        type: 'diff.applyPage', sessionId: 1, pageNumber: 1, changes,
    });
    for (const accepts of [hostAccepts, viewerAccepts]) {
        assert(accepts(valid));
        assert(!accepts([{ regions: [{ ...region, left: 0.9 }] }]));
        assert(!accepts([{ regions: Array(1) }]));
        assert(!accepts([{ regions: Array(201).fill(region) }]));
    }
});

test('public SyncTeX requests require a page, finite coordinates, and a usable optional box', () => {
    const request = { type: 'synctex.forward', pdfUri: 'file:///paper.pdf', pageNumber: 1, x: 20, y: 40 };
    const targetBox = { x: request.x, y: request.y, width: 60, height: 12 };
    assert(isSyncTexForwardRequest(request));
    assert(isSyncTexForwardRequest({ ...request, targetBox }));
    assert(!isSyncTexForwardRequest({ ...request, pageNumber: 0 }));
    assert(!isSyncTexForwardRequest({ ...request, x: Infinity }));
    assert(!isSyncTexForwardRequest({ ...request, targetBox: { ...targetBox, width: 0 } }));
});
