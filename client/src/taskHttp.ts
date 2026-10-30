// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix, "ipv4");
blocked.addAddress("168.63.129.16", "ipv4"); // Azure platform virtual IP.
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(address, prefix, "ipv6");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export class TaskHttpError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "TaskHttpError"; }
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  // Only native global unicast: excludes mapped IPv4, NAT64, ULA and link-local.
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function parseTaskUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new TaskHttpError("TASK_URL_INVALID"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new TaskHttpError("TASK_URL_FORBIDDEN");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  const deniedHosts = String(process.env.TASK_HTTP_DENIED_HOSTS ?? "").split(",")
    .map((entry) => entry.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  if (deniedHosts.some((entry) => normalizedHost === entry || normalizedHost.endsWith(`.${entry}`))) {
    throw new TaskHttpError("TASK_DESTINATION_FORBIDDEN");
  }
  const allowedHosts = String(process.env.TASK_HTTP_ALLOWED_HOSTS ?? "").split(",")
    .map(entry => entry.trim().toLowerCase().replace(/\.$/, "")).filter(Boolean);
  if (allowedHosts.length && !allowedHosts.some(entry => entry.startsWith("*.")
    ? normalizedHost.endsWith(`.${entry.slice(2)}`) : normalizedHost === entry)) {
    throw new TaskHttpError("TASK_DESTINATION_FORBIDDEN");
  }
  const allowedPorts = String(process.env.TASK_HTTP_ALLOWED_PORTS ?? "").split(",").map(entry => entry.trim()).filter(Boolean);
  if (allowedPorts.some(entry => !/^\d+$/.test(entry) || Number(entry) < 1 || Number(entry) > 65535)) throw new TaskHttpError("TASK_POLICY_INVALID");
  if (allowedPorts.length && !allowedPorts.some(entry => Number(entry) === Number(url.port || (url.protocol === "https:" ? 443 : 80)))) {
    throw new TaskHttpError("TASK_PORT_FORBIDDEN");
  }
  if (isIP(host) ? !isPublicAddress(host) : (!normalizedHost.includes(".") || /\.(localhost|local|internal|lan|home|test|invalid)$/i.test(normalizedHost))) {
    throw new TaskHttpError("TASK_DESTINATION_FORBIDDEN");
  }
  url.hash = "";
  return url;
}

type Address = { address: string; family: number };
export function pinnedLookup(addresses: Address[]) {
  return (_hostname: string, options: any, callback: any) => {
    const family = typeof options === "number" ? options : options?.family;
    const candidates = addresses.filter((item) => !family || item.family === family);
    if (!candidates.length) return callback(new TaskHttpError("TASK_DNS_FAILED"));
    if (options?.all) callback(null, candidates);
    else callback(null, candidates[0].address, candidates[0].family);
  };
}

type Options = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  headersOnly?: boolean;
};

// Injectable dependencies support offline tests, never task-controlled configuration.
export function createTaskHttpClient(deps = { lookup, fetch: undiciFetch }) {
  return async (opts: Options): Promise<{ bytes: Buffer; contentType: string | null; contentLength: string | null; contentRange: string | null }> => {
    let url = parseTaskUrl(opts.url);
    const method = String(opts.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new TaskHttpError("TASK_METHOD_FORBIDDEN");
    const headers = new Headers(opts.headers);
    for (const name of headers.keys()) {
      if (["host", "connection", "transfer-encoding", "content-length", "upgrade", "te", "trailer", "expect"].includes(name) || name.startsWith("proxy-") || name.startsWith("sec-")) {
        throw new TaskHttpError("TASK_HEADER_FORBIDDEN");
      }
    }
    const limit = (n: number | undefined, fallback: number) => typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), fallback) : fallback;
    const timeout = limit(opts.timeoutMs, 30_000);
    const maxBytes = limit(opts.maxBytes, 25_000_000);
    const controller = new AbortController();
    let deadline: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => { controller.abort(); reject(new TaskHttpError("TASK_FETCH_TIMEOUT")); }, timeout);
    });
    try {
      for (let hop = 0; hop <= 5; hop++) {
        const host = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(host)
          ? [{ address: host, family: isIP(host) }]
          : await Promise.race([deps.lookup(host, { all: true }), expired]);
        if (!addresses.length || addresses.some((item) => !isPublicAddress(item.address))) {
          throw new TaskHttpError("TASK_DESTINATION_FORBIDDEN");
        }
        // Pin the validated DNS answer to this connection; preserve hostname for TLS/SNI.
        const dispatcher = new Agent({ connect: { lookup: pinnedLookup(addresses), rejectUnauthorized: true } });
        try {
          const res = await Promise.race([deps.fetch(url, {
            method, headers: Object.fromEntries(headers), redirect: "manual",
            signal: controller.signal, dispatcher,
          }), expired]);
          if ([301, 302, 303, 307, 308].includes(res.status)) {
            const location = res.headers.get("location");
            await res.body?.cancel();
            if (!location || hop === 5) throw new TaskHttpError("TASK_REDIRECT_LIMIT");
            const next = parseTaskUrl(new URL(location, url).href);
            if (url.protocol === "https:" && next.protocol !== "https:") throw new TaskHttpError("TASK_REDIRECT_FORBIDDEN");
            if (next.origin !== url.origin) for (const key of [...headers.keys()]) headers.delete(key);
            url = next;
            continue;
          }
          if (!res.ok) { await res.body?.cancel(); throw new TaskHttpError(`TASK_HTTP_${res.status}`); }
          const metadata = { contentType: res.headers.get("content-type"), contentLength: res.headers.get("content-length"), contentRange: res.headers.get("content-range") };
          if (opts.headersOnly) {
            await res.body?.cancel();
            return { bytes: Buffer.alloc(0), ...metadata };
          }
          if (Number(res.headers.get("content-length")) > maxBytes) {
            await res.body?.cancel(); throw new TaskHttpError("TASK_DOWNLOAD_TOO_LARGE");
          }
          const chunks: Buffer[] = [];
          let size = 0;
          const reader = res.body?.getReader();
          if (reader) {
            try {
              for (;;) {
                const chunk = await Promise.race([reader.read(), expired]);
                if (chunk.done) break;
                size += chunk.value.byteLength;
                if (size > maxBytes) throw new TaskHttpError("TASK_DOWNLOAD_TOO_LARGE");
                chunks.push(Buffer.from(chunk.value));
              }
            } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          }
          return { bytes: Buffer.concat(chunks, size), ...metadata };
        } finally { await dispatcher.destroy(); }
      }
      throw new TaskHttpError("TASK_REDIRECT_LIMIT");
    } catch (error) {
      if (error instanceof TaskHttpError) throw error;
      throw new TaskHttpError(controller.signal.aborted ? "TASK_FETCH_TIMEOUT" : "TASK_FETCH_FAILED");
    } finally { clearTimeout(deadline!); }
  };
}

export const fetchTaskBytes = createTaskHttpClient();
