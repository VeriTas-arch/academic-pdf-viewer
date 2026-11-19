"use strict";

type RangeLoadMessage = Extract<AcademicExtensionToWebviewMessage, { type: "document.loadRange" }>;

interface PdfRangeTransport {
    requestDataRange(begin: number, end: number): void;
    onDataRange(begin: number, chunk: Uint8Array): void;
    abort(): void;
}

interface Window {
    createAcademicPdfRangeTransport(
        message: RangeLoadMessage,
        onFailure: (error: unknown) => void,
    ): { range: PdfRangeTransport; setSearchPrefetch(enabled: boolean): void };
}

(function () {
    const chunkBytes = 64 * 1024;
    const frameBytes = 512 * 1024;
    const concurrency = 4;
    const maxPrefetchedChunks = 64;
    const timeoutMs = 30_000;

    interface ReadRequest {
        begin: number;
        length: number;
        resolve(data: ArrayBuffer): void;
        reject(error: Error): void;
        timeout?: number;
    }

    window.createAcademicPdfRangeTransport = (message, onFailure) => {
        const { size, loadId } = message;
        const range = new pdfjsLib.PDFDataRangeTransport(size, new Uint8Array(message.data), true, message.filename);
        let closed = false;
        let searchPrefetch = false;
        let nextRequestId = 1;
        const waiting: ReadRequest[] = [];
        const pending = new Map<number, ReadRequest>();
        const prefetched = new Map<number, Uint8Array>();
        const supplied = new Set([0]);
        const prefetching = new Set<number>();
        const { post, subscribe } = window.academicExtensionMessages;

        const unsubscribe = subscribe(response => {
            if ((response.type !== "document.rangeData" && response.type !== "document.rangeError")
                || response.loadId !== loadId) {
                return;
            }
            if (response.type === "document.rangeError") {
                fail(new Error("Could not read the PDF. Reload the PDF to try again."));
                return;
            }
            const request = pending.get(response.requestId);
            if (!request) {
                return;
            }
            if (request.length !== response.data.byteLength) {
                fail(new Error("The PDF range was incomplete."));
                return;
            }
            window.clearTimeout(request.timeout);
            pending.delete(response.requestId);
            request.resolve(response.data);
            pump();
        });

        function close(): void {
            if (closed) {
                return;
            }
            closed = true;
            unsubscribe();
            const error = new Error("PDF range transport closed.");
            for (const request of [...pending.values(), ...waiting]) {
                window.clearTimeout(request.timeout);
                request.reject(error);
            }
            waiting.length = 0;
            pending.clear();
            prefetched.clear();
            post({ type: "document.rangeClose", loadId });
        }

        function fail(error: unknown): void {
            if (!closed) {
                close();
                onFailure(error);
            }
        }

        function pump(): void {
            while (!closed && waiting.length && pending.size < concurrency) {
                const request = waiting.shift()!;
                const requestId = nextRequestId++;
                request.timeout = window.setTimeout(() => fail(new Error("PDF range request timed out.")), timeoutMs);
                pending.set(requestId, request);
                post({ type: "document.rangeRequest", loadId, requestId, begin: request.begin, length: request.length });
            }
        }

        function read(begin: number, length: number): Promise<ArrayBuffer> {
            return new Promise((resolve, reject) => {
                if (closed) {
                    reject(new Error("PDF range transport closed."));
                    return;
                }
                waiting.push({ begin, length, resolve, reject });
                pump();
            });
        }

        async function readRange(begin: number, end: number): Promise<Uint8Array> {
            if (!Number.isSafeInteger(begin) || begin < 0 || !Number.isSafeInteger(end) || end <= begin || end > size) {
                throw new Error("PDF.js requested an invalid file range.");
            }
            if (!searchPrefetch && !prefetched.size && end - begin <= frameBytes) {
                const data = await read(begin, end - begin);
                for (let at = begin; at < end; at += chunkBytes) {
                    supplied.add(at);
                }
                return new Uint8Array(data);
            }
            const result = new Uint8Array(end - begin);
            const fill = async (start: number, stop: number, allowPrefetch: boolean): Promise<void> => {
                let offset = start;
                while (offset < stop) {
                    const cached = prefetched.get(offset);
                    if (cached) {
                        const count = Math.min(cached.length, stop - offset);
                        result.set(cached.subarray(0, count), offset - begin);
                        prefetched.delete(offset);
                        supplied.add(offset);
                        offset += count;
                        continue;
                    }

                    const canPrefetch = allowPrefetch && searchPrefetch && !pending.size && stop - offset <= chunkBytes
                        && offset % chunkBytes === 0;
                    const limit = Math.min(offset + frameBytes, canPrefetch ? size : stop);
                    let readEnd = Math.min(offset + chunkBytes, limit);
                    while (readEnd < limit && !prefetched.has(readEnd)
                        && (!canPrefetch || (!supplied.has(readEnd) && !prefetching.has(readEnd)))) {
                        readEnd = Math.min(readEnd + chunkBytes, limit);
                    }
                    for (let at = offset; at < readEnd; at += chunkBytes) {
                        prefetching.add(at);
                    }
                    const bytes = new Uint8Array(await read(offset, readEnd - offset));
                    const count = Math.min(bytes.length, stop - offset);
                    result.set(bytes.subarray(0, count), offset - begin);
                    for (let at = offset; at < readEnd; at += chunkBytes) {
                        prefetching.delete(at);
                        if (at < stop) {
                            supplied.add(at);
                        } else if (!closed && !supplied.has(at)) {
                            // Give cached chunks their own storage so the entry cap bounds retained bytes.
                            prefetched.set(at, bytes.slice(at - offset, at - offset + chunkBytes));
                        }
                    }
                    while (prefetched.size > maxPrefetchedChunks) {
                        prefetched.delete(prefetched.keys().next().value!);
                    }
                    offset += count;
                }
            };

            if (end - begin <= frameBytes) {
                await fill(begin, end, true);
            } else {
                let next = begin;
                const workers = Math.min(concurrency, Math.ceil((end - begin) / frameBytes));
                await Promise.all(Array.from({ length: workers }, async () => {
                    while (next < end) {
                        const start = next;
                        next = Math.min(next + frameBytes, end);
                        await fill(start, next, false);
                    }
                }));
            }
            return result;
        }

        range.requestDataRange = (begin, end) => {
            void readRange(begin, end).then(data => {
                if (!closed) {
                    range.onDataRange(begin, data);
                }
            }).catch(fail);
        };
        range.abort = close;
        return { range, setSearchPrefetch: enabled => { searchPrefetch = enabled; } };
    };
})();
