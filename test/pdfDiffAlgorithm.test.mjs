import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compareRasters,
    compareTextTokens,
    findNextDiffPage,
    nextDiffRegionIndex,
} from '../src/webview/pdfDiffAlgorithm.mts';

test('selects diff regions without wrapping at page boundaries', () => {
    assert.equal(nextDiffRegionIndex(3, undefined, 'next'), 0);
    assert.equal(nextDiffRegionIndex(3, undefined, 'previous'), 2);
    assert.equal(nextDiffRegionIndex(3, 0, 'next'), 1);
    assert.equal(nextDiffRegionIndex(3, 2, 'next'), undefined);
    assert.equal(nextDiffRegionIndex(3, 2, 'previous'), 1);
    assert.equal(nextDiffRegionIndex(3, 0, 'previous'), undefined);
    assert.equal(nextDiffRegionIndex(0, undefined, 'next'), undefined);
});

test('scans diff pages on demand and stops at the first change', async () => {
    const visited = [];
    const pages = new Map([
        [1, []],
        [2, []],
        [3, ['first', 'second']],
        [4, ['later']],
    ]);
    const target = await findNextDiffPage(1, 4, 'next', async pageNumber => {
        visited.push(pageNumber);
        return pages.get(pageNumber);
    });
    assert.deepEqual(visited, [1, 2, 3]);
    assert.deepEqual(target, {
        pageNumber: 3,
        index: 0,
        regions: ['first', 'second'],
    });
});

test('scans backward without wrapping and preserves cancellation', async () => {
    const visited = [];
    const target = await findNextDiffPage(4, 4, 'previous', async pageNumber => {
        visited.push(pageNumber);
        if (pageNumber === 3) {
            return undefined;
        }
        return [];
    });
    assert.deepEqual(visited, [4, 3]);
    assert.equal(target, undefined);

    let called = false;
    assert.equal(await findNextDiffPage(5, 4, 'next', async () => {
        called = true;
        return [];
    }), undefined);
    assert.equal(called, false);
});

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

function token(text, left, top = 10, bottom = 20) {
    return {
        text,
        left,
        top,
        right: left + 10,
        bottom,
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

test('uses consistent heights for changed regions on the same text line', () => {
    const result = compareTextTokens(
        [
            token('A', 0), token('old-1', 20), token('B', 50), token('old-2', 70),
            token('C', 100), token('old-3', 120), token('D', 150),
        ],
        [
            token('A', 0), token('new-1', 20, 8, 20), token('B', 50),
            token('new-2', 70, 10, 22), token('C', 100),
            token('new-3', 120, 9, 21), token('D', 150),
        ],
        200,
        100,
        200,
        100,
    );

    assert(result);
    assert.equal(result.modifiedRegions.length, 3);
    assert.deepEqual(result.modifiedRegions.map(region => region.top), [0.06, 0.06, 0.06]);
    assert.deepEqual(result.modifiedRegions.map(region => region.height), [0.18, 0.18, 0.18]);
});

test('uses consistent heights across paired replacement regions', () => {
    const result = compareTextTokens(
        [token('A', 0), token('Needs-review', 20, 10, 20), token('B', 50)],
        [token('A', 0), token('Approved', 20, 8, 22), token('B', 50)],
        100,
        100,
        100,
        100,
    );

    assert(result);
    assert.equal(result.originalRegions.length, 1);
    assert.equal(result.modifiedRegions.length, 1);
    assert.equal(result.originalRegions[0].height, result.modifiedRegions[0].height);
});

test('preserves materially different replacement heights', () => {
    const result = compareTextTokens(
        [token('A', 0), token('body', 20, 10, 20), token('B', 50)],
        [token('A', 0), token('heading', 20, 0, 30), token('B', 50)],
        100,
        100,
        100,
        100,
    );

    assert(result);
    assert.equal(result.originalRegions[0].height, 0.14);
    assert.equal(result.modifiedRegions[0].height, 0.32);
});

test('preserves replacement heights across different text lines', () => {
    const result = compareTextTokens(
        [token('A', 0), token('upper', 20, 10, 20), token('B', 50)],
        [token('A', 0), token('lower', 20, 40, 54), token('B', 50)],
        100,
        100,
        100,
        100,
    );

    assert(result);
    assert.equal(result.originalRegions[0].height, 0.14);
    assert.equal(result.modifiedRegions[0].height, 0.18);
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
