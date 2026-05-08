// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createHash } from "node:crypto";
import path from "node:path";

import { Agent } from "undici";

import { uploadBytesToIpfs, getIpfsConfig, pinCidToIpfs } from "../../ipfs";
import type { TaskHandler } from "../types";
import { normalizeJsonCanonical } from "../utils/json";

const ipv4Agent = new Agent({ connect: { family: 4 } as any });

function pickString(values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function pickNumber(values: unknown[], def = 0): number {
  for (const v of values) {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return def;
}

function sanitizeSegment(input: string, fallback: string): string {
  const s = String(input ?? "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || fallback;
}

function inferExt(fileName: string | null, mimeType: string, isJson: boolean, isText: boolean): string {
  if (fileName) {
    const ext = path.extname(fileName).trim();
    if (ext && ext.length <= 10) return ext.toLowerCase();
  }
  if (isJson) return ".json";
  if (mimeType === "text/plain") return ".txt";
  if (mimeType === "text/html") return ".html";
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType.startsWith("image/")) return `.${mimeType.slice("image/".length)}`;
  return ".bin";
}

function decodeBase64(s: string): Buffer {
  try {
    return Buffer.from(s, "base64");
  } catch (e: any) {
    throw new Error(`Invalid STORAGE base64 payload: ${String(e?.message ?? e)}`);
  }
}

type ResolvedContent = {
  bytes: Buffer;
  mimeType: string;
  originalFileName: string | null;
  retentionDays: number;
  source: string;
  sourceUrl?: string | null;
  expectedSha256?: string | null;
  maxAllowedBytes?: number | null;
};

function ensureAllowedUrl(url: string): string {
  const trimmed = String(url ?? "").trim();
  if (!/^https?:\/\//i.test(trimmed)) throw new Error(`Invalid STORAGE source.url: ${trimmed}`);
  return trimmed;
}

async function reusablePreviousStorageResult(previousResult?: string | null): Promise<string | null> {
  if (!previousResult) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(previousResult);
  } catch {
    return null;
  }

  if (parsed?.schema !== "storage-result-v2" || parsed?.task_type !== "STORAGE") return null;
  if (typeof parsed?.ipfs_cid !== "string" || !parsed.ipfs_cid.trim()) return null;
  if (parsed?.persisted !== true || parsed?.ipfs_enabled !== true) return null;

  try {
    await pinCidToIpfs({ cid: parsed.ipfs_cid });
  } catch (e: any) {
    console.warn(`STORAGE previous CID pin failed, falling back to source.url download: ${String(e?.message ?? e)}`);
    return null;
  }

  return normalizeJsonCanonical(parsed, { canonical: true, dropNulls: false, sortArrays: false });
}

function normalizeHeaders(input: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!input || typeof input !== "object") return out;

  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    const key = String(k ?? "").trim();
    if (!key || v == null) continue;
    const value = String(v).trim();
    if (!value) continue;
    out[key] = value;
  }

  return out;
}

function buildBrowserLikeHeaders(url: string, extra: Record<string, string> = {}): Record<string, string> {
  const u = new URL(url);

  return {
    "User-Agent":
      process.env.STORAGE_FETCH_USER_AGENT?.trim() ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: `${u.protocol}//${u.host}/`,
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    "Upgrade-Insecure-Requests": "1",
    ...extra,
  };
}

async function readErrorSnippet(res: Response): Promise<string> {
  try {
    const text = (await res.text()).replace(/\s+/g, " ").trim();
    return text.slice(0, 300);
  } catch {
    return "";
  }
}

async function fetchUrlBytes(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ bytes: Buffer; mimeType?: string | null }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const customHeaders = normalizeHeaders(headers);
    const browserHeaders = buildBrowserLikeHeaders(url, customHeaders);

    const attempts: Array<{
      name: string;
      headers: Record<string, string>;
      dispatcher?: any;
    }> = [
      { name: "custom", headers: customHeaders },
      { name: "custom-ipv4", headers: customHeaders, dispatcher: ipv4Agent },
      { name: "browser-like", headers: browserHeaders },
      { name: "browser-like-ipv4", headers: browserHeaders, dispatcher: ipv4Agent },
    ];

    let lastError: Error | null = null;

    for (const attempt of attempts) {
      try {
        const res = await fetch(url, {
          method: "GET",
          headers: attempt.headers,
          redirect: "follow",
          signal: ac.signal,
          dispatcher: attempt.dispatcher,
        } as any);

        if (!res.ok) {
          const snippet = await readErrorSnippet(res);
          lastError = new Error(
            `HTTP ${res.status} ${res.statusText} [${attempt.name}]${snippet ? ` - ${snippet}` : ""}`,
          );
          continue;
        }

        const contentLengthHeader = res.headers.get("content-length");
        if (contentLengthHeader) {
          const contentLength = Number(contentLengthHeader);
          if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            throw new Error(`STORAGE download too large: ${contentLength} bytes > limit ${maxBytes}`);
          }
        }

        const ab = await res.arrayBuffer();
        const bytes = Buffer.from(ab);

        if (bytes.length > maxBytes) {
          throw new Error(`STORAGE download too large: ${bytes.length} bytes > limit ${maxBytes}`);
        }

        return {
          bytes,
          mimeType: res.headers.get("content-type"),
        };
      } catch (e: any) {
        lastError = new Error(`${attempt.name}: ${String(e?.message ?? e)}`);
      }
    }

    throw lastError ?? new Error("STORAGE download failed");
  } finally {
    clearTimeout(t);
  }
}

async function resolvePayloadContent(payload: any): Promise<ResolvedContent> {
  const originalFileName = pickString([payload?.fileName, payload?.filename, payload?.name]);

  const explicitMime = pickString([payload?.mimeType, payload?.mime_type, payload?.contentType, payload?.content_type]);
  const retentionDays = Math.max(
    0,
    pickNumber(
      [
        payload?.retentionDays,
        payload?.retention_days,
        payload?.storage?.retentionDays,
        payload?.storage?.retention_days,
      ],
      0,
    ),
  );
  const expectedSha256 = pickString([payload?.expectedSha256, payload?.expected_sha256]);

  const maxAllowedBytes = pickNumber(
    [
      payload?.maxAllowedBytes,
      payload?.max_allowed_bytes,
      payload?.source?.maxBytes,
      payload?.source?.max_bytes,
      payload?.maxBytes,
      payload?.max_bytes,
      payload?.expectedSizeBytes,
      payload?.expected_size_bytes,
      process.env.STORAGE_MAX_DOWNLOAD_BYTES,
    ],
    -1,
  );

  const sourceUrl = pickString([payload?.source?.url, payload?.url, payload?.sourceUrl, payload?.source_url]);
  if (sourceUrl) {
    const url = ensureAllowedUrl(sourceUrl);
    const method = String(payload?.source?.method ?? payload?.method ?? "GET")
      .trim()
      .toUpperCase();
    if (method !== "GET") throw new Error(`Invalid STORAGE source.method: ${method}. Only GET is supported.`);
    const headers = normalizeHeaders(payload?.source?.headers);
    const timeoutMs = Math.max(
      1_000,
      pickNumber(
        [payload?.source?.timeoutMs, payload?.source?.timeout_ms, process.env.STORAGE_FETCH_TIMEOUT_MS],
        30_000,
      ),
    );
    const fetchMaxBytes = Math.max(
      1_024,
      pickNumber(
        [payload?.source?.maxBytes, payload?.source?.max_bytes, process.env.STORAGE_MAX_DOWNLOAD_BYTES],
        25_000_000,
      ),
    );
    const fetched = await fetchUrlBytes(url, headers, timeoutMs, fetchMaxBytes);
    return {
      bytes: fetched.bytes,
      mimeType:
        explicitMime || (fetched.mimeType ? String(fetched.mimeType).split(";")[0].trim() : "application/octet-stream"),
      originalFileName,
      retentionDays,
      source: "url",
      sourceUrl: url,
      expectedSha256,
      maxAllowedBytes: maxAllowedBytes >= 0 ? maxAllowedBytes : null,
    };
  }

  const b64 = pickString([
    payload?.contentBase64,
    payload?.content_base64,
    payload?.bytesBase64,
    payload?.bytes_base64,
    payload?.dataBase64,
    payload?.data_base64,
  ]);
  if (b64) {
    return {
      bytes: decodeBase64(b64),
      mimeType: explicitMime || "application/octet-stream",
      originalFileName,
      retentionDays,
      source: "base64",
      expectedSha256,
      maxAllowedBytes: maxAllowedBytes >= 0 ? maxAllowedBytes : null,
    };
  }

  const text = pickString([
    payload?.contentText,
    payload?.content_text,
    payload?.text,
    typeof payload?.data === "string" ? payload.data : null,
    typeof payload?.raw === "string" ? payload.raw : null,
  ]);
  if (text != null) {
    return {
      bytes: Buffer.from(text, "utf8"),
      mimeType: explicitMime || "text/plain",
      originalFileName,
      retentionDays,
      source: "text",
      expectedSha256,
      maxAllowedBytes: maxAllowedBytes >= 0 ? maxAllowedBytes : null,
    };
  }

  if (payload?.json != null) {
    const normalized = normalizeJsonCanonical(payload.json, { canonical: true, dropNulls: false, sortArrays: false });
    return {
      bytes: Buffer.from(normalized, "utf8"),
      mimeType: explicitMime || "application/json",
      originalFileName,
      retentionDays,
      source: "json",
      expectedSha256,
      maxAllowedBytes: maxAllowedBytes >= 0 ? maxAllowedBytes : null,
    };
  }

  if (payload?.data != null && typeof payload.data === "object") {
    const normalized = normalizeJsonCanonical(payload.data, { canonical: true, dropNulls: false, sortArrays: false });
    return {
      bytes: Buffer.from(normalized, "utf8"),
      mimeType: explicitMime || "application/json",
      originalFileName,
      retentionDays,
      source: "data_object",
      expectedSha256,
      maxAllowedBytes: maxAllowedBytes >= 0 ? maxAllowedBytes : null,
    };
  }

  throw new Error(
    "Invalid STORAGE payload: provide source.url for remote download, or one of contentBase64/contentText/json/data.",
  );
}

export const handleStorage: TaskHandler = async ({
  payload,
  taskId,
  retentionDays: ctxRetentionDays,
  previousResult,
}) => {
  const reused = await reusablePreviousStorageResult(previousResult);
  if (reused) return reused;

  const content = await resolvePayloadContent(payload ?? {});
  const actualBytes = content.bytes.length;
  const effectiveRetentionDays = Math.max(0, Number(ctxRetentionDays ?? content.retentionDays ?? 0) || 0);

  const contentHash = createHash("sha256").update(content.bytes).digest("hex");

  if (content.expectedSha256 && content.expectedSha256.toLowerCase() !== contentHash.toLowerCase()) {
    throw new Error(`STORAGE sha256 mismatch: expected ${content.expectedSha256}, got ${contentHash}`);
  }

  if (content.maxAllowedBytes != null && content.maxAllowedBytes >= 0 && actualBytes > content.maxAllowedBytes) {
    throw new Error(`STORAGE size exceeds max allowed: actual=${actualBytes}, max=${content.maxAllowedBytes}`);
  }

  const isJson = content.mimeType === "application/json";
  const isText = content.mimeType.startsWith("text/");
  const ext = inferExt(content.originalFileName, content.mimeType, isJson, isText);
  const fileBase = sanitizeSegment(
    content.originalFileName
      ? path.basename(content.originalFileName, path.extname(content.originalFileName))
      : "payload",
    "payload",
  );
  const uploadFileName = `${fileBase}-${contentHash.slice(0, 16)}${ext}`;

  const ipfsCfg = getIpfsConfig();
  if (!ipfsCfg.enabled) {
    throw new Error("IPFS is required for STORAGE tasks: local retention has been removed.");
  }
  const uploaded = await uploadBytesToIpfs({
    bytes: content.bytes,
    fileName: content.originalFileName ?? uploadFileName,
    mimeType: content.mimeType,
  });

  const consensusResult = {
    schema: "storage-result-v2",
    task_type: "STORAGE",
    source: content.source,
    source_url: content.sourceUrl ?? null,
    storage_key: `${sanitizeSegment(taskId ?? String(payload?.taskId ?? "task-unknown"), "task-unknown")}/${contentHash}`,
    content_sha256: contentHash,
    bytes: actualBytes,
    mime_type: content.mimeType,
    file_name: content.originalFileName,
    retention_days: effectiveRetentionDays,
    ipfs_enabled: true,
    ipfs_cid: uploaded.cid,
    persisted: true,
  };

  return normalizeJsonCanonical(consensusResult, { canonical: true, dropNulls: false, sortArrays: false });
};
