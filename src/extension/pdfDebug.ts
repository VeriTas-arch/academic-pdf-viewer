import type * as vscode from 'vscode';

import type { WebviewToExtensionMessage } from '../shared/protocol';
import type { DevLogger } from './devLogger';
import { describePdfUri } from './pdfDataSource';

type PdfDebugMessage = Extract<WebviewToExtensionMessage, { type: 'pdf.debug' }>;

export function logPdfDebugMessage(
    logger: DevLogger | undefined,
    documentUri: vscode.Uri,
    message: PdfDebugMessage,
): void {
    if (!logger) {
        return;
    }

    const fields = {
        ...describePdfUri(documentUri),
        fingerprint: message.fingerprint,
        originalFingerprint: message.originalFingerprint,
        durationMs: message.durationMs,
        pages: message.pages,
        pageNumber: message.pageNumber,
        regions: message.regions,
        changedPixels: message.changedPixels,
        strategy: message.strategy,
        sizeBytes: message.sizeBytes,
        workerSource: message.workerSource,
        source: message.source,
        line: message.line,
        column: message.column,
    };
    if (message.event === 'failed'
        || message.event === 'diffFailed'
        || message.event === 'unhandledRejection'
        || message.event === 'windowError') {
        const event = message.event === 'diffFailed'
            ? 'visualDiff.failed'
            : `pdfjs.${message.event}`;
        logger.error(event, message.error ?? 'Unknown PDF.js error', fields);
    } else if (message.event === 'diffTextFallback') {
        logger.warn('visualDiff.textFallback', { ...fields, error: message.error });
    } else if (message.event === 'workerSourceFallback') {
        logger.warn('pdfjs.workerSourceFallback', { ...fields, error: message.error });
    } else {
        const event = message.event === 'diffComputed'
            ? 'visualDiff.computed'
            : `pdfjs.${message.event}`;
        logger.info(event, fields);
    }
}
