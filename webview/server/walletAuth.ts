import { createHash, randomBytes } from "node:crypto";
import type { Express, Request, Response, NextFunction } from "express";
import { verifyPersonalMessageSignature } from "@iota/iota-sdk/verify";
import { normalizeIotaAddress } from "@iota/iota-sdk/utils";

export const PREPARATION_ROUTES = new Set([
  "/api/tasks/prepare-wallet", "/api/tasks/prepare-task-schedule-wallet",
  "/api/task-schedules/prepare-action-wallet", "/api/node-management/prepare-wallet",
  "/api/node-management/prepare-approve-wallet", "/api/network",
]);
type Identity = { address: string; network: string; audience: string; origin: string | null; expiresAt: number };
type Challenge = Identity & { message: string };
export function walletAddress(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(value)) throw new Error("INVALID_WALLET");
  return normalizeIotaAddress(value);
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const opaque = () => randomBytes(32).toString("base64url");
// Express string routes also accept case variants and a trailing slash.
const routePath = (req: Request) => req.path.toLowerCase().replace(/\/+$/, "");

export function createWalletAuth(options: {
  networks: string[]; publicOrigin?: string; allowedOrigins?: string[];
  now?: () => number; challengeTtlMs?: number; sessionTtlMs?: number;
  maxEntries?: number; authLimit?: number; preparationLimit?: number; maxConcurrent?: number;
}) {
  const now = options.now ?? Date.now;
  const challenges = new Map<string, Challenge>();
  const sessions = new Map<string, Identity>();
  const counters = new Map<string, { count: number; until: number }>();
  const active = new Map<string, number>();
  const maxEntries = options.maxEntries ?? 10000;
  const challengeTtl = options.challengeTtlMs ?? 120000;
  const sessionTtl = options.sessionTtlMs ?? 900000;
  const configuredOrigin = options.publicOrigin ? new URL(options.publicOrigin).origin : undefined;
  const allowed = new Set((options.allowedOrigins ?? []).map(value => new URL(value).origin));
  function prune() {
    const time = now();
    for (const [key, value] of challenges) if (value.expiresAt <= time) challenges.delete(key);
    for (const [key, value] of sessions) if (value.expiresAt <= time) sessions.delete(key);
    for (const [key, value] of counters) if (value.until <= time) counters.delete(key);
  }
  function audience(req: Request): string {
    if (configuredOrigin) return configuredOrigin;
    const host = req.get("host") ?? "";
    if (!host || /[\s/@\\]/.test(host)) throw new Error("INVALID_HOST");
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
    return new URL(`${local ? "http" : "https"}://${host}`).origin;
  }
  function context(req: Request) {
    const service = audience(req);
    const raw = req.get("origin");
    const origin = raw ? new URL(raw).origin : null;
    if (raw && (origin !== raw || (origin !== service && !allowed.has(origin!)))) throw new Error("ORIGIN_FORBIDDEN");
    return { audience: service, origin };
  }
  function fail(res: Response, status: number, error: string) { res.status(status).json({ error }); }
  function take(key: string, limit: number): boolean {
    prune();
    let counter = counters.get(key);
    if (!counter) {
      if (counters.size >= maxEntries) return false;
      counter = { count: 0, until: now() + 60000 }; counters.set(key, counter);
    }
    return ++counter.count <= limit;
  }
  function limited(res: Response) { res.setHeader("Retry-After", "60"); fail(res, 429, "RATE_LIMITED"); }
  function identity(req: Request): Identity | undefined {
    const auth = req.get("authorization") ?? "";
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(auth);
    if (!match) return;
    const session = sessions.get(digest(match[1]));
    if (!session || session.expiresAt <= now()) return;
    const ctx = context(req);
    if (session.audience !== ctx.audience || session.origin !== ctx.origin) return;
    return session;
  }
  // Install before body parsing: reject bad origins and throttle signature work early.
  function perimeter(req: Request, res: Response, next: NextFunction) {
    const path = routePath(req);
    if (!path.startsWith("/api/")) { next(); return; }
    try {
      const ctx = context(req);
      if (ctx.origin) {
        res.setHeader("Access-Control-Allow-Origin", ctx.origin);
        res.vary("Origin");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      }
      if (req.method === "OPTIONS") { res.sendStatus(204); return; }
      if (path.startsWith("/api/auth/") || PREPARATION_ROUTES.has(path)) {
        res.setHeader("Cache-Control", "no-store");
        const isAuth = path.startsWith("/api/auth/");
        if (!take(`${isAuth ? "auth" : "prepare"}:ip:${req.ip ?? req.socket.remoteAddress ?? "unknown"}`,
          isAuth ? (options.authLimit ?? 30) : 120)) { limited(res); return; }
      }
      next();
    } catch { fail(res, 403, "ORIGIN_FORBIDDEN"); }
  }
  function install(app: Express) {
    app.post("/api/auth/challenge", (req, res) => {
      try {
        const address = walletAddress(req.body?.address);
        const network = req.body?.network;
        if (typeof network !== "string" || !options.networks.includes(network)) { fail(res, 400, "INVALID_NETWORK"); return; }
        prune();
        if (challenges.size >= maxEntries) { limited(res); return; }
        const ctx = context(req);
        const id = opaque();
        const expiresAt = now() + challengeTtl;
        const message = ["IOTA Oracle Webview authentication", `Service: ${ctx.audience}`,
          `Origin: ${ctx.origin ?? "noninteractive client"}`, `Wallet: ${address}`, `Network: ${network}`,
          `Nonce: ${id}`, `Issued at: ${new Date(now()).toISOString()}`, `Expires at: ${new Date(expiresAt).toISOString()}`,
          "Purpose: access unsigned transaction preparation. This does not authorize blockchain transactions."].join("\n");
        challenges.set(id, { address, network, ...ctx, expiresAt, message });
        res.json({ challengeId: id, message, address, network, audience: ctx.audience, expiresAt });
      } catch { fail(res, 400, "INVALID_AUTH_REQUEST"); }
    });
    app.post("/api/auth/verify", async (req, res) => {
      const id = req.body?.challengeId;
      const signature = req.body?.signature;
      if (typeof id !== "string" || id.length !== 43 || typeof signature !== "string" || signature.length > 16384) {
        fail(res, 400, "INVALID_AUTH_REQUEST"); return;
      }
      const challenge = challenges.get(id);
      // Consume before any await, including failed verification: concurrent replay cannot win twice.
      challenges.delete(id);
      try {
        const ctx = context(req);
        if (!challenge || challenge.expiresAt <= now() || challenge.audience !== ctx.audience || challenge.origin !== ctx.origin) {
          fail(res, 401, "INVALID_CHALLENGE"); return;
        }
        const key = await verifyPersonalMessageSignature(new TextEncoder().encode(challenge.message), signature);
        if (key.toIotaAddress() !== challenge.address) { fail(res, 401, "INVALID_SIGNATURE"); return; }
        prune();
        if (sessions.size >= maxEntries) { limited(res); return; }
        const token = opaque();
        const expiresAt = now() + sessionTtl;
        sessions.set(digest(token), { address: challenge.address, network: challenge.network, ...ctx, expiresAt });
        res.json({ token, tokenType: "Bearer", address: challenge.address, network: challenge.network, expiresAt });
      } catch { fail(res, 401, "INVALID_SIGNATURE"); }
    });
    app.post("/api/auth/logout", (req, res) => {
      try {
        if (!identity(req)) { fail(res, 401, "AUTHENTICATION_REQUIRED"); return; }
        sessions.delete(digest(req.get("authorization")!.slice(7)));
        res.sendStatus(204);
      } catch { fail(res, 401, "AUTHENTICATION_REQUIRED"); }
    });
    app.use((req, res, next) => {
      const path = routePath(req);
      if (req.method !== "POST" || !PREPARATION_ROUTES.has(path)) { next(); return; }
      try {
        const session = identity(req);
        if (!session) { fail(res, 401, "AUTHENTICATION_REQUIRED"); return; }
        if (req.body?.network !== session.network) { fail(res, 403, "SESSION_NETWORK_MISMATCH"); return; }
        if (path !== "/api/network" && walletAddress(req.body?.sender) !== session.address) {
          fail(res, 403, "SESSION_WALLET_MISMATCH"); return;
        }
        const key = `${session.network}:${session.address}`;
        if (!take(`wallet:${key}`, options.preparationLimit ?? 60)) { limited(res); return; }
        if ((active.get(key) ?? 0) >= (options.maxConcurrent ?? 4)) { limited(res); return; }
        active.set(key, (active.get(key) ?? 0) + 1);
        let released = false;
        const release = () => { if (released) return; released = true; const count = (active.get(key) ?? 1) - 1;
          if (count) active.set(key, count); else active.delete(key); };
        // A disconnected HTTP peer does not cancel RPC/subprocess work.
        // Release only once the actual operation returns (or sends its final response).
        res.locals.releasePreparation = release;
        res.once("finish", release);
        if (path !== "/api/network") req.body.sender = session.address;
        next();
      } catch { fail(res, 403, "SESSION_WALLET_MISMATCH"); }
    });
  }
  function operation(handler: (req: Request, res: Response, next: NextFunction) => unknown) {
    return async (req: Request, res: Response, next: NextFunction) => {
      try { await handler(req, res, next); }
      catch (error) { next(error); }
      finally { res.locals.releasePreparation?.(); }
    };
  }
  return { perimeter, install, operation };
}
