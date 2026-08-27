import { execFile } from 'node:child_process';
import * as path from 'node:path';

import type { SyncTexTargetBox } from '../shared/protocol';

const SYNCTEX_TIMEOUT_MS = 10_000;
const SYNCTEX_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface SyncTexRunRequest {
    executable: string;
    args: string[];
    cwd: string;
}

export interface SyncTexRunResult {
    stdout: string;
    stderr: string;
}

export type SyncTexRunner = (request: SyncTexRunRequest) => Promise<SyncTexRunResult>;

export interface SyncTexTextHint {
    context: string;
    offset: number;
}

export interface SyncTexForwardResult {
    pageNumber: number;
    x: number;
    y: number;
    targetBox?: SyncTexTargetBox;
}

export interface SyncTexInverseResult {
    input: string;
    line: number;
    column: number;
}

export type SourceColumnResolution = {
    column: number | undefined;
    method: 'synctex' | 'hint' | 'line';
};

export interface LatestRequestTracker {
    begin(): () => boolean;
}

/** Returns guards that remain current only until the next request begins. */
export function createLatestRequestTracker(): LatestRequestTracker {
    let generation = 0;
    return {
        begin: () => {
            const requestGeneration = ++generation;
            return () => requestGeneration === generation;
        },
    };
}

export const runSyncTexProcess: SyncTexRunner = request => new Promise((resolve, reject) => {
    execFile(
        request.executable,
        request.args,
        {
            cwd: request.cwd,
            encoding: 'utf8',
            maxBuffer: SYNCTEX_MAX_OUTPUT_BYTES,
            timeout: SYNCTEX_TIMEOUT_MS,
            windowsHide: true,
        },
        (error, stdout, stderr) => {
            if (error) {
                reject(new Error(stderr.trim() || stdout.trim() || error.message));
                return;
            }
            resolve({ stdout, stderr });
        },
    );
});

export async function querySyncTexForward(
    runner: SyncTexRunner,
    executable: string,
    sourcePath: string,
    pdfPath: string,
    line: number,
    column: number,
): Promise<SyncTexForwardResult> {
    const result = await runner({
        executable,
        args: ['view', '-i', `${line}:${column}:${sourcePath}`, '-o', pdfPath],
        cwd: path.dirname(sourcePath),
    });
    const fields = parseSyncTexFields(result.stdout);
    const pageNumber = finiteField(fields, 'Page');
    const x = finiteField(fields, 'x');
    const y = finiteField(fields, 'y');
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
        throw new Error('SyncTeX returned an invalid Page field.');
    }

    const targetBox = readSyncTexTargetBox(fields);
    return {
        pageNumber,
        x,
        y,
        ...(targetBox ? { targetBox } : {}),
    };
}

export async function querySyncTexInverse(
    runner: SyncTexRunner,
    executable: string,
    pdfPath: string,
    pageNumber: number,
    x: number,
    y: number,
    textHint?: SyncTexTextHint,
): Promise<SyncTexInverseResult> {
    const args = ['edit', '-o', `${pageNumber}:${x}:${y}:${pdfPath}`];
    if (textHint) {
        args.push('-h', `${textHint.offset}:${textHint.context}`);
    }
    const result = await runner({
        executable,
        args,
        cwd: path.dirname(pdfPath),
    });
    const fields = parseSyncTexFields(result.stdout);
    const input = fields.get('Input');
    const line = finiteField(fields, 'Line');
    const column = finiteField(fields, 'Column');
    if (!input || !Number.isInteger(line) || line < 1 || !Number.isInteger(column)) {
        throw new Error('SyncTeX did not return a valid source position.');
    }
    return { input, line, column };
}

export function syncTexTextHint(context: string | undefined, offset: number | undefined): SyncTexTextHint | undefined {
    return typeof context === 'string'
        && context.length > 0
        && offset !== undefined
        && Number.isSafeInteger(offset)
        && offset >= 0
        && offset <= context.length
        ? { context, offset }
        : undefined;
}

export function resolveSourceColumn(
    column: number,
    sourceText: string,
    textHint?: SyncTexTextHint,
): SourceColumnResolution {
    // SyncTeX node columns are one-based; non-positive values mean that no exact column is available.
    if (Number.isInteger(column) && column > 0 && column <= sourceText.length) {
        return { column: column - 1, method: 'synctex' };
    }

    const contextIndex = textHint ? sourceText.indexOf(textHint.context) : -1;
    if (textHint
        && contextIndex >= 0
        && sourceText.lastIndexOf(textHint.context) === contextIndex) {
        return { column: contextIndex + textHint.offset, method: 'hint' };
    }
    return { column: undefined, method: 'line' };
}

function parseSyncTexFields(output: string): Map<string, string> {
    const fields = new Map<string, string>();
    for (const line of output.split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator > 0) {
            const key = line.slice(0, separator);
            if (!fields.has(key)) {
                fields.set(key, line.slice(separator + 1).trim());
            }
        }
    }
    return fields;
}

function finiteField(fields: Map<string, string>, key: string): number {
    const field = fields.get(key);
    if (field === undefined || field.length === 0) {
        throw new Error(`SyncTeX did not return a valid ${key} field.`);
    }
    const value = Number(field);
    if (!Number.isFinite(value)) {
        throw new Error(`SyncTeX did not return a valid ${key} field.`);
    }
    return value;
}

function readSyncTexTargetBox(fields: Map<string, string>): SyncTexTargetBox | undefined {
    const xField = fields.get('h');
    const bottomField = fields.get('v');
    const widthField = fields.get('W');
    const heightField = fields.get('H');
    if (!xField || !bottomField || !widthField || !heightField) {
        return undefined;
    }
    const x = Number(xField);
    const bottom = Number(bottomField);
    const width = Number(widthField);
    const height = Number(heightField);
    const y = bottom - height;
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        return undefined;
    }
    return { x, y, width, height };
}
