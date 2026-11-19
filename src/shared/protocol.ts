export const PDF_RANGE_CHUNK_BYTES = 64 * 1024;
export const PDF_RANGE_FRAME_BYTES = 512 * 1024;
export const PDF_RANGE_CONCURRENCY = 4;

export type ExtensionToWebviewMessage =
    | { type: 'navigation.back' }
    | { type: 'navigation.forward' }
    | {
        type: 'synctex.forward';
        requestId: string;
        loadId: number;
        pageNumber: number;
        x: number;
        y: number;
        targetBox?: SyncTexTargetBox;
    }
    | { type: 'synctex.forwardCancel'; requestId: string; loadId: number }
    | { type: 'synctex.configure'; mode: SyncTexMode }
    | { type: 'navigation.configure'; mouseButtonsEnabled: boolean; mouseButtonMapping: MouseButtonMapping }
    | { type: 'sidebar.configure'; defaultSidebar: SidebarView }
    | { type: 'document.load'; loadId: number; data: ArrayBuffer; isEmptyRevision: boolean; fingerprint: string; preserveView: boolean }
    | { type: 'document.loadRange'; loadId: number; size: number; data: ArrayBuffer; fingerprint: string; preserveView: boolean; filename: string }
    | { type: 'document.rangeData'; loadId: number; requestId: number; data: ArrayBuffer }
    | { type: 'document.rangeError'; loadId: number }
    | { type: 'document.loadError'; loadId: number }
    | { type: 'diff.setEnabled'; enabled: false; sessionId: number }
    | { type: 'diff.setEnabled'; enabled: true; sessionId: number; role: 'original'; allPagesChanged: boolean }
    | { type: 'diff.setEnabled'; enabled: true; sessionId: number; role: 'modified'; modifiedIsEmptyRevision: true }
    | {
        type: 'diff.setEnabled';
        enabled: true;
        sessionId: number;
        role: 'modified';
        originalData: ArrayBuffer;
        originalIsEmptyRevision: boolean;
        modifiedIsEmptyRevision: false;
    }
    | { type: 'diff.applyPage'; sessionId: number; pageNumber: number; changes: PdfDiffChange[] }
    | { type: 'diff.setRemovedPageRange'; sessionId: number; fromPage: number; toPage: number }
    | { type: 'diff.applyScroll'; loadId: number; pageNumber: number; pageRatio: number; documentRatio: number }
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

export interface PdfDiffChange {
    regions: PdfDiffRegion[];
}

export function sanitizePdfDiffChanges(changes: readonly PdfDiffChange[]): PdfDiffChange[] {
    return changes.map(change => ({
        regions: change.regions.map(region => ({
            left: region.left,
            top: region.top,
            width: region.width,
            height: region.height,
        })),
    }));
}

export type DiffNavigationDirection = 'next' | 'previous';
export type DiffRole = 'original' | 'modified';

export const DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE = 0;
export const MIN_LINK_PREVIEW_RESOLUTION_SCALE = 1;
export const MAX_LINK_PREVIEW_RESOLUTION_SCALE = 4;

export function normalizeLinkPreviewResolutionScale(value: unknown): number {
    if (value === 0 || typeof value !== 'number' || !Number.isFinite(value)) {
        return DEFAULT_LINK_PREVIEW_RESOLUTION_SCALE;
    }
    return Math.min(
        Math.max(value, MIN_LINK_PREVIEW_RESOLUTION_SCALE),
        MAX_LINK_PREVIEW_RESOLUTION_SCALE,
    );
}

export type NavigationDirection = 'back' | 'forward';
export type MouseButtonMapping = 'standard' | 'swapped';
export type SidebarView = 'pages' | 'outline' | 'attachments' | 'layers';
export type SyncTexMode = 'off' | 'doubleclick' | 'rightclick';
export type SyncTexTrigger = 'doubleClick' | 'rightClick';

export interface SyncTexTargetBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface SyncTexForwardRequest {
    type: 'synctex.forward';
    pdfUri: string;
    pageNumber: number;
    x: number;
    y: number;
    targetBox?: SyncTexTargetBox;
}

export interface SyncTexInverseEvent {
    type: 'synctex.inverse';
    pdfUri: string;
    pageNumber: number;
    x: number;
    y: number;
    trigger: SyncTexTrigger;
    context?: string;
    offset?: number;
}

export type WebviewToExtensionMessage =
    | { type: 'navigation.request'; direction: NavigationDirection }
    | { type: 'navigation.keyUp'; direction: NavigationDirection }
    | Omit<SyncTexInverseEvent, 'pdfUri'>
    | { type: 'synctex.inverseClear' }
    | {
        type: 'synctex.forwardResult';
        requestId: string;
        loadId: number;
        status: 'applied' | 'rejected';
    }
    | { type: 'workbench.openFile' }
    | { type: 'workbench.quickOpen' }
    | { type: 'workbench.showCommands' }
    | { type: 'webview.ready' }
    | { type: 'webview.documentReady' }
    | { type: 'document.rangeRequest'; loadId: number; requestId: number; begin: number; length: number }
    | { type: 'document.rangeClose'; loadId: number }
    | { type: 'diff.pageResult'; sessionId: number; pageNumber: number; originalChanges: PdfDiffChange[] }
    | { type: 'diff.failed'; sessionId: number }
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
    | { type: 'diff.scroll'; loadId: number; pageNumber: number; pageRatio: number; documentRatio: number };

const maximumDiffRegionsPerPage = 200;

export function isWebviewToExtensionMessage(value: unknown): value is WebviewToExtensionMessage {
    if (!isRecord(value) || typeof value.type !== 'string') {
        return false;
    }

    switch (value.type) {
        case 'navigation.request':
        case 'navigation.keyUp':
            return value.direction === 'back' || value.direction === 'forward';
        case 'synctex.inverse':
            return isPositiveInteger(value.pageNumber)
                && isFiniteCoordinate(value.x)
                && isFiniteCoordinate(value.y)
                && (value.trigger === 'doubleClick' || value.trigger === 'rightClick')
                && isSyncTexTextHint(value);
        case 'synctex.inverseClear':
            return true;
        case 'synctex.forwardResult':
            return isSyncTexRequestId(value.requestId)
                && isPositiveInteger(value.loadId)
                && (value.status === 'applied' || value.status === 'rejected');
        case 'workbench.openFile':
        case 'workbench.quickOpen':
        case 'workbench.showCommands':
        case 'webview.ready':
        case 'webview.documentReady':
            return true;
        case 'document.rangeClose':
            return isPositiveInteger(value.loadId);
        case 'document.rangeRequest':
            return isPositiveInteger(value.loadId) && isPositiveInteger(value.requestId)
                && typeof value.begin === 'number' && Number.isSafeInteger(value.begin) && value.begin >= 0
                && isPositiveInteger(value.length) && value.length <= PDF_RANGE_FRAME_BYTES;
        case 'diff.pageResult':
            return isPositiveInteger(value.sessionId)
                && isPositiveInteger(value.pageNumber)
                && isPdfDiffChanges(value.originalChanges);
        case 'diff.failed':
            return isPositiveInteger(value.sessionId);
        case 'diff.removedPageRange':
            return isPositiveInteger(value.sessionId)
                && isPositiveInteger(value.fromPage)
                && isPositiveInteger(value.toPage)
                && value.fromPage <= value.toPage;
        case 'diff.navigationRequest':
            return isPositiveInteger(value.sessionId)
                && isPositiveInteger(value.requestId)
                && isDiffRole(value.role)
                && isDiffNavigationDirection(value.direction)
                && isPositiveInteger(value.startPage);
        case 'diff.navigationResult':
            return isPositiveInteger(value.sessionId)
                && isPositiveInteger(value.requestId)
                && isDiffRole(value.role)
                && isPositiveInteger(value.pageNumber)
                && typeof value.index === 'number'
                && Number.isSafeInteger(value.index)
                && value.index >= 0
                && isPdfDiffChanges(value.changes)
                && value.changes.length > value.index;
        case 'diff.scroll':
            return isPositiveInteger(value.loadId)
                && isPositiveInteger(value.pageNumber)
                && isNormalizedNumber(value.pageRatio)
                && isNormalizedNumber(value.documentRatio);
        default:
            return false;
    }
}

export function isSyncTexForwardRequest(value: unknown): value is SyncTexForwardRequest {
    if (!isRecord(value)) {
        return false;
    }
    return value.type === 'synctex.forward'
        && typeof value.pdfUri === 'string'
        && value.pdfUri.length > 0
        && isPositiveInteger(value.pageNumber)
        && isFiniteCoordinate(value.x)
        && isFiniteCoordinate(value.y)
        && isSyncTexTargetBox(value.targetBox);
}

function isSyncTexTargetBox(value: unknown): value is SyncTexTargetBox | undefined {
    if (value === undefined) {
        return true;
    }
    return isRecord(value)
        && isFiniteCoordinate(value.x)
        && isFiniteCoordinate(value.y)
        && isFiniteCoordinate(value.width)
        && value.width > 0
        && isFiniteCoordinate(value.height)
        && value.height > 0;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 1;
}

function isSyncTexRequestId(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function isSyncTexTextHint(value: Record<string, unknown>): boolean {
    if (value.context === undefined && value.offset === undefined) {
        return true;
    }
    return typeof value.context === 'string'
        && value.context.length > 0
        && value.context.length <= 256
        && !/[\0\r\n]/.test(value.context)
        && typeof value.offset === 'number'
        && Number.isSafeInteger(value.offset)
        && value.offset >= 0
        && value.offset <= value.context.length;
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
    if (!Array.isArray(value) || value.length > maximumDiffRegionsPerPage) {
        return false;
    }

    let regionCount = 0;
    for (const change of value) {
        if (!isRecord(change) || !Array.isArray(change.regions) || change.regions.length === 0) {
            return false;
        }
        regionCount += change.regions.length;
        if (regionCount > maximumDiffRegionsPerPage) {
            return false;
        }
        for (const region of change.regions) {
            if (!isPdfDiffRegion(region)) {
                return false;
            }
        }
    }
    return true;
}

function isNormalizedNumber(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= 0
        && value <= 1;
}

function isFiniteCoordinate(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
