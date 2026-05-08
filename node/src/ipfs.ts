// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

type IpfsConfig = {
  enabled: boolean;
  apiUrl: string;
  pin: boolean;
  cidVersion: number;
  deleteMode: "pin-rm" | "none";
  runRepoGc: boolean;
  apiKey?: string;
  apiSecret?: string;
  basicUser?: string;
  basicPass?: string;
  bearerToken?: string;
};

function trim(v: string | undefined | null): string | undefined {
  const t = String(v ?? "").trim();
  return t || undefined;
}

function optBool(name: string, def = false): boolean {
  const v = trim(process.env[name]);
  if (!v) return def;
  const x = v.toLowerCase();
  return v === "1" || x === "true" || x === "yes";
}

function optInt(name: string, def: number): number {
  const v = trim(process.env[name]);
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.floor(n);
}

export function getIpfsConfig(): IpfsConfig {
  const apiUrl = trim(process.env.IPFS_API_URL) ?? "";
  return {
    enabled: optBool("IPFS_ENABLED", false) && apiUrl.length > 0,
    apiUrl,
    pin: optBool("IPFS_PIN", true),
    cidVersion: optInt("IPFS_CID_VERSION", 1),
    deleteMode: (trim(process.env.IPFS_DELETE_MODE)?.toLowerCase() === "none" ? "none" : "pin-rm"),
    runRepoGc: optBool("IPFS_RUN_REPO_GC", false),
    apiKey: trim(process.env.IPFS_API_KEY),
    apiSecret: trim(process.env.IPFS_API_SECRET),
    basicUser: trim(process.env.IPFS_BASIC_AUTH_USER),
    basicPass: trim(process.env.IPFS_BASIC_AUTH_PASS),
    bearerToken: trim(process.env.IPFS_BEARER_TOKEN),
  };
}

function buildHeaders(cfg: IpfsConfig): Headers {
  const headers = new Headers();

  if (cfg.bearerToken) {
    headers.set("Authorization", `Bearer ${cfg.bearerToken}`);
  } else if (cfg.basicUser || cfg.basicPass) {
    const token = Buffer.from(`${cfg.basicUser ?? ""}:${cfg.basicPass ?? ""}`).toString("base64");
    headers.set("Authorization", `Basic ${token}`);
  }

  if (cfg.apiKey) headers.set("x-api-key", cfg.apiKey);
  if (cfg.apiSecret) headers.set("x-api-secret", cfg.apiSecret);

  return headers;
}

function toSafeArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

export async function uploadBytesToIpfs(args: {
  bytes: Uint8Array;
  fileName?: string | null;
  mimeType?: string | null;
}): Promise<{ cid: string; size: number; name: string }> {
  const cfg = getIpfsConfig();
  if (!cfg.enabled) throw new Error("IPFS is disabled");

  const name = trim(args.fileName) ?? "payload.bin";
  const mimeType = trim(args.mimeType) ?? "application/octet-stream";

  const form = new FormData();
  const blobData = toSafeArrayBuffer(args.bytes);
  form.append("file", new Blob([blobData], { type: mimeType }), name);

  const url = new URL(`${cfg.apiUrl.replace(/\/$/, "")}/api/v0/add`);
  url.searchParams.set("pin", cfg.pin ? "true" : "false");
  url.searchParams.set("cid-version", String(cfg.cidVersion));
  url.searchParams.set("wrap-with-directory", "false");
  url.searchParams.set("quieter", "true");

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(cfg),
    body: form,
  });

  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`IPFS add failed: HTTP ${res.status} ${res.statusText} - ${bodyText.slice(0, 400)}`);
  }

  const lines = bodyText
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

  if (lines.length === 0) {
    throw new Error("IPFS add returned empty body");
  }

  let parsed: Record<string, unknown> | null = null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const candidate = JSON.parse(lines[i]) as unknown;
      if (candidate && typeof candidate === "object") {
        parsed = candidate as Record<string, unknown>;
        break;
      }
    } catch {
      // ignore
    }
  }

  if (!parsed) {
    throw new Error(`IPFS add returned non-JSON body: ${bodyText.slice(0, 400)}`);
  }

  const cid = String(parsed.Hash ?? parsed.Cid ?? parsed.cid ?? "").trim();
  const rawSize = parsed.Size ?? parsed.size ?? args.bytes.byteLength;
  const size = Number(rawSize);
  const returnedName = String(parsed.Name ?? name).trim() || name;

  if (!cid) {
    throw new Error(`IPFS add response missing CID: ${bodyText.slice(0, 400)}`);
  }

  return {
    cid,
    size: Number.isFinite(size) ? size : args.bytes.byteLength,
    name: returnedName,
  };
}

export async function pinCidToIpfs(args: {
  cid: string;
}): Promise<{ cid: string; pinned: boolean }> {
  const cfg = getIpfsConfig();
  if (!cfg.enabled) throw new Error("IPFS is disabled");

  const cid = String(args.cid ?? "").trim();
  if (!cid) throw new Error("Missing IPFS cid");

  const url = new URL(`${cfg.apiUrl.replace(/\/$/, "")}/api/v0/pin/add`);
  url.searchParams.set("arg", cid);
  url.searchParams.set("recursive", "true");

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(cfg),
  });

  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`IPFS pin/add failed: HTTP ${res.status} ${res.statusText} - ${bodyText.slice(0, 400)}`);
  }

  return { cid, pinned: true };
}


export async function deleteCidFromIpfs(args: {
  cid: string;
  allowMissing?: boolean;
}): Promise<{ deleted: boolean; mode: "pin-rm" | "none" }> {
  const cfg = getIpfsConfig();
  if (!cfg.enabled) throw new Error("IPFS is disabled");

  const cid = String(args.cid ?? "").trim();
  if (!cid) throw new Error("Missing IPFS cid");
  if (cfg.deleteMode === "none") return { deleted: false, mode: cfg.deleteMode };

  const url = new URL(`${cfg.apiUrl.replace(/\/$/, "")}/api/v0/pin/rm`);
  url.searchParams.set("arg", cid);
  url.searchParams.set("recursive", "true");

  const res = await fetch(url, {
    method: "POST",
    headers: buildHeaders(cfg),
  });

  const bodyText = await res.text();

  if (!res.ok) {
    const msg = bodyText.slice(0, 400);
    if (args.allowMissing && /not pinned|is not pinned|cannot remove non-pinned/i.test(msg)) {
      return { deleted: false, mode: cfg.deleteMode };
    }
    throw new Error(`IPFS pin/rm failed: HTTP ${res.status} ${res.statusText} - ${msg}`);
  }

  if (cfg.runRepoGc) {
    const gcUrl = new URL(`${cfg.apiUrl.replace(/\/$/, "")}/api/v0/repo/gc`);
    gcUrl.searchParams.set("stream-errors", "true");
    try {
      await fetch(gcUrl, { method: "POST", headers: buildHeaders(cfg) });
    } catch {
      // best effort
    }
  }

  return { deleted: true, mode: cfg.deleteMode };
}
