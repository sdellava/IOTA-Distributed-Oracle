import { createTaskHttpClient, TaskHttpError } from "./taskHttp.js";

// Same transport policy as node/src/taskHttp.ts; packaged here so the CLI is standalone.
export function createStorageProbe(request = createTaskHttpClient()) {
  return async (task: any): Promise<bigint> => {
    const url = typeof task?.source?.url === "string" ? task.source.url.trim() : "";
    const headers: Record<string, string> = {};
    if (task?.source?.headers && typeof task.source.headers === "object") {
      for (const [name, value] of Object.entries(task.source.headers)) {
        if (typeof value === "string" && name.trim()) headers[name] = value;
      }
    }
    const raw = Number(task?.timeouts?.step1Ms ?? task?.timeouts?.storageProbeMs ??
      task?.storage?.probe_timeout_ms ?? task?.storage?.probeTimeoutMs ?? process.env.STORAGE_PROBE_TIMEOUT_MS ?? 15000);
    const budget = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(1, Math.floor(raw)), 30000) : 15000;
    const deadline = Date.now() + budget;
    for (const method of ["HEAD", "GET"] as const) {
      const timeoutMs = deadline - Date.now();
      if (timeoutMs <= 0) throw new TaskHttpError("TASK_FETCH_TIMEOUT");
      try {
        const result = await request({ url, method, headers: method === "GET" ? { ...headers, Range: "bytes=0-0" } : headers,
          timeoutMs, headersOnly: true });
        const match = result.contentRange?.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
        const size = match?.[1] ?? result.contentLength;
        if (size && /^\d+$/.test(size)) return BigInt(size);
      } catch (error) {
        // HEAD is not supported by every storage host. Policy failures never fall back.
        if (!(error instanceof TaskHttpError) || !/^(TASK_HTTP_\d+|TASK_FETCH_FAILED)$/.test(error.code)) throw error;
      }
    }
    throw new TaskHttpError("TASK_STORAGE_LENGTH_UNAVAILABLE");
  };
}

export const probeStorageContentLength = createStorageProbe();
