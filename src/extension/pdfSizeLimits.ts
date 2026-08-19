export const MAX_PDF_BYTES = 512 * 1024 * 1024;

export function assertPdfSize(size: number): void {
    if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error('PDF has an invalid file size.');
    }
    if (size > MAX_PDF_BYTES) {
        throw new Error('PDF exceeds the 512 MiB safety limit.');
    }
}

export function assertPdfDiffPairSize(originalBytes: number, modifiedBytes: number): void {
    assertPdfSize(originalBytes);
    assertPdfSize(modifiedBytes);
    if (originalBytes > MAX_PDF_BYTES - modifiedBytes) {
        throw new Error('PDF diff exceeds the 512 MiB combined safety limit.');
    }
}
