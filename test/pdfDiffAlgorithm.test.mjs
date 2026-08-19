import assert from 'node:assert/strict';
import test from 'node:test';

import { compareRasters, compareTextTokens } from '../src/webview/pdfDiffAlgorithm.mts';

function raster(width, height, changes = []) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    pixels.fill(255);
    for (const [x, y, color = 0] of changes) {
        const offset = (y * width + x) * 4;
        pixels[offset] = color;
        pixels[offset + 1] = color;
        pixels[offset + 2] = color;
    }
    return { width, height, pixels };
}

function token(text, left) {
    return {
        text,
        left,
        top: 10,
        right: left + 10,
        bottom: 20,
        changedPixels: 1,
    };
}

test('returns no regions for identical raster pages', () => {
    const page = raster(10, 10);
    assert.deepEqual(compareRasters(page, raster(10, 10)), {
        originalRegions: [],
        modifiedRegions: [],
        changedPixels: 0,
        strategy: 'raster',
    });
});

test('ignores isolated raster noise below the region threshold', () => {
    const result = compareRasters(raster(10, 10), raster(10, 10, [[5, 5]]));
    assert.equal(result.changedPixels, 1);
    assert.deepEqual(result.originalRegions, []);
    assert.deepEqual(result.modifiedRegions, []);
    assert.equal(result.strategy, 'raster');
});

test('normalizes and pads a connected changed region', () => {
    const changes = [
        [4, 3], [5, 3],
        [4, 4], [5, 4],
    ];
    assert.deepEqual(compareRasters(raster(10, 10), raster(10, 10, changes)), {
        originalRegions: [{ left: 0.2, top: 0.1, width: 0.6, height: 0.6 }],
        modifiedRegions: [{ left: 0.2, top: 0.1, width: 0.6, height: 0.6 }],
        changedPixels: 4,
        strategy: 'raster',
    });
});

test('falls back to a full-page region for different page dimensions', () => {
    assert.deepEqual(compareRasters(raster(10, 10), raster(12, 10)), {
        originalRegions: [{ left: 0.01, top: 0.01, width: 0.98, height: 0.98 }],
        modifiedRegions: [{ left: 0.01, top: 0.01, width: 0.98, height: 0.98 }],
        changedPixels: -1,
        strategy: 'page',
    });
});

test('marks inserted text only in the modified revision', () => {
    const result = compareTextTokens(
        [token('A', 10), token('C', 50)],
        [token('A', 10), token('B', 30), token('C', 50)],
        100,
        100,
        100,
        100,
    );
    assert.deepEqual(result, {
        originalRegions: [],
        modifiedRegions: [{ left: 0.28, top: 0.08, width: 0.14, height: 0.14 }],
        changedPixels: -1,
        strategy: 'text',
    });
});

test('marks deleted text only in the original revision', () => {
    const result = compareTextTokens(
        [token('A', 10), token('B', 30), token('C', 50)],
        [token('A', 10), token('C', 50)],
        100,
        100,
        100,
        100,
    );
    assert.deepEqual(result, {
        originalRegions: [{ left: 0.28, top: 0.08, width: 0.14, height: 0.14 }],
        modifiedRegions: [],
        changedPixels: -1,
        strategy: 'text',
    });
});

test('marks replacement text in both revisions', () => {
    const result = compareTextTokens(
        [token('A', 10), token('B', 30), token('C', 50)],
        [token('A', 10), token('D', 35), token('C', 50)],
        100,
        100,
        100,
        100,
    );
    assert.deepEqual(result, {
        originalRegions: [{ left: 0.28, top: 0.08, width: 0.14, height: 0.14 }],
        modifiedRegions: [{ left: 0.33, top: 0.08, width: 0.14, height: 0.14 }],
        changedPixels: -1,
        strategy: 'text',
    });
});

test('keeps all-text insertion and deletion on their semantic revision', () => {
    assert.deepEqual(compareTextTokens([], [token('Added', 20)], 100, 100, 100, 100), {
        originalRegions: [],
        modifiedRegions: [{ left: 0.18, top: 0.08, width: 0.14, height: 0.14 }],
        changedPixels: -1,
        strategy: 'text',
    });
    assert.deepEqual(compareTextTokens([token('Removed', 20)], [], 100, 100, 100, 100), {
        originalRegions: [{ left: 0.18, top: 0.08, width: 0.14, height: 0.14 }],
        modifiedRegions: [],
        changedPixels: -1,
        strategy: 'text',
    });
});
