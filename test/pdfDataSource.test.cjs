const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const test = require('node:test');
const { loadSource, CancellationError, CancellationTokenSource } = require('./helpers/extensionSource.cjs');

const vscode = {
    workspace: { getConfiguration: () => ({ get: () => undefined }) },
    CancellationError,
};
function fixture(t) {
    const temporaryBase = fs.realpathSync(os.tmpdir());
    const root = fs.mkdtempSync(path.join(temporaryBase, 'academic-pdf-git-test-'));
    t.after(() => {
        const resolved = fs.realpathSync(root);
        assert.equal(path.dirname(resolved), temporaryBase);
        assert(path.basename(resolved).startsWith('academic-pdf-git-test-'));
        fs.rmSync(resolved, { recursive: true, force: true });
    });
    const git = args => execFileSync('git', args, { cwd: root, windowsHide: true });
    const write = (name, content = '%PDF-fixture') => {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
    };
    const uri = (name, ref = 'HEAD') => ({
        scheme: 'git', fsPath: path.join(root, name),
        query: JSON.stringify({ path: path.join(root, name), ref }),
        toString: () => `git:${path.join(root, name)}`,
    });
    git(['init', '-q']);
    return { root, git, write, uri };
}

test('reads HEAD and index PDFs after their entire parent directory is deleted', async t => {
    const { root, git, write, uri } = fixture(t);
    write('retired/nested/paper.pdf');
    git(['add', '--all']);
    git(['-c', 'user.name=PDF Test', '-c', 'user.email=pdf-test@localhost', 'commit', '-qm', 'fixture']);
    fs.unlinkSync(path.join(root, 'retired/nested/paper.pdf'));
    fs.rmdirSync(path.join(root, 'retired/nested'));
    fs.rmdirSync(path.join(root, 'retired'));
    for (const ref of ['HEAD', '', '~']) {
        const { readPdfData } = loadSource('extension/pdfDataSource.ts', vscode);
        assert.equal(Buffer.from(await readPdfData(uri('retired/nested/paper.pdf', ref))).toString(), '%PDF-fixture');
    }
});

test('uses literal Git paths and preserves missing-revision versus invalid-ref behavior', async t => {
    const { git, write, uri } = fixture(t);
    for (const name of ['论文 space [1].pdf', 'missing1.pdf', 'paper.pdf']) write(name, name);
    git(['add', '--all']);
    git(['-c', 'user.name=PDF Test', '-c', 'user.email=pdf-test@localhost', 'commit', '-qm', 'fixture']);
    const { readPdfData } = loadSource('extension/pdfDataSource.ts', vscode);
    for (const ref of ['HEAD', '~']) {
        for (const name of ['论文 space [1].pdf', 'paper.pdf']) {
            assert.equal(Buffer.from(await readPdfData(uri(name, ref))).toString(), name);
        }
        assert.equal((await readPdfData(uri('missing[1].pdf', ref))).byteLength, 0);
        assert.equal((await readPdfData(uri(':(glob)paper.pdf', ref))).byteLength, 0);
    }
    await assert.rejects(readPdfData(uri('absent.pdf', 'refs/heads/not-a-real-ref')), /Git rev-parse failed/);
    for (const query of ['null', '[]', '{"path":"relative.pdf","ref":"HEAD"}']) {
        await assert.rejects(readPdfData({ ...uri('absent.pdf'), query }), /Invalid Git URI/);
    }
});

test('rejects unresolved index entries instead of treating them as missing', async t => {
    const { git, write, uri } = fixture(t);
    write('paper.pdf');
    const hash = git(['hash-object', '-w', 'paper.pdf']).toString().trim();
    execFileSync('git', ['update-index', '--index-info'], {
        cwd: path.dirname(uri('paper.pdf').fsPath), windowsHide: true,
        input: `100644 ${hash} 1\tpaper.pdf\n100644 ${hash} 2\tpaper.pdf\n`,
    });
    const { readPdfData } = loadSource('extension/pdfDataSource.ts', vscode);
    await assert.rejects(readPdfData(uri('paper.pdf', '~')), /no resolved PDF entry/);
});

test('cancels an active Git child and bounds hidden subprocess execution', async t => {
    const { uri } = fixture(t);
    let child;
    let options;
    let started;
    const spawned = new Promise(resolve => { started = resolve; });
    const { readPdfData } = loadSource('extension/pdfDataSource.ts', vscode, {
        'node:child_process': {
            execFile: (_executable, _args, requestOptions, callback) => {
                options = requestOptions;
                child = execFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], requestOptions, callback);
                child.once('spawn', started);
                return child;
            },
        },
    });
    t.after(() => child?.kill());
    const cancellation = new CancellationTokenSource();
    const read = readPdfData(uri('paper.pdf'), undefined, cancellation.token);
    const rejected = assert.rejects(read, CancellationError);
    await spawned;
    cancellation.cancel();
    await rejected;
    assert.equal(child.killed, true);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 60_000);
    assert.equal(options.maxBuffer, 1024 * 1024);
    assert.equal(cancellation.emitter.listeners.size, 0);
});

test('a Git timeout settles the read instead of leaving a pending request', async t => {
    const { uri } = fixture(t);
    const { readPdfData } = loadSource('extension/pdfDataSource.ts', vscode, {
        'node:child_process': {
            execFile: (_executable, _args, options, callback) => execFile(
                process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, timeout: 30 }, callback),
        },
    });
    await assert.rejects(readPdfData(uri('paper.pdf')), /Git rev-parse failed/);
});
