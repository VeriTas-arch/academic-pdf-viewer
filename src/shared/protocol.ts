export type ExtensionToWebviewMessage =
    | { type: 'navigation.back' }
    | { type: 'navigation.forward' }
    | { type: 'document.load'; data: ArrayBuffer; isEmptyRevision: boolean; fingerprint: string; preserveView: boolean }
    | { type: 'diff.setEnabled'; enabled: false }
    | {
        type: 'diff.setEnabled';
        enabled: true;
        originalData: ArrayBuffer;
        originalFingerprint: string;
        originalIsEmptyRevision: boolean;
    }
    | {
        type: 'linkPreview.configure';
        enabled: boolean;
        resolutionScale: number;
    };

export const DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE = 2;
export const MIN_LINK_PREVIEW_RESOLUTION_SCALE = 1;
export const MAX_LINK_PREVIEW_RESOLUTION_SCALE = 4;

export function normalizeLinkPreviewResolutionScale(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE;
    }
    return Math.min(
        Math.max(value, MIN_LINK_PREVIEW_RESOLUTION_SCALE),
        MAX_LINK_PREVIEW_RESOLUTION_SCALE,
    );
}

export type NavigationDirection = 'back' | 'forward';

const pdfDebugEventValues = [
    'viewerInitializing',
    'viewerInitialized',
    'workerSourcePrepared',
    'workerSourceFallback',
    'opened',
    'firstPageRendered',
    'failed',
    'emptyRevision',
    'unhandledRejection',
    'windowError',
    'diffComputed',
    'diffTextFallback',
    'diffFailed',
] as const;

type PdfDebugEvent = typeof pdfDebugEventValues[number];

export type WebviewToExtensionMessage =
    | { type: 'navigation.keyUp'; direction: NavigationDirection }
    | { type: 'workbench.showCommands' }
    | { type: 'webview.ready' }
    | {
        type: 'pdf.debug';
        event: PdfDebugEvent;
        fingerprint?: string;
        durationMs?: number;
        originalFingerprint?: string;
        pages?: number;
        pageNumber?: number;
        regions?: number;
        changedPixels?: number;
        strategy?: 'page' | 'raster' | 'text';
        sizeBytes?: number;
        workerSource?: 'blob' | 'mainThreadFallback';
        error?: string;
        source?: string;
        line?: number;
        column?: number;
    };

const pdfDebugEvents: ReadonlySet<string> = new Set(pdfDebugEventValues);

const maximumDebugStringLength = 8 * 1024;

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return false;
    }

    switch (value.type) {
        case 'navigation.keyUp':
            return value.direction === 'back' || value.direction === 'forward';
        case 'workbench.showCommands':
        case 'webview.ready':
            return true;
        case 'pdf.debug':
            return typeof value.event === 'string'
                && pdfDebugEvents.has(value.event)
                && isOptionalDebugString(value.fingerprint)
                && isOptionalDebugString(value.originalFingerprint)
                && isOptionalDebugString(value.error)
                && isOptionalDebugString(value.source)
                && isOptionalFiniteNumber(value.durationMs)
                && isOptionalFiniteNumber(value.pages)
                && isOptionalFiniteNumber(value.pageNumber)
                && isOptionalFiniteNumber(value.regions)
                && isOptionalFiniteNumber(value.changedPixels)
                && isOptionalFiniteNumber(value.sizeBytes)
                && isOptionalFiniteNumber(value.line)
                && isOptionalFiniteNumber(value.column)
                && (value.strategy === undefined
                    || value.strategy === 'page'
                    || value.strategy === 'raster'
                    || value.strategy === 'text')
                && (value.workerSource === undefined
                    || value.workerSource === 'blob'
                    || value.workerSource === 'mainThreadFallback');
        default:
            return false;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

function isOptionalDebugString(value: unknown): boolean {
    return value === undefined
        || (typeof value === 'string' && value.length <= maximumDebugStringLength);
}

function isOptionalFiniteNumber(value: unknown): boolean {
    return value === undefined
        || (typeof value === 'number' && Number.isFinite(value));
}
