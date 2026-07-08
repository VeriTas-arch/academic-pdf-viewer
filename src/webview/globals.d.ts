interface Window {
    PDFViewerApplication: any;
    PDFViewerApplicationOptions: any;
}

declare const pdfjsLib: any;

declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
};
