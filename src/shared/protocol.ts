export type ExtensionToWebviewMessage =
    | { type: 'navigation.back' }
    | { type: 'navigation.forward' };

export interface NavigationPoint {
    pageNumber: number;
    scrollTop: number;
    scaleValue: string | number;
}

