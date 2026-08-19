import { execFile } from 'node:child_process';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';

import type { DevLogFields, DevLogger } from './devLogger';

const MAX_PDF_BYTES = 512 * 1024 * 1024;
const gitRootCache = new Map<string, Promise<string>>();

export async function readPdfData(uri: vscode.Uri, logger?: DevLogger): Promise<Uint8Array> {
    const startedAt = Date.now();
    const fields = describePdfUri(uri);
    const source = uri.scheme === 'git' ? 'gitBlob' : 'workspaceFs';
    logger?.info('pdf.read.start', { ...fields, source });

    try {
        let data: Uint8Array;
        if (uri.scheme === 'git') {
            data = await readGitBlob(uri, logger);
        } else {
            const stat = await vscode.workspace.fs.stat(uri);
            assertPdfSize(stat.size);
            data = await vscode.workspace.fs.readFile(uri);
        }
        assertPdfSize(data.byteLength);
        logger?.info('pdf.read.done', {
            ...fields,
            source,
            bytes: data.byteLength,
            durationMs: Date.now() - startedAt,
        });
        return data;
    } catch (error) {
        logger?.error('pdf.read.failed', error, {
            ...fields,
            source,
            durationMs: Date.now() - startedAt,
        });
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

async function readGitBlob(uri: vscode.Uri, logger?: DevLogger): Promise<Uint8Array> {
    const startedAt = Date.now();
    const query = JSON.parse(uri.query) as Record<string, unknown>;
    if (typeof query.path !== 'string' || typeof query.ref !== 'string') {
        throw new Error(`Invalid Git URI: ${uri.toString()}`);
    }

    const repositoryRoot = await getGitRepositoryRoot(query.path);
    const repositoryPath = relative(repositoryRoot, query.path);
    if (repositoryPath === '..' || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) {
        throw new Error(`PDF is outside its Git repository: ${query.path}`);
    }

    const gitPath = repositoryPath.replace(/\\/g, '/');
    const objectName = query.ref === '~' || query.ref === ''
        ? `:${gitPath}`
        : `${query.ref}:${gitPath}`;
    const fields = { repositoryRoot, objectName };
    logger?.info('git.blob.start', fields);

    try {
        const stat = await runGit(['cat-file', '-s', '--', objectName], repositoryRoot, true);
        if (stat.length === 0) {
            logger?.warn('git.blob.missing', {
                ...fields,
                bytes: 0,
                durationMs: Date.now() - startedAt,
            });
            return new Uint8Array();
        }
        const objectSize = Number.parseInt(stat.toString('utf8').trim(), 10);
        if (!Number.isSafeInteger(objectSize)) {
            throw new Error(`git blob size output was invalid: ${stat.toString('utf8').trim()}`);
        }
        assertPdfSize(objectSize);

        const data = await runGit(['cat-file', 'blob', '--', objectName], repositoryRoot, true);
        if (data.byteLength === 0) {
            logger?.warn('git.blob.missing', {
                ...fields,
                bytes: 0,
                durationMs: Date.now() - startedAt,
            });
            return new Uint8Array();
        }
        assertPdfSize(data.byteLength);
        const resultFields = {
            ...fields,
            bytes: data.byteLength,
            durationMs: Date.now() - startedAt,
        };
        logger?.info('git.blob.done', resultFields);
        return data;
    } catch (error) {
        logger?.error('git.blob.failed', error, {
            ...fields,
            durationMs: Date.now() - startedAt,
        });
        throw error;
    }
}

async function getGitRepositoryRoot(path: string): Promise<string> {
    const workspacePath = dirname(path);
    const cachedRoot = gitRootCache.get(workspacePath);
    if (cachedRoot !== undefined) {
        return cachedRoot;
    }
    const inFlight = runGit(['rev-parse', '--show-toplevel'], workspacePath)
        .then(output => output.toString('utf8').trim())
        .catch(error => {
            gitRootCache.delete(workspacePath);
            throw error;
        });
    gitRootCache.set(workspacePath, inFlight);
    return inFlight;
}

function assertPdfSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('PDF has an invalid file size.');
    }
    if (size > MAX_PDF_BYTES) {
        throw new Error('PDF exceeds the 512 MiB safety limit.');
    }
}

function runGit(args: string[], cwd: string, missingIsEmpty = false): Promise<Buffer> {
    const configuredGitPath = vscode.workspace.getConfiguration('git').get<string>('path');
    return new Promise((resolve, reject) => {
        execFile(configuredGitPath || 'git', args, {
            cwd,
            encoding: null,
            maxBuffer: MAX_PDF_BYTES,
        }, (error, stdout, stderr) => {
            if (!error) {
                resolve(stdout);
                return;
            }
            if (missingIsEmpty && error.code === 128) {
                resolve(Buffer.alloc(0));
                return;
            }

            const detail = stderr.toString('utf8').trim() || error.message;
            reject(new Error(`Git ${args[0]} failed: ${detail}`));
        });
    });
}
