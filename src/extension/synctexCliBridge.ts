import * as path from 'node:path';

import * as vscode from 'vscode';

import type { SyncTexForwardRequest, SyncTexInverseEvent } from '../shared/protocol';
import { PDF_VIEW_TYPE } from './pdfEditorProvider';
import {
    querySyncTexForward,
    querySyncTexInverse,
    resolveSourceColumn,
    runSyncTexProcess,
    syncTexTextHint,
    type SyncTexRunner,
} from './synctexCli';

export const SYNCTEX_FORWARD_FROM_CURSOR_COMMAND = 'academicPdfViewer.tex.synctexForwardFromCursor';

interface SyncTexViewer {
    readonly onDidRequestInverseSyncTex: vscode.Event<SyncTexInverseEvent>;
    synctexForward(request: SyncTexForwardRequest): boolean;
}

interface SyncTexBridgeConfiguration {
    executable: string;
    pdfPath: string;
}

/** Registers the optional local SyncTeX command-line bridge. */
export function registerSyncTexCliBridge(
    context: vscode.ExtensionContext,
    viewer: SyncTexViewer,
    processRunner: SyncTexRunner = runSyncTexProcess,
): void {
    const output = vscode.window.createOutputChannel('Academic PDF Viewer SyncTeX');
    const runner: SyncTexRunner = async request => {
        output.appendLine(formatCommand(request.executable, request.args));
        const result = await processRunner(request);
        appendProcessOutput(output, result.stdout);
        appendProcessOutput(output, result.stderr);
        return result;
    };

    const reportError = (error: unknown): void => {
        const detail = error instanceof Error ? error.message : String(error);
        output.appendLine(`Error: ${detail}`);
        output.show(true);
        void vscode.window.showErrorMessage(`SyncTeX: ${detail}`);
    };

    context.subscriptions.push(
        output,
        vscode.commands.registerCommand(SYNCTEX_FORWARD_FROM_CURSOR_COMMAND, async () => {
            try {
                return await forwardFromCursor(viewer, runner, output);
            } catch (error) {
                reportError(error);
                return false;
            }
        }),
        viewer.onDidRequestInverseSyncTex(event => {
            if (!isBridgeEnabled(vscode.Uri.parse(event.pdfUri, true))) {
                return;
            }
            void inverseToSource(event, runner, output).catch(reportError);
        }),
    );
}

async function forwardFromCursor(
    viewer: SyncTexViewer,
    runner: SyncTexRunner,
    output: vscode.OutputChannel,
): Promise<boolean> {
    const editor = vscode.window.activeTextEditor;
    if (!editor
        || editor.document.uri.scheme !== 'file'
        || path.extname(editor.document.uri.fsPath).toLowerCase() !== '.tex') {
        throw new Error('Open a local .tex file and place the caret at the forward-search target.');
    }
    const sourceUri = editor.document.uri;
    if (!isBridgeEnabled(sourceUri)) {
        throw new Error('Enable academicPdfViewer.tex.bridge.enabled to use the built-in SyncTeX bridge.');
    }
    ensureTrustedWorkspace();

    const configuration = readBridgeConfiguration(sourceUri);
    const sourcePath = sourceUri.fsPath;
    const pdfPath = resolvePdfPath(sourceUri, configuration.pdfPath);
    const pdfUri = vscode.Uri.file(pdfPath);
    const pdfStat = await vscode.workspace.fs.stat(pdfUri);
    if ((pdfStat.type & vscode.FileType.File) === 0) {
        throw new Error(`The configured SyncTeX PDF is not a file: ${pdfPath}`);
    }

    const position = editor.selection.active;
    const result = await querySyncTexForward(
        runner,
        configuration.executable,
        sourcePath,
        pdfPath,
        position.line + 1,
        position.character + 1,
    );
    await vscode.commands.executeCommand(
        'vscode.openWith',
        pdfUri,
        PDF_VIEW_TYPE,
        vscode.ViewColumn.Beside,
    );
    const accepted = viewer.synctexForward({
        type: 'synctex.forward',
        pdfUri: pdfUri.toString(),
        ...result,
    });
    output.appendLine(`Forward request accepted: ${accepted}`);
    if (!accepted) {
        throw new Error('Academic PDF Viewer did not accept the forward request.');
    }
    return true;
}

async function inverseToSource(
    event: SyncTexInverseEvent,
    runner: SyncTexRunner,
    output: vscode.OutputChannel,
): Promise<void> {
    ensureTrustedWorkspace();
    const pdfUri = vscode.Uri.parse(event.pdfUri, true);
    if (pdfUri.scheme !== 'file') {
        throw new Error(`The built-in SyncTeX bridge only supports local file URIs, not ${pdfUri.scheme}: URIs.`);
    }

    const configuration = readBridgeConfiguration(pdfUri);
    const textHint = syncTexTextHint(event.context, event.offset);
    const result = await querySyncTexInverse(
        runner,
        configuration.executable,
        pdfUri.fsPath,
        event.pageNumber,
        event.x,
        event.y,
        textHint,
    );
    const sourcePath = path.isAbsolute(result.input)
        ? result.input
        : path.resolve(path.dirname(pdfUri.fsPath), result.input);
    const sourceDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(sourcePath));
    if (result.line > sourceDocument.lineCount) {
        throw new Error(`SyncTeX returned source line ${result.line}, but the file has only ${sourceDocument.lineCount} lines.`);
    }

    const sourceLine = sourceDocument.lineAt(result.line - 1);
    const resolution = resolveSourceColumn(result.column, sourceLine.text, textHint);
    const target = resolution.column === undefined
        ? sourceLine.range
        : new vscode.Range(
            new vscode.Position(result.line - 1, resolution.column),
            new vscode.Position(result.line - 1, resolution.column),
        );
    output.appendLine(
        resolution.method === 'line'
            ? `No unique source column was available for line ${result.line}; selecting the line.`
            : `Resolved source line ${result.line}, column ${resolution.column! + 1} (${resolution.method}).`,
    );
    const sourceEditor = await vscode.window.showTextDocument(sourceDocument, {
        viewColumn: vscode.ViewColumn.One,
    });
    sourceEditor.selection = new vscode.Selection(target.start, target.end);
    sourceEditor.revealRange(target, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function isBridgeEnabled(resource: vscode.Uri): boolean {
    return vscode.workspace
        .getConfiguration('academicPdfViewer', resource)
        .get<boolean>('tex.bridge.enabled', false);
}

function readBridgeConfiguration(resource: vscode.Uri): SyncTexBridgeConfiguration {
    const configuration = vscode.workspace.getConfiguration('academicPdfViewer', resource);
    return {
        executable: configuration.get<string>('tex.bridge.executable', 'synctex').trim() || 'synctex',
        pdfPath: configuration.get<string>('tex.bridge.pdfPath', '').trim(),
    };
}

function resolvePdfPath(sourceUri: vscode.Uri, configuredPath: string): string {
    const sourcePath = sourceUri.fsPath;
    if (!configuredPath) {
        return sourcePath.slice(0, -path.extname(sourcePath).length) + '.pdf';
    }
    if (path.isAbsolute(configuredPath)) {
        return path.normalize(configuredPath);
    }
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(sourceUri);
    if (!workspaceFolder || workspaceFolder.uri.scheme !== 'file') {
        throw new Error('A relative SyncTeX PDF path requires a local workspace folder.');
    }
    return path.resolve(workspaceFolder.uri.fsPath, configuredPath);
}

function ensureTrustedWorkspace(): void {
    if (!vscode.workspace.isTrusted) {
        throw new Error('Trust this workspace before running the built-in SyncTeX bridge.');
    }
}

function formatCommand(executable: string, args: string[]): string {
    return [executable, ...args].map(argument => JSON.stringify(argument)).join(' ');
}

function appendProcessOutput(output: vscode.OutputChannel, text: string): void {
    if (text) {
        output.append(text.endsWith('\n') ? text : `${text}\n`);
    }
}
