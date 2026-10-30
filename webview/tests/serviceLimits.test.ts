import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { createServiceLimits } from "../server/serviceLimits.js";
import { createBoundedFetch } from "../server/upstream.js";
import { summarizeAudit } from "../scripts/audit-report.mjs";

async function fixture(options: Parameters<typeof createServiceLimits>[0] = {}) {
  const events: any[] = []; const app = express();
  const limits = createServiceLimits({ emit: event => events.push(event), ...options });
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  app.use(limits.middleware);
  app.get("/api/task/:id", limits.read(async (_req, res) => {
    entered();
    await new Promise(r => setTimeout(r, 40)); res.json({ ok: true });
  }));
  app.get("/api/status", limits.read((_req, res) => { res.locals.auditIdentity = { wallet: "0x" + "a".repeat(64), network: "testnet" }; res.json({ ok: true }); }));
  app.get("/api/task/:id/stream", (_req, res) => { res.setHeader("Content-Type", "text/event-stream"); res.flushHeaders(); });
  app.get("/api/health", (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return { base, events, started, close: () => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }) };
}
test("public read quota rejects excess while synthetic health stays available", async t => {
  const f = await fixture({ readRate: 1 }); t.after(f.close);
  assert.equal((await fetch(f.base + "/api/status")).status, 200);
  assert.equal((await fetch(f.base + "/api/status")).status, 429);
  assert.equal((await fetch(f.base + "/api/health")).status, 200);
});
test("read concurrency remains reserved until handler completion after client abort", async t => {
  const f = await fixture({ readsPerIp: 1 }); t.after(f.close);
  const controller = new AbortController();
  const pending = fetch(f.base + "/api/task/0x1", { signal: controller.signal }).catch(() => undefined);
  await f.started; controller.abort(); await pending;
  assert.equal((await fetch(f.base + "/api/task/0x2")).status, 429);
  await new Promise(r => setTimeout(r, 60));
  assert.equal((await fetch(f.base + "/api/task/0x2")).status, 200);
});
test("stream admission is bounded and closing a stream releases its slot", async t => {
  const f = await fixture({ streamsPerIp: 1 }); t.after(f.close);
  const first = await fetch(f.base + "/api/task/0x1/stream");
  assert.equal((await fetch(f.base + "/api/task/0x2/stream")).status, 429);
  await first.body!.cancel(); await new Promise(r => setTimeout(r, 20));
  const next = await fetch(f.base + "/api/task/0x2/stream"); assert.equal(next.status, 200); await next.body!.cancel();
});
test("audit records status, route template and verified identity without credentials, body, IDs or query", async t => {
  const f = await fixture({ ipSalt: "fixed-test-salt" }); t.after(f.close);
  await fetch(f.base + "/api/status?token=DO_NOT_LOG", { headers: { Authorization: "Bearer DO_NOT_LOG" } });
  await fetch(f.base + "/api/task/sensitive-object-id?private=DO_NOT_LOG");
  const text = JSON.stringify(f.events);
  assert.doesNotMatch(text, /DO_NOT_LOG|sensitive-object-id|127\.0\.0\.1/);
  assert.ok(f.events.some(e => e.route === "/api/task/:taskId"));
  assert.equal(f.events[0].wallet, "0x" + "a".repeat(64));
  assert.match(f.events[0].requestId, /^[0-9a-f-]+$/);
  const report = summarizeAudit(["startup", ...f.events.map(e => JSON.stringify(e)), JSON.stringify({ log: JSON.stringify(f.events[0]) })]);
  assert.equal(report.events, 3); assert.equal(report.ignoredLines, 1); assert.equal(report.authenticatedWallets, 1);
  assert.match(report.coverage, /absence is not evidence/);
});
test("upstream limits cover concurrency, total calls and response bytes", async () => {
  let release!: () => void;
  const request = createBoundedFetch({ concurrency: 1, fetch: (async () => { await new Promise<void>(r => { release = r; }); return Response.json({ ok: true }); }) as any });
  const pending = request("https://rpc.example.com");
  await assert.rejects(request("https://rpc.example.com"), /UPSTREAM_CAPACITY/); release(); await pending;
  const large = createBoundedFetch({ maxBytes: 4, fetch: (async () => new Response("12345")) as any });
  await assert.rejects(large("https://rpc.example.com"), /UPSTREAM_TOO_LARGE/);
  const rate = createBoundedFetch({ rate: 1, fetch: (async () => new Response("ok")) as any });
  await rate("https://rpc.example.com"); await assert.rejects(rate("https://rpc.example.com"), /UPSTREAM_CAPACITY/);
});
test("upstream native timeout aborts a stalled body, not only HTTP headers", async t => {
  const app = express(); app.get("/", (_req, res) => { res.write("{"); });
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  t.after(() => new Promise<void>(r => { server.close(() => r()); server.closeAllConnections(); }));
  const request = createBoundedFetch({ timeoutMs: 30 });
  await assert.rejects(request(`http://127.0.0.1:${(server.address() as any).port}/`), /UPSTREAM_TIMEOUT/);
});
