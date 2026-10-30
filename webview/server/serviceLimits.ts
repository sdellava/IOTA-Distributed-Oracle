import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { auditFileFromEnv } from "./auditFile.js";

export function setting(name: string, fallback: number, maximum: number) {
  const text = process.env[name];
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
export function createServiceLimits(options: {
  readRate?: number; readsPerIp?: number; reads?: number; streamsPerIp?: number; streams?: number; streamAgeMs?: number;
  now?: () => number; emit?: (entry: object) => void; ipSalt?: string;
} = {}) {
  const now = options.now ?? Date.now;
  const emit = options.emit ?? auditFileFromEnv().emit;
  const salt = options.ipSalt ?? (process.env.WEBVIEW_AUDIT_IP_SALT?.trim() || randomBytes(32).toString("hex"));
  const rate = options.readRate ?? setting("WEBVIEW_READS_PER_MINUTE", 240, 10000);
  const perIp = options.readsPerIp ?? setting("WEBVIEW_READ_CONCURRENCY_PER_IP", 8, 128);
  const maximum = options.reads ?? setting("WEBVIEW_READ_CONCURRENCY", 64, 512);
  const streamsPerIp = options.streamsPerIp ?? setting("WEBVIEW_STREAMS_PER_IP", 4, 32);
  const maxStreams = options.streams ?? setting("WEBVIEW_STREAMS", 64, 512);
  const streamAgeMs = options.streamAgeMs ?? setting("WEBVIEW_STREAM_MAX_AGE_MS", 300000, 3600000);
  const rates = new Map<string, { count: number; until: number }>();
  const reads = new Map<string, number>(); const streams = new Map<string, number>();
  let totalReads = 0; let totalStreams = 0;
  function middleware(req: Request, res: Response, next: NextFunction) {
    const path = req.path.toLowerCase().replace(/\/+$/, "");
    if (!path.startsWith("/api/")) { next(); return; }
    const start = now(); const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const requestId = randomUUID(); res.setHeader("X-Request-ID", requestId);
    let logged = false;
    const audit = () => {
      if (logged || path === "/api/health") return; logged = true;
      const known = /^\/api\/(auth\/(challenge|verify|logout)|tasks\/(prepare-wallet|prepare-task-schedule-wallet|execute)|task-schedules(?:\/prepare-action-wallet)?|node-management\/(prepare-wallet|prepare-approve-wallet)|status|network|examples|legal\/eula|market\/iota-price)$/;
      const route = known.test(path) ? path : /^\/api\/task\/[^/]+(?:\/(events|stream))?$/.test(path)
        ? `/api/task/:taskId${path.endsWith("/stream") ? "/stream" : path.endsWith("/events") ? "/events" : ""}`
        : /^\/api\/examples\/[^/]+$/.test(path) ? "/api/examples/:name" : "/api/unknown";
      emit({ schema: "oracle.audit.v1", timestamp: new Date(start).toISOString(), requestId,
        event: "http_request", method: req.method.length <= 16 ? req.method : "OTHER", route, status: res.writableFinished ? res.statusCode : 499,
        durationMs: Math.max(0, now() - start), client: createHash("sha256").update(salt + ip).digest("hex").slice(0, 24),
        ...(res.locals.auditIdentity ?? {}), ...(res.locals.auditCode ? { code: res.locals.auditCode } : {}) });
    };
    res.once("finish", audit); res.once("close", audit);
    if (!["GET", "HEAD"].includes(req.method) || path === "/api/health") { next(); return; }
    for (const [key, value] of rates) if (value.until <= now()) rates.delete(key);
    let counter = rates.get(ip);
    if (!counter && rates.size < 10000) { counter = { count: 0, until: now() + 60000 }; rates.set(ip, counter); }
    const stream = /^\/api\/task\/[^/]+\/stream$/.test(path);
    const deny = () => { res.locals.auditCode = "READ_CAPACITY"; res.setHeader("Retry-After", "60"); res.status(429).json({ error: "READ_CAPACITY" }); };
    if (!counter || ++counter.count > rate) { deny(); return; }
    const counts = stream ? streams : reads;
    if ((counts.get(ip) ?? 0) >= (stream ? streamsPerIp : perIp) || (stream ? totalStreams >= maxStreams : totalReads >= maximum)) { deny(); return; }
    counts.set(ip, (counts.get(ip) ?? 0) + 1);
    if (stream) totalStreams++; else totalReads++;
    let released = false;
    const release = () => {
      if (released) return; released = true;
      const count = (counts.get(ip) ?? 1) - 1;
      if (count) counts.set(ip, count); else counts.delete(ip);
      if (stream) totalStreams--; else totalReads--;
    };
    res.locals.releaseRead = release;
    res.once("finish", () => { if (!res.locals.readOperationStarted) release(); });
    res.once("close", () => { if (!res.locals.readOperationStarted) release(); });
    next();
  }
  function read(handler: (req: Request, res: Response) => unknown) {
    return async (req: Request, res: Response, next: NextFunction) => {
      res.locals.readOperationStarted = true;
      try { await handler(req, res); } catch (error) { next(error); }
      finally { res.locals.releaseRead?.(); }
    };
  }
  return { middleware, read, streamAgeMs };
}
