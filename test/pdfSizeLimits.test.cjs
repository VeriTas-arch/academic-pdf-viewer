const assert = require('node:assert/strict');
const test = require('node:test');

const {
    assertPdfDiffPairSize,
    assertPdfSize,
    MAX_PDF_BYTES,
} = require('../src/extension/pdfSizeLimits.ts');

test('accepts the single-PDF and combined diff size boundaries', () => {
    assert.doesNotThrow(() => assertPdfSize(MAX_PDF_BYTES));
    assert.doesNotThrow(() => assertPdfDiffPairSize(MAX_PDF_BYTES, 0));
    assert.doesNotThrow(() => assertPdfDiffPairSize(MAX_PDF_BYTES / 2, MAX_PDF_BYTES / 2));
});

test('rejects invalid, oversized, and over-budget PDF sizes', () => {
    assert.throws(() => assertPdfSize(-1), /invalid file size/);
    assert.throws(() => assertPdfSize(MAX_PDF_BYTES + 1), /512 MiB safety limit/);
    assert.throws(
        () => assertPdfDiffPairSize(MAX_PDF_BYTES / 2 + 1, MAX_PDF_BYTES / 2),
        /512 MiB combined safety limit/,
    );
});
