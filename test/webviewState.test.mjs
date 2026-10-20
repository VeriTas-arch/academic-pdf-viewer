import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

import { PageComparisonScheduler } from '../src/webview/pdfDiffScheduler.mts';

// Expose closure-local operations only in this test sandbox; browser startup stays inactive.
function loadWebview(file, names, configuration = null) {
    const source = readFileSync(new URL(`../assets/academic/${file}.js`, import.meta.url), 'utf8');
    const context = {
        window: { academicPdfJsAdapter: { getApplication: () => null }, addEventListener() {} },
        configurationReads: 0,
        document: { addEventListener() {}, getElementById: () => ({ getAttribute: () => {
            context.configurationReads++;
            return configuration;
        } }) },
        acquireVsCodeApi: () => ({ postMessage() {} }),
        PageComparisonScheduler,
    };
    assert(/\}\(\)\);\s*$/.test(source));
    const instrumented = source.replace(/^import .*;\r?\n/gm, '').replace(
        /\}\(\)\);\s*$/,
        `Object.assign(globalThis, { ${names.join(', ')} }); }());`,
    );
    runInNewContext(instrumented, context);
    return context;
}

test('preview requests share cached work and retry after failure without deleting newer work', async () => {
    const { getCachedPromise } = loadWebview('citationPreview', ['getCachedPromise']);
    const cache = new Map();
    let calls = 0;
    let rejectOld;
    const load = () => {
        calls++;
        return new Promise((resolve, reject) => { rejectOld = reject; });
    };
    const first = getCachedPromise(cache, 1, load);
    assert.equal(getCachedPromise(cache, 1, load), first);
    assert.equal(calls, 1);
    rejectOld(new Error('failed page request'));
    await assert.rejects(first, /failed page request/);
    assert.equal(cache.has(1), false);

    const stale = getCachedPromise(cache, 1, load);
    cache.clear(); // A new document replaces the cached requests.
    const current = getCachedPromise(cache, 1, () => Promise.resolve('new document'));
    rejectOld(new Error('late failure'));
    await assert.rejects(stale, /late failure/);
    assert.equal(cache.get(1), current);
    assert.equal(await current, 'new document');
});

test('preview cache remains bounded and refreshes recently used requests', () => {
    const { getCachedPromise } = loadWebview('citationPreview', ['getCachedPromise']);
    const cache = new Map();
    for (let page = 1; page <= 64; page++) {
        getCachedPromise(cache, page, () => Promise.resolve(page));
    }
    getCachedPromise(cache, 1, () => assert.fail('cached page must be reused'));
    getCachedPromise(cache, 65, () => Promise.resolve(65));
    assert.equal(cache.size, 64);
    assert.equal(cache.has(1), true);
    assert.equal(cache.has(2), false);
});

test('diff cache replaces and evicts both sides together while supporting original-only results', () => {
    const { rememberPageResult, changesForPage, cachedComparison, resetPageResults } = loadWebview(
        'pdfDiff', ['rememberPageResult', 'changesForPage', 'cachedComparison', 'resetPageResults'],
    );
    const modified = [{ regions: [{ left: 0, top: 0, width: 0.2, height: 0.1 }] }];
    const original = [{ regions: [{ left: 0.5, top: 0, width: 0.2, height: 0.1 }] }];
    rememberPageResult(1, modified, original);
    assert.equal(changesForPage(1), modified);
    assert.equal(cachedComparison(1).originalChanges, original);
    assert.equal(cachedComparison(1).modifiedChanges, modified);
    // Empty changes are a cached comparison, not a cache miss.
    rememberPageResult(1, [], []);
    assert.equal(cachedComparison(1).originalChanges.length, 0);
    for (let page = 2; page <= 64; page++) {
        rememberPageResult(page, modified, original);
    }
    rememberPageResult(1, modified, original);
    rememberPageResult(65, modified, original);
    assert(cachedComparison(1));
    assert.equal(changesForPage(2), undefined);
    assert.equal(cachedComparison(2), undefined);

    rememberPageResult(1, original);
    assert.equal(changesForPage(1), original);
    assert.equal(cachedComparison(1), undefined);
    resetPageResults();
    assert.equal(changesForPage(1), undefined);
    assert.equal(cachedComparison(65), undefined);
});

test('reader parses initial settings once and retains defaults for invalid settings', () => {
    for (const configuration of [null, '{', 'null', '{}']) {
        const { initialConfiguration, configurationReads } = loadWebview('reader', ['initialConfiguration'], configuration);
        assert.equal(configurationReads, 1);
        assert.deepEqual({ ...initialConfiguration }, {
            mouseNavigationEnabled: true, mouseButtonMapping: 'standard', syncTexMode: 'doubleclick',
        });
    }
    const configuration = JSON.stringify({
        mouseNavigationEnabled: false, mouseButtonMapping: 'swapped', syncTexMode: 'off',
    });
    const { initialConfiguration, configurationReads } = loadWebview('reader', ['initialConfiguration'], configuration);
    assert.equal(configurationReads, 1);
    assert.deepEqual({ ...initialConfiguration }, JSON.parse(configuration));
});

test('SyncTeX pointer lookup only reads the clicked page in a long document', () => {
    const context = loadWebview('reader', ['getSyncTexPointer']);
    class Element {
        dataset = {};
        closest() { return null; }
        setAttribute() {}
        getBoundingClientRect() { return { left: 10, top: 20 }; }
        clientLeft = 1;
        clientTop = 2;
        clientWidth = 200;
        clientHeight = 300;
    }
    context.Element = context.HTMLElement = Element;
    context.document.elementsFromPoint = () => [];
    const page = new Element();
    page.dataset.pageNumber = '10000';
    const child = new Element();
    const pageView = {
        id: 10000,
        div: page,
        viewport: {
            convertToPdfPoint: (x, y) => [x + 10, 320 - y],
            viewBox: [10, 20, 210, 320],
            userUnit: 2,
        },
    };
    const reads = [];
    context.window.academicPdfJsAdapter.getViewer = () => ({
        pagesCount: 10000,
        getPageView(index) { reads.push(index); return index === 9999 ? pageView : undefined; },
    });
    const event = {
        target: child,
        clientX: 61,
        clientY: 92,
        composedPath: () => [child, page, context.document, context.window],
    };
    assert.deepEqual({ ...context.getSyncTexPointer(event) }, { pageNumber: 10000, x: 100, y: 140 });
    assert.deepEqual(reads, [9999]);

    // A page number on an unrelated element must not be treated as a PDF page.
    const impostor = new Element();
    impostor.dataset.pageNumber = '10000';
    assert.equal(context.getSyncTexPointer({ ...event, composedPath: () => [impostor] }), undefined);
    assert.equal(context.getSyncTexPointer({ ...event, clientX: 5 }), undefined);
    child.closest = () => page;
    reads.length = 0;
    assert.equal(context.getSyncTexPointer(event), undefined);
    assert.deepEqual(reads, []);
});
