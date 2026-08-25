interface PdfJsEventBus {
    on<T>(name: string, listener: (event: T) => void): void;
    off<T>(name: string, listener: (event: T) => void): void;
}

interface PdfJsViewport {
    width: number;
    height: number;
    viewBox: number[];
    scale: number;
    userUnit: number;
    transform: number[];
    convertToViewportPoint(x: number, y: number): number[];
    convertToPdfPoint(x: number, y: number): number[];
}

interface PdfJsTextItem {
    fontName?: string;
    str?: string;
    transform?: number[];
    width?: number;
}

interface PdfJsTextStyle {
    ascent?: number;
    descent?: number;
    fontFamily?: string;
}

interface PdfJsTextContent {
    items: PdfJsTextItem[];
    styles?: Record<string, PdfJsTextStyle>;
}

type PdfJsDestination = string | unknown[];

interface PdfJsAnnotation {
    id?: string;
    subtype?: string;
    rect?: number[];
    dest?: PdfJsDestination;
}

interface PdfJsRenderTask {
    promise: Promise<void>;
    cancel(): void;
}

interface PdfJsPage {
    getAnnotations(options: { intent: "display" }): Promise<PdfJsAnnotation[]>;
    getTextContent(): Promise<PdfJsTextContent>;
    getViewport(options: { scale: number; offsetX?: number; offsetY?: number }): PdfJsViewport;
    render(options: {
        canvasContext: CanvasRenderingContext2D;
        viewport: PdfJsViewport;
        background?: string;
    }): PdfJsRenderTask;
}

interface PdfJsDocument {
    numPages: number;
    cachedPageNumber?(destinationReference: object): number | null;
    getDestination(name: string): Promise<unknown[] | null>;
    getPage(pageNumber: number): Promise<PdfJsPage>;
    getPageIndex(destinationReference: object): Promise<number>;
}

interface PdfJsPageView {
    id: number;
    div: HTMLElement;
    pdfPage?: PdfJsPage;
    renderingState: number;
    viewport: PdfJsViewport;
    setPdfPage(page: PdfJsPage): void;
}

interface PdfJsViewer {
    container: HTMLElement;
    currentPageNumber: number;
    currentScale: number;
    currentScaleValue: string;
    isInPresentationMode: boolean;
    pagesCount: number;
    pagesPromise: Promise<void>;
    getPageView(index: number): PdfJsPageView | undefined;
    update(): void;
    scrollPageIntoView(options: {
        pageNumber: number;
        destArray: unknown[];
        allowNegativeOffset: boolean;
        ignoreDestinationZoom: boolean;
        center?: "vertical" | "horizontal" | "both";
    }): void;
}

interface PdfJsLinkService {
    goToDestination(...args: unknown[]): unknown;
    goToPage(...args: unknown[]): unknown;
    setHash(...args: unknown[]): unknown;
}

interface PdfJsApplication {
    initializedPromise: Promise<void>;
    eventBus: PdfJsEventBus;
    pdfDocument: PdfJsDocument | null;
    pdfLinkService: PdfJsLinkService;
    pdfLoadingTask: unknown;
    pdfViewer: PdfJsViewer;
    supportsMouseWheelZoomCtrlKey: boolean;
    supportsMouseWheelZoomMetaKey: boolean;
    close(): Promise<void>;
    load(pdfDocument: PdfJsDocument): unknown;
    open(options: Record<string, unknown>): Promise<unknown>;
}

interface PdfJsLoadingTask {
    promise: Promise<PdfJsDocument>;
    destroy(): Promise<void>;
}

interface PdfJsViewerOptions {
    set(name: string, value: unknown): void;
}

interface PdfJsLocation {
    left: number | null;
    top: number | null;
}

type AcademicSidebarView = "pages" | "outline" | "attachments" | "layers";

interface AcademicSidebarState {
    view: AcademicSidebarView;
    isOpen: boolean;
}

interface AcademicPdfJsCapabilities {
    viewer: boolean;
    viewerContainer: boolean;
    toolbarHost: boolean;
    location: boolean;
    fingerprintOverride: boolean;
    pageNumberInterception: boolean;
    sidebarView: boolean;
}

interface AcademicPdfJsAdapter {
    getApplication(): PdfJsApplication | null;
    getViewer(): PdfJsViewer | null;
    getViewerContainer(viewer?: PdfJsViewer | null): HTMLElement | null;
    getToolbarHost(): HTMLElement | null;
    getPageViews(viewer: PdfJsViewer): PdfJsPageView[];
    getCapabilities(
        document?: PdfJsDocument | null,
        viewer?: PdfJsViewer | null
    ): AcademicPdfJsCapabilities;
    getPdfLocation(viewer: PdfJsViewer): PdfJsLocation;
    setDocumentFingerprint(document: PdfJsDocument, fingerprint: string): boolean;
    getSidebarState(): AcademicSidebarState | null;
    setSidebarView(view: AcademicSidebarView): boolean;
    restoreSidebarState(state: AcademicSidebarState): boolean;
    interceptPageNumberChanges(
        viewer: PdfJsViewer,
        beforeChange: (pageNumber: number, resetCurrentPageView: boolean) => void
    ): boolean;
}

interface Window {
    academicPdfJsAdapter: AcademicPdfJsAdapter;
    PDFViewerApplication: PdfJsApplication;
    PDFViewerApplicationOptions?: PdfJsViewerOptions;
}

declare const pdfjsLib: {
    getDocument(options: Record<string, unknown>): PdfJsLoadingTask;
    Util: {
        transform(first: number[], second: number[]): number[];
    };
};

declare function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
};
