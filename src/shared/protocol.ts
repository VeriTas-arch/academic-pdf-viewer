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
    | { type: 'linkPreview.setEnabled'; enabled: boolean };

export type NavigationDirection = 'back' | 'forward';

export type PdfDebugEvent =
    | 'viewerInitializing'
    | 'viewerInitialized'
    | 'workerSourcePrepared'
    | 'workerSourceFallback'
    | 'opened'
    | 'firstPageRendered'
    | 'failed'
    | 'emptyRevision'
    | 'unhandledRejection'
    | 'windowError'
    | 'diffComputed'
    | 'diffTextFallback'
    | 'diffFailed';

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
    };

export interface NavigationPoint {
    pageNumber: number;
    scrollTop: number;
    scaleValue: string | number;
}
