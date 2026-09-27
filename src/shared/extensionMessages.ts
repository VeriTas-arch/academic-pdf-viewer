"use strict";

type AcademicExtensionToWebviewMessage = import("./protocol").ExtensionToWebviewMessage;
type AcademicDiffNavigationDirection = import("./protocol").DiffNavigationDirection;
type AcademicDiffRole = import("./protocol").DiffRole;
type AcademicMouseButtonMapping = import("./protocol").MouseButtonMapping;
type AcademicPdfDiffChange = import("./protocol").PdfDiffChange;
type AcademicPdfDiffRegion = import("./protocol").PdfDiffRegion;
type AcademicSidebarView = import("./protocol").SidebarView;
type AcademicSyncTexTargetBox = import("./protocol").SyncTexTargetBox;

interface AcademicExtensionMessageProtocol {
    isMessage(value: unknown): value is AcademicExtensionToWebviewMessage;
}

interface Window {
    academicExtensionMessages: AcademicExtensionMessageProtocol;
}

(function () {
    const maximumMessageStringLength = 8 * 1024;
    const maximumPdfBytes = 512 * 1024 * 1024;
    const maximumRegionsPerPage = 200;

    function isMessage(value: unknown): value is AcademicExtensionToWebviewMessage {
        if (!isRecord(value) || typeof value.type !== "string") {
            return false;
        }

        switch (value.type) {
            case "navigation.back":
            case "navigation.forward":
                return true;
            case "navigation.configure":
                return typeof value.mouseButtonsEnabled === "boolean"
                    && (value.mouseButtonMapping === "standard" || value.mouseButtonMapping === "swapped");
            case "sidebar.configure":
                return isSidebarView(value.defaultSidebar);
            case "synctex.configure":
                return value.mode === "off" || value.mode === "doubleclick" || value.mode === "rightclick";
            case "synctex.forward":
                return isSyncTexRequestId(value.requestId)
                    && isPositiveInteger(value.loadId)
                    && isPositiveInteger(value.pageNumber)
                    && isFiniteNumber(value.x)
                    && isFiniteNumber(value.y)
                    && isSyncTexTargetBox(value.targetBox);
            case "synctex.forwardCancel":
                return isSyncTexRequestId(value.requestId)
                    && isPositiveInteger(value.loadId);
            case "document.load":
                return isPositiveInteger(value.loadId)
                    && typeof value.isEmptyRevision === "boolean"
                    && isPdfData(value.data, value.isEmptyRevision)
                    && isBoundedNonEmptyString(value.fingerprint)
                    && typeof value.preserveView === "boolean";
            case "diff.setEnabled":
                return isDiffSetEnabledMessage(value);
            case "diff.applyPage":
                return isPositiveInteger(value.sessionId)
                    && isPositiveInteger(value.pageNumber)
                    && isPdfDiffChanges(value.changes);
            case "diff.setRemovedPageRange":
                return isPositiveInteger(value.sessionId)
                    && isPositiveInteger(value.fromPage)
                    && isPositiveInteger(value.toPage)
                    && value.fromPage <= value.toPage;
            case "diff.applyScroll":
                return isPositiveInteger(value.pageNumber)
                    && isNormalizedNumber(value.pageRatio)
                    && isNormalizedNumber(value.documentRatio);
            case "diff.navigate":
                return isPositiveInteger(value.sessionId)
                    && isDiffNavigationDirection(value.direction);
            case "diff.scanForChange":
                return isPositiveInteger(value.sessionId)
                    && isPositiveInteger(value.requestId)
                    && isDiffRole(value.role)
                    && isDiffNavigationDirection(value.direction)
                    && isPositiveInteger(value.startPage);
            case "diff.revealChange":
                return isPositiveInteger(value.sessionId)
                    && isPositiveInteger(value.requestId)
                    && isPositiveInteger(value.pageNumber)
                    && typeof value.index === "number"
                    && Number.isSafeInteger(value.index)
                    && value.index >= 0
                    && isPdfDiffChanges(value.changes)
                    && value.index < value.changes.length;
            case "linkPreview.configure":
                return typeof value.enabled === "boolean"
                    && isFiniteNumber(value.resolutionScale);
            default:
                return false;
        }
    }

    function isDiffSetEnabledMessage(value: Record<string, unknown>): boolean {
        if (typeof value.enabled !== "boolean" || !isPositiveInteger(value.sessionId)) {
            return false;
        }
        if (!value.enabled) {
            return true;
        }
        if (value.role === "original") {
            return typeof value.allPagesChanged === "boolean";
        }
        if (value.role !== "modified" || typeof value.modifiedIsEmptyRevision !== "boolean") {
            return false;
        }
        return value.modifiedIsEmptyRevision || (
            typeof value.originalIsEmptyRevision === "boolean"
            && isPdfData(value.originalData, value.originalIsEmptyRevision)
            && isBoundedNonEmptyString(value.originalFingerprint)
        );
    }

    function isSyncTexTargetBox(value: unknown): value is AcademicSyncTexTargetBox | undefined {
        if (value === undefined) {
            return true;
        }
        return isRecord(value)
            && isFiniteNumber(value.x)
            && isFiniteNumber(value.y)
            && isFiniteNumber(value.width)
            && value.width > 0
            && isFiniteNumber(value.height)
            && value.height > 0;
    }

    function isPdfDiffChanges(value: unknown): value is AcademicPdfDiffChange[] {
        if (!Array.isArray(value) || value.length > maximumRegionsPerPage) {
            return false;
        }
        let regionCount = 0;
        for (const change of value) {
            if (!isRecord(change)
                || !Array.isArray(change.regions)
                || change.regions.length === 0
                || !change.regions.every(isPdfDiffRegion)) {
                return false;
            }
            regionCount += change.regions.length;
            if (regionCount > maximumRegionsPerPage) {
                return false;
            }
        }
        return true;
    }

    function isPdfDiffRegion(value: unknown): value is AcademicPdfDiffRegion {
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

    function isPdfData(value: unknown, isEmptyRevision: boolean): value is ArrayBuffer {
        return value instanceof ArrayBuffer
            && value.byteLength <= maximumPdfBytes
            && (value.byteLength === 0) === isEmptyRevision;
    }

    function isPositiveInteger(value: unknown): value is number {
        return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
    }

    function isNormalizedNumber(value: unknown): value is number {
        return isFiniteNumber(value) && value >= 0 && value <= 1;
    }

    function isFiniteNumber(value: unknown): value is number {
        return typeof value === "number" && Number.isFinite(value);
    }

    function isBoundedNonEmptyString(value: unknown): value is string {
        return typeof value === "string"
            && value.length > 0
            && value.length <= maximumMessageStringLength;
    }

    function isSyncTexRequestId(value: unknown): value is string {
        return typeof value === "string" && value.length > 0 && value.length <= 64;
    }

    function isSidebarView(value: unknown): value is AcademicSidebarView {
        return value === "pages" || value === "outline" || value === "attachments" || value === "layers";
    }

    function isDiffRole(value: unknown): value is AcademicDiffRole {
        return value === "original" || value === "modified";
    }

    function isDiffNavigationDirection(value: unknown): value is AcademicDiffNavigationDirection {
        return value === "next" || value === "previous";
    }

    function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null;
    }

    const runtimeGlobal = globalThis as typeof globalThis & { window?: Window };
    if (runtimeGlobal.window) {
        runtimeGlobal.window.academicExtensionMessages = { isMessage };
    }
}());
