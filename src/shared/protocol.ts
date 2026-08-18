export type ExtensionToWebviewMessage =
    | { type: 'navigation.back' }
    | { type: 'navigation.forward' }
    | { type: 'document.load'; data: ArrayBuffer; isEmptyRevision: boolean; fingerprint: string; preserveView: boolean }
    | { type: 'linkPreview.setEnabled'; enabled: boolean };

export type NavigationDirection = 'back' | 'forward';

export type PdfDebugEvent = 'opened' | 'firstPageRendered' | 'failed' | 'emptyRevision';

export type WebviewToExtensionMessage =
    | { type: 'navigation.keyUp'; direction: NavigationDirection }
    | { type: 'workbench.showCommands' }
    | { type: 'webview.ready' }
    | {
        type: 'pdf.debug';
        event: PdfDebugEvent;
        fingerprint: string;
        durationMs: number;
        pages?: number;
        pageNumber?: number;
        error?: string;
    };

export interface NavigationPoint {
    pageNumber: number;
    scrollTop: number;
    scaleValue: string | number;
}
