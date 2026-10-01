import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';

import type { DevLogFields, DevLogger } from './devLogger';
import { assertPdfSize, MAX_PDF_BYTES } from './pdfSizeLimits';

const gitRootCache = new Map<string, string>();
const GIT_TIMEOUT_MS = 60_000;
const GIT_METADATA_MAX_BYTES = 1024 * 1024;

export async function readPdfData(
    uri: vscode.Uri,
    logger?: DevLogger,
    token?: vscode.CancellationToken,
): Promise<Uint8Array> {
    const startedAt = Date.now();
    const fields = describePdfUri(uri);
    const source = uri.scheme === 'git' ? 'gitBlob' : 'workspaceFs';
    logger?.info('pdf.read.start', { ...fields, source });

    try {
        throwIfCancellationRequested(token);
        let data: Uint8Array;
        if (uri.scheme === 'git') {
            data = await readGitBlob(uri, token);
        } else {
            const stat = await vscode.workspace.fs.stat(uri);
            throwIfCancellationRequested(token);
            assertPdfSize(stat.size);
            data = await vscode.workspace.fs.readFile(uri);
        }
        throwIfCancellationRequested(token);
        assertPdfSize(data.byteLength);
        logger?.info('pdf.read.done', {
            ...fields,
            source,
            bytes: data.byteLength,
            durationMs: Date.now() - startedAt,
        });
        return data;
    } catch (error) {
        const resultFields = {
            ...fields,
            source,
            durationMs: Date.now() - startedAt,
        };
        if (error instanceof vscode.CancellationError) {
            logger?.info('pdf.read.cancelled', resultFields);
        } else {
            logger?.error('pdf.read.failed', error, resultFields);
        }
        throw error;
    }
}

export function describePdfUri(uri: vscode.Uri): DevLogFields {
    if (uri.scheme !== 'git') {
        return { scheme: uri.scheme, path: uri.fsPath };
    }

    try {
        const query = JSON.parse(uri.query) as Record<string, unknown>;
        return { scheme: uri.scheme, path: query.path, ref: query.ref };
    } catch {
        return { scheme: uri.scheme, uri: uri.toString() };
    }
}

async function readGitBlob(
    uri: vscode.Uri,
    token?: vscode.CancellationToken,
): Promise<Uint8Array> {
    const query: unknown = JSON.parse(uri.query);
    if (query === null || typeof query !== 'object' || Array.isArray(query)
        || !('path' in query) || typeof query.path !== 'string' || !isAbsolute(query.path)
        || !('ref' in query) || typeof query.ref !== 'string') {
        throw new Error(`Invalid Git URI: ${uri.toString()}`);
    }

    const repositoryRoot = await getGitRepositoryRoot(query.path, token);
    throwIfCancellationRequested(token);
    const repositoryPath = relative(repositoryRoot, query.path);
    if (repositoryPath === '..' || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) {
        throw new Error(`PDF is outside its Git repository: ${query.path}`);
    }

    const gitPath = repositoryPath.replace(/\\/g, '/');
    const objectName = await resolveGitObjectName(repositoryRoot, gitPath, query.ref, token);
    if (!objectName) {
        return new Uint8Array();
    }
    const stat = await runGit(['cat-file', '-s', '--', objectName], repositoryRoot, token);
    const objectSize = Number.parseInt(stat.toString('utf8').trim(), 10);
    if (!Number.isSafeInteger(objectSize)) {
        throw new Error(`git blob size output was invalid: ${stat.toString('utf8').trim()}`);
    }
    assertPdfSize(objectSize);

    return runGit(['cat-file', 'blob', '--', objectName], repositoryRoot, token);
}

async function resolveGitObjectName(
    repositoryRoot: string,
    gitPath: string,
    ref: string,
    token?: vscode.CancellationToken,
): Promise<string | undefined> {
    if (ref === '~' || ref === '') {
        const entry = await runGit(['ls-files', '--stage', '-z', '--', gitPath], repositoryRoot, token);
        if (entry.length === 0) {
            return undefined;
        }
        for (const record of entry.toString('utf8').split('\0')) {
            const match = /^\d+ ([0-9a-f]{40,64}) 0\t([\s\S]*)$/i.exec(record);
            if (match?.[2] === gitPath) {
                return match[1];
            }
        }
        throw new Error(`Git index has no resolved PDF entry: ${gitPath}`);
    }

    const resolvedRef = (await runGit([
        'rev-parse',
        '--verify',
        '--end-of-options',
        `${ref}^{commit}`,
    ], repositoryRoot, token)).toString('utf8').trim();
    if (!/^[0-9a-f]{40,64}$/i.test(resolvedRef)) {
        throw new Error(`Git resolved ref output was invalid: ${resolvedRef}`);
    }
    const entry = await runGit(['ls-tree', '-z', resolvedRef, '--', gitPath], repositoryRoot, token);
    if (entry.length === 0) {
        return undefined;
    }
    const match = /^\d+ blob ([0-9a-f]{40,64})\t([\s\S]*)\0$/i.exec(entry.toString('utf8'));
    if (match?.[2] !== gitPath) {
        throw new Error(`Git revision has no PDF blob entry: ${gitPath}`);
    }
    return match[1];
}

async function getGitRepositoryRoot(
    path: string,
    token?: vscode.CancellationToken,
): Promise<string> {
    let workspacePath = dirname(path);
    for (;;) {
        throwIfCancellationRequested(token);
        try {
            if ((await stat(workspacePath)).isDirectory()) {
                break;
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                throw error;
            }
        }
        const parent = dirname(workspacePath);
        if (parent === workspacePath) {
            throw new Error(`No existing directory for Git PDF: ${path}`);
        }
        workspacePath = parent;
    }
    throwIfCancellationRequested(token);
    const cachedRoot = gitRootCache.get(workspacePath);
    if (cachedRoot !== undefined) {
        return cachedRoot;
    }
    const repositoryRoot = (await runGit(
        ['rev-parse', '--show-toplevel'],
        workspacePath,
        token,
    )).toString('utf8').trim();
    throwIfCancellationRequested(token);
    gitRootCache.set(workspacePath, repositoryRoot);
    return repositoryRoot;
}

function runGit(
    args: string[],
    cwd: string,
    token?: vscode.CancellationToken,
): Promise<Buffer> {
    throwIfCancellationRequested(token);
    const configuredGitPath = vscode.workspace.getConfiguration('git').get<string>('path');
    return new Promise((resolve, reject) => {
        let cancellationListener: vscode.Disposable | undefined;
        const child = execFile(configuredGitPath || 'git', ['--literal-pathspecs', ...args], {
            cwd,
            encoding: null,
            maxBuffer: args[0] === 'cat-file' && args[1] === 'blob'
                ? MAX_PDF_BYTES : GIT_METADATA_MAX_BYTES,
            timeout: GIT_TIMEOUT_MS,
            windowsHide: true,
        }, (error, stdout, stderr) => {
            cancellationListener?.dispose();
            if (token?.isCancellationRequested) {
                reject(new vscode.CancellationError());
                return;
            }
            if (!error) {
                resolve(stdout);
                return;
            }
            const detail = stderr.toString('utf8').trim() || error.message;
            reject(new Error(`Git ${args[0]} failed: ${detail}`));
        });
        cancellationListener = token?.onCancellationRequested(() => {
            child.kill();
        });
        if (token?.isCancellationRequested) {
            child.kill();
        }
    });
}

function throwIfCancellationRequested(token?: vscode.CancellationToken): void {
    if (token?.isCancellationRequested) {
        throw new vscode.CancellationError();
    }
}
