import assert from 'node:assert/strict';
import test from 'node:test';

import { PageComparisonScheduler } from '../src/webview/pdfDiffScheduler.mts';

test('bounds queued and active page comparisons', () => {
    const scheduler = new PageComparisonScheduler(2, 3);
    scheduler.enqueue(1);
    scheduler.enqueue(2);
    scheduler.enqueue(3);
    scheduler.enqueue(4);

    assert.equal(scheduler.queuedCount, 3);
    assert.deepEqual(scheduler.startNext(), { pageNumber: 2, generation: 0 });
    assert.deepEqual(scheduler.startNext(), { pageNumber: 3, generation: 0 });
    assert.equal(scheduler.startNext(), undefined);
    assert.equal(scheduler.activeCount, 2);

    scheduler.complete();
    assert.deepEqual(scheduler.startNext(), { pageNumber: 4, generation: 0 });
});

test('invalidates queued work while retaining active capacity accounting', () => {
    const scheduler = new PageComparisonScheduler(2, 3);
    scheduler.enqueue(1);
    const active = scheduler.startNext();
    assert(active);
    scheduler.enqueue(2);

    scheduler.invalidate();
    assert.equal(scheduler.queuedCount, 0);
    assert.equal(scheduler.activeCount, 1);
    assert.equal(scheduler.isCurrent(active.generation), false);

    assert.deepEqual(scheduler.startImmediately(3), { pageNumber: 3, generation: 1 });
    assert.equal(scheduler.startImmediately(4), undefined);
    scheduler.complete();
    scheduler.complete();
    assert.equal(scheduler.activeCount, 0);
});
