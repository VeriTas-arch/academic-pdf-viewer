import * as vscode from 'vscode';

export type DevLogFields = Readonly<Record<string, unknown>>;

export interface DevLogger {
    info(event: string, fields?: DevLogFields): void;
    warn(event: string, fields?: DevLogFields): void;
    error(event: string, error: unknown, fields?: DevLogFields): void;
}

export function createDevLogger(context: vscode.ExtensionContext): DevLogger | undefined {
    if (context.extensionMode !== vscode.ExtensionMode.Development) {
        return undefined;
    }

    const output = vscode.window.createOutputChannel('Academic PDF Viewer (Debug)', { log: true });
    context.subscriptions.push(output);

    return {
        info(event, fields = {}) {
            output.info(formatEntry(event, fields));
        },
        warn(event, fields = {}) {
            output.warn(formatEntry(event, fields));
        },
        error(event, error, fields = {}) {
            const errorFields = error instanceof Error
                ? { errorName: error.name, errorMessage: error.message, errorStack: error.stack }
                : { errorMessage: String(error) };
            output.error(formatEntry(event, { ...fields, ...errorFields }));
        },
    };
}

function formatEntry(event: string, fields: DevLogFields): string {
    return `${event} ${JSON.stringify(fields)}`;
}
