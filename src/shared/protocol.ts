export type ExtensionToWebviewMessage =
    | { type: 'navigation.back' }
    | { type: 'navigation.forward' };

export type NavigationDirection = 'back' | 'forward';

export type WebviewToExtensionMessage =
    | { type: 'navigation.keyUp'; direction: NavigationDirection };

export interface NavigationPoint {
    pageNumber: number;
    scrollTop: number;
    scaleValue: string | number;
}
