const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
    querySyncTexForward,
    querySyncTexInverse,
    resolveSourceColumn,
    syncTexTextHint,
} = require('../src/extension/synctexCli.ts');

test('queries forward SyncTeX through the injected runner and converts its line box', async () => {
    const calls = [];
    const sourcePath = path.resolve('manual-tests', 'synctex', 'fixture.tex');
    const pdfPath = path.resolve('manual-tests', 'synctex', 'fixture.pdf');
    const runner = async request => {
        calls.push(request);
        return {
            stdout: [
                'Page:2',
                'x:148.573547',
                'y:672.249023',
                'h:110.854279',
                'v:674.573608',
                'W:388.542938',
                'H:10.626775',
            ].join('\n'),
            stderr: '',
        };
    };

    const result = await querySyncTexForward(runner, 'synctex-custom', sourcePath, pdfPath, 25, 11);

    assert.deepEqual(calls, [{
        executable: 'synctex-custom',
        args: ['view', '-i', `25:11:${sourcePath}`, '-o', pdfPath],
        cwd: path.dirname(sourcePath),
    }]);
    assert.equal(result.pageNumber, 2);
    assert.equal(result.x, 148.573547);
    assert.equal(result.y, 672.249023);
    assert.equal(result.targetBox.x, 110.854279);
    assert(Math.abs(result.targetBox.y - 663.946833) < 1e-9);
    assert.equal(result.targetBox.width, 388.542938);
    assert.equal(result.targetBox.height, 10.626775);
});

test('queries inverse SyncTeX with the validated PDF text hint', async () => {
    const calls = [];
    const pdfPath = path.resolve('manual-tests', 'synctex', 'fixture.pdf');
    const hint = syncTexTextHint('The final target', 10);
    const runner = async request => {
        calls.push(request);
        return {
            stdout: 'Input:fixture.tex\nLine:25\nColumn:-1\n',
            stderr: '',
        };
    };

    const result = await querySyncTexInverse(runner, 'synctex', pdfPath, 2, 148.5, 672.2, hint);

    assert.deepEqual(calls, [{
        executable: 'synctex',
        args: ['edit', '-o', `2:148.5:672.2:${pdfPath}`, '-h', '10:The final target'],
        cwd: path.dirname(pdfPath),
    }]);
    assert.deepEqual(result, { input: 'fixture.tex', line: 25, column: -1 });
    assert.deepEqual(resolveSourceColumn(-1, 'prefix The final target suffix', hint), {
        column: 17,
        method: 'hint',
    });
});

test('uses zero-based SyncTeX columns and falls back for ambiguous text hints', () => {
    assert.deepEqual(resolveSourceColumn(4, 'example', undefined), {
        column: 4,
        method: 'synctex',
    });
    assert.deepEqual(resolveSourceColumn(-1, 'target target', { context: 'target', offset: 3 }), {
        column: undefined,
        method: 'line',
    });
    assert.equal(syncTexTextHint('target', 7), undefined);
});

test('rejects incomplete SyncTeX output', async () => {
    const runner = async () => ({ stdout: 'Page:2\nx:not-a-number\n', stderr: '' });
    await assert.rejects(
        querySyncTexForward(runner, 'synctex', 'source.tex', 'source.pdf', 1, 1),
        /valid x field/,
    );
});
