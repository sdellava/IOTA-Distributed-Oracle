import { IotaClient, IotaHTTPTransport } from "@iota/iota-sdk/client";
import { setting } from "./serviceLimits.js";
export function createBoundedFetch(options = {}) {
    const timeoutMs = options.timeoutMs ?? setting("WEBVIEW_UPSTREAM_TIMEOUT_MS", 15000, 120000);
    const maximum = options.concurrency ?? setting("WEBVIEW_UPSTREAM_CONCURRENCY", 32, 256);
    const maxBytes = options.maxBytes ?? setting("WEBVIEW_UPSTREAM_MAX_BYTES", 10000000, 50000000);
    const limit = options.rate ?? setting("WEBVIEW_UPSTREAM_PER_MINUTE", 1200, 100000);
    let active = 0;
    let count = 0;
    let windowEnd = 0;
    return (async (input, init) => {
        if (Date.now() >= windowEnd) {
            count = 0;
            windowEnd = Date.now() + 60000;
        }
        if (active >= maximum || ++count > limit)
            throw new Error("UPSTREAM_CAPACITY");
        active++;
        const timeout = AbortSignal.timeout(timeoutMs);
        const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
        try {
            const response = await (options.fetch ?? fetch)(input, { ...init, signal });
            const reader = response.body?.getReader();
            const chunks = [];
            let bytes = 0;
            try {
                if (Number(response.headers.get("content-length")) > maxBytes)
                    throw new Error("UPSTREAM_TOO_LARGE");
                if (reader)
                    for (;;) {
                        const chunk = await reader.read();
                        if (chunk.done)
                            break;
                        bytes += chunk.value.byteLength;
                        if (bytes > maxBytes)
                            throw new Error("UPSTREAM_TOO_LARGE");
                        chunks.push(chunk.value);
                    }
            }
            finally {
                await reader?.cancel().catch(() => { });
                reader?.releaseLock();
            }
            return new Response([204, 205, 304].includes(response.status) ? null : Buffer.concat(chunks), {
                status: response.status, statusText: response.statusText, headers: response.headers,
            });
        }
        catch (error) {
            if (signal.aborted)
                throw new Error("UPSTREAM_TIMEOUT");
            if (error instanceof Error && error.message === "UPSTREAM_TOO_LARGE")
                throw error;
            throw new Error("UPSTREAM_FAILED");
        }
        finally {
            active--;
        }
    });
}
export const boundedFetch = createBoundedFetch();
export const readClient = (url) => new IotaClient({ transport: new IotaHTTPTransport({ url, fetch: boundedFetch }) });
