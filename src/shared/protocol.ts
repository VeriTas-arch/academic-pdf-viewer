export type ExtensionToWebviewMessage =
    | { type: 'navigation.back' }
    | { type: 'navigation.forward' }
    | { type: 'document.load'; data: ArrayBuffer; isEmptyRevision: boolean; fingerprint: string; preserveView: boolean }
    | { type: 'diff.setEnabled'; enabled: false; sessionId: number }
    | { type: 'diff.setEnabled'; enabled: true; sessionId: number; role: 'original'; allPagesChanged: boolean }
    | {
        type: 'diff.setEnabled';
        enabled: true;
        sessionId: number;
        role: 'modified';
        originalData: ArrayBuffer;
        originalFingerprint: string;
        originalIsEmptyRevision: boolean;
        modifiedIsEmptyRevision: boolean;
    }
    | { type: 'diff.applyPage'; sessionId: number; pageNumber: number; changes: PdfDiffChange[] }
    | { type: 'diff.setRemovedPageRange'; sessionId: number; fromPage: number; toPage: number }
    | { type: 'diff.applyScroll'; pageNumber: number; pageRatio: number; documentRatio: number }
    | { type: 'diff.navigate'; sessionId: number; direction: DiffNavigationDirection }
    | {
        type: 'diff.scanForChange';
        sessionId: number;
        requestId: number;
        role: DiffRole;
        direction: DiffNavigationDirection;
        startPage: number;
    }
    | {
        type: 'diff.revealChange';
        sessionId: number;
        requestId: number;
        pageNumber: number;
        index: number;
        changes: PdfDiffChange[];
    }
    | {
        type: 'linkPreview.configure';
        enabled: boolean;
        resolutionScale: number;
    };

export interface PdfDiffRegion {
    left: number;
    top: number;
    width: number;
    height: number;
}

export type PdfDiffChangeKind = 'insert' | 'delete' | 'replace';
export type PdfDiffStrategy = 'page' | 'raster' | 'text';

export interface PdfDiffChange {
    id: string;
    kind: PdfDiffChangeKind;
    regions: PdfDiffRegion[];
    strategy: PdfDiffStrategy;
}

export type DiffNavigationDirection = 'next' | 'previous';
export type DiffRole = 'original' | 'modified';

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
    'linkPreviewRendered',
    'linkPreviewEncoded',
] as const;

type PdfDebugEvent = typeof pdfDebugEventValues[number];

export type WebviewToExtensionMessage =
    | { type: 'navigation.keyUp'; direction: NavigationDirection }
    | { type: 'workbench.showCommands' }
    | { type: 'webview.ready' }
    | { type: 'diff.pageResult'; sessionId: number; pageNumber: number; originalChanges: PdfDiffChange[] }
    | { type: 'diff.removedPageRange'; sessionId: number; fromPage: number; toPage: number }
    | {
        type: 'diff.navigationRequest';
        sessionId: number;
        requestId: number;
        role: DiffRole;
        direction: DiffNavigationDirection;
        startPage: number;
    }
    | {
        type: 'diff.navigationResult';
        sessionId: number;
        requestId: number;
        role: DiffRole;
        pageNumber: number;
        index: number;
        changes: PdfDiffChange[];
    }
    | { type: 'diff.scroll'; pageNumber: number; pageRatio: number; documentRatio: number }
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
        case 'diff.pageResult':
            return isSessionId(value.sessionId)
                && isPageNumber(value.pageNumber)
                && isPdfDiffChanges(value.originalChanges);
        case 'diff.removedPageRange':
            return isSessionId(value.sessionId)
                && isPageNumber(value.fromPage)
                && isPageNumber(value.toPage)
                && value.fromPage <= value.toPage;
        case 'diff.navigationRequest':
            return isSessionId(value.sessionId)
                && isSessionId(value.requestId)
                && isDiffRole(value.role)
                && isDiffNavigationDirection(value.direction)
                && isPageNumber(value.startPage);
        case 'diff.navigationResult':
            return isSessionId(value.sessionId)
                && isSessionId(value.requestId)
                && isDiffRole(value.role)
                && isPageNumber(value.pageNumber)
                && typeof value.index === 'number'
                && Number.isSafeInteger(value.index)
                && value.index >= 0
                && isPdfDiffChanges(value.changes)
                && value.changes.length > value.index;
        case 'diff.scroll':
            return isPageNumber(value.pageNumber)
                && isNormalizedNumber(value.pageRatio)
                && isNormalizedNumber(value.documentRatio);
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

function isPageNumber(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1;
}

function isSessionId(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1;
}

function isDiffRole(value: unknown): value is DiffRole {
    return value === 'original' || value === 'modified';
}

function isDiffNavigationDirection(value: unknown): value is DiffNavigationDirection {
    return value === 'next' || value === 'previous';
}

function isPdfDiffRegion(value: unknown): value is PdfDiffRegion {
    if (!isRecord(value)) {
        return false;
    }
    return isNormalizedNumber(value.left)
        && isNormalizedNumber(value.top)
        && isNormalizedNumber(value.width)
        && isNormalizedNumber(value.height)
        && value.left + value.width <= 1.000001
        && value.top + value.height <= 1.000001;
}

function isPdfDiffChanges(value: unknown): value is PdfDiffChange[] {
    return Array.isArray(value)
        && value.length <= 200
        && value.every(isPdfDiffChange)
        && value.reduce((count, change) => count + change.regions.length, 0) <= 200;
}

function isPdfDiffChange(value: unknown): value is PdfDiffChange {
    return isRecord(value)
        && typeof value.id === 'string'
        && value.id.length > 0
        && value.id.length <= 128
        && (value.kind === 'insert' || value.kind === 'delete' || value.kind === 'replace')
        && (value.strategy === 'page' || value.strategy === 'raster' || value.strategy === 'text')
        && Array.isArray(value.regions)
        && value.regions.length > 0
        && value.regions.every(isPdfDiffRegion);
}

function isNormalizedNumber(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= 0
        && value <= 1;
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
