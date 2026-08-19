import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compareRasters,
    compareTextTokenChanges,
    compareTextTokens,
    findNextDiffPage,
    mergeTextAndRasterResults,
    nextDiffRegionIndex,
} from '../src/webview/pdfDiffAlgorithm.mts';

function geometryResult(result) {
    if (!result) {
        return result;
    }
    const { changes: _changes, ...geometry } = result;
    return geometry;
}

test('preserves semantic text change groups and stable page-local ids', () => {
    const changes = compareTextTokenChanges(
        [token('A', 0), token('old-1', 20), token('B', 50), token('old-2', 70), token('C', 100)],
        [token('A', 0), token('new-1', 20), token('B', 50), token('new-2', 70), token('C', 100)],
    );

    assert(changes);
    assert.deepEqual(changes.map(change => ({
        id: change.id,
        kind: change.kind,
        original: change.original?.regions.map(region => region.text),
        modified: change.modified?.regions.map(region => region.text),
        strategy: change.strategy,
    })), [
        { id: 'text-1', kind: 'replace', original: ['old-1'], modified: ['new-1'], strategy: 'text' },
        { id: 'text-2', kind: 'replace', original: ['old-2'], modified: ['new-2'], strategy: 'text' },
    ]);
});

test('keeps unrelated deletion and insertion in separate change groups', () => {
    const changes = compareTextTokenChanges(
        [token('A', 0), token('removed', 20), token('B', 50), token('C', 100)],
        [token('A', 0), token('B', 50), token('added', 70), token('C', 100)],
    );

    assert(changes);
    assert.deepEqual(changes.map(change => ({ id: change.id, kind: change.kind })), [
        { id: 'text-1', kind: 'delete' },
        { id: 'text-2', kind: 'insert' },
    ]);
});

test('finds matches with large common prefix and suffix', () => {
    const changes = compareTextTokenChanges(
        [
            token('left', 10),
            token('kept-1', 20),
            token('old', 30),
            token('kept-2', 40),
            token('tail', 50),
        ],
        [
            token('left', 10),
            token('kept-1', 20),
            token('new', 35),
            token('kept-2', 40),
            token('tail', 50),
        ],
    );

    assert(changes);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, 'replace');
    assert.deepEqual(changes[0].original?.regions.map(region => region.text), ['old']);
    assert.deepEqual(changes[0].modified?.regions.map(region => region.text), ['new']);
});

test('retains behavior with long mostly unchanged front and back', () => {
    const original = Array.from({ length: 80 }, (_, index) => token(`body-${index}`, index));
    const modified = [...original.slice(0, 40), token('changed', 400), ...original.slice(41)];

    const changes = compareTextTokenChanges(original, modified);

    assert(changes);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].kind, 'replace');
    assert.deepEqual(changes[0].original?.regions.map(region => region.text), ['body-40']);
    assert.deepEqual(changes[0].modified?.regions.map(region => region.text), ['changed']);
});

test('does not synchronize heights across unrelated deletion and insertion', () => {
    const result = compareTextTokens(
        [token('A', 0), token('removed', 20, 10, 20), token('B', 50), token('C', 100)],
        [token('A', 0), token('B', 50), token('added', 70, 8, 22), token('C', 100)],
        150,
        100,
        150,
        100,
    );

    assert(result);
    assert.equal(result.originalRegions[0].height, 0.14);
    assert.equal(result.modifiedRegions[0].height, 0.18);
});

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
    assert.deepEqual(geometryResult(compareRasters(page, raster(10, 10))), {
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
    assert.deepEqual(geometryResult(compareRasters(raster(10, 10), raster(10, 10, changes))), {
        originalRegions: [{ left: 0.2, top: 0.1, width: 0.6, height: 0.6 }],
        modifiedRegions: [{ left: 0.2, top: 0.1, width: 0.6, height: 0.6 }],
        changedPixels: 4,
        strategy: 'raster',
    });
});

test('falls back to a full-page region for different page dimensions', () => {
    assert.deepEqual(geometryResult(compareRasters(raster(10, 10), raster(12, 10))), {
        originalRegions: [{ left: 0.01, top: 0.01, width: 0.98, height: 0.98 }],
        modifiedRegions: [{ left: 0.01, top: 0.01, width: 0.98, height: 0.98 }],
        changedPixels: -1,
        strategy: 'page',
    });
});

test('keeps semantic text changes and adds uncovered visual changes', () => {
    const textResult = compareTextTokens(
        [token('A', 10), token('old', 30), token('C', 50)],
        [token('A', 10), token('new', 30), token('C', 50)],
        100,
        100,
        100,
        100,
    );
    assert(textResult);
    const coveredTextRegion = { left: 0.29, top: 0.09, width: 0.12, height: 0.12 };
    const uncoveredVisualRegion = { left: 0.7, top: 0.65, width: 0.2, height: 0.2 };
    const rasterResult = {
        changes: [coveredTextRegion, uncoveredVisualRegion].map((region, index) => ({
            id: `raster-${index + 1}`,
            kind: 'replace',
            originalRegions: [region],
            modifiedRegions: [region],
            strategy: 'raster',
        })),
        originalRegions: [coveredTextRegion, uncoveredVisualRegion],
        modifiedRegions: [coveredTextRegion, uncoveredVisualRegion],
        changedPixels: 400,
        strategy: 'raster',
    };

    const result = mergeTextAndRasterResults(textResult, rasterResult);

    assert.equal(result.changes.length, textResult.changes.length + 1);
    assert.deepEqual(result.changes.at(-1), rasterResult.changes[1]);
    assert.deepEqual(result.originalRegions.at(-1), uncoveredVisualRegion);
    assert.deepEqual(result.modifiedRegions.at(-1), uncoveredVisualRegion);
    assert.equal(result.changedPixels, 400);
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
    assert.deepEqual(geometryResult(result), {
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
    assert.deepEqual(geometryResult(result), {
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
    assert.deepEqual(geometryResult(result), {
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
    assert.deepEqual(geometryResult(compareTextTokens([], [token('Added', 20)], 100, 100, 100, 100)), {
        originalRegions: [],
        modifiedRegions: [{ left: 0.18, top: 0.08, width: 0.14, height: 0.14 }],
        changedPixels: -1,
        strategy: 'text',
    });
    assert.deepEqual(geometryResult(compareTextTokens([token('Removed', 20)], [], 100, 100, 100, 100)), {
        originalRegions: [{ left: 0.18, top: 0.08, width: 0.14, height: 0.14 }],
        modifiedRegions: [],
        changedPixels: -1,
        strategy: 'text',
    });
});
