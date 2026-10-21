import assert from "node:assert/strict";
import test from "node:test";
import { createMonitorHandler, type MonitorRuntimeState } from "../src/monitor";

const secret = "sensitive provider error with credentials";
const token = "a".repeat(64);
function fixture(authToken: string | undefined = token) {
  let balanceCalls = 0;
  const check = {
    enabled: true, status: "failed" as const, lastStartedAtMs: 1, lastCheckedAtMs: 2,
    lastOkAtMs: null, lastErrorAtMs: 2, lastError: secret, templatesRemoved: [4],
    lastRemovalTxDigest: "private-digest", lastRemovalError: secret,
  };
  const state: MonitorRuntimeState = {
    booting: false, listenersStarted: true, shutdownRequested: false, autoRegister: true, autoUnregister: true,
    registration: { attempted: true, succeeded: true, txDigest: "private-digest", lastError: secret },
    capabilityHealth: {
      workerEnabled: true, intervalMs: 300000, initialDelayMs: 30000, running: false,
      lastStartedAtMs: 1, lastCompletedAtMs: 2, checks: { LLM: { ...check }, IPFS: { ...check } },
    },
  };
  const ctx = {
    nodeId: "1", identity: { address: "private-wallet" }, startupMs: 0, acceptedTemplateIds: [0], pollMs: 1200,
    stats: {
      getTaskStats: () => ({ total: 1, lastError: secret }),
      getBalanceSnapshot: async () => { balanceCalls++; return { data: { totalBalance: "1" }, error: secret }; },
    },
  } as any;
  const before = process.env.MONITOR_AUTH_TOKEN;
  if (authToken === undefined) delete process.env.MONITOR_AUTH_TOKEN; else process.env.MONITOR_AUTH_TOKEN = authToken;
  const handler = createMonitorHandler(ctx, state);
  if (before === undefined) delete process.env.MONITOR_AUTH_TOKEN; else process.env.MONITOR_AUTH_TOKEN = before;
  const request = (url: string, authorization?: string, method = "GET") => new Promise<{ code: number; body: any; raw: string; headers: any }>((resolve) => {
    let code: number, headers: any;
    handler({ url, method, headers: { authorization } } as any, {
      writeHead(c: number, h: any) { code = c; headers = h; },
      end(raw: string) { resolve({ code, headers, raw, body: JSON.parse(raw) }); },
    } as any);
  });
  return { state, ctx, request, balanceCalls: () => balanceCalls };
}

test("public health only contains synthetic status and performs no chain RPC", async () => {
  const f = fixture();
  const r = await f.request("/health");
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { status: "ok", capabilitiesDegraded: true, capabilityHealth: { checks: { LLM: { status: "failed" }, IPFS: { status: "failed" } } } });
  assert.equal(f.balanceCalls(), 0);
  assert.equal(r.headers["cache-control"], "no-store");
  f.state.booting = true;
  assert.equal((await f.request("/health")).code, 503);
});

test("status rejects absent, incorrect and query-string credentials before RPC", async () => {
  const f = fixture();
  for (const auth of [undefined, "Bearer wrong", `Basic ${token}`]) {
    assert.equal((await f.request("/status", auth)).code, 401);
  }
  assert.equal((await f.request(`/status?token=${token}`)).code, 401);
  assert.equal(f.balanceCalls(), 0);
});

test("status fails closed with missing or short token", async () => {
  for (const value of ["", "short"]) {
    const f = fixture(value);
    assert.equal((await f.request("/status", `Bearer ${value}`)).code, 503);
    assert.equal(f.balanceCalls(), 0);
    assert.equal((await f.request("/health")).code, 200);
  }
});

test("authorized status exposes diagnostics without raw provider errors in any nested field", async () => {
  const f = fixture();
  const r = await f.request("/status", `Bearer ${token}`);
  assert.equal(r.code, 200);
  assert.equal(r.body.address, "private-wallet");
  assert.equal(r.body.capabilityHealth.checks.IPFS.lastError, "CAPABILITY_CHECK_FAILED");
  assert.equal(r.body.runtime.capabilityHealth.checks.IPFS.lastRemovalError, "TEMPLATE_REMOVAL_FAILED");
  assert.equal(r.raw.includes(secret), false);
  assert.equal(r.raw.includes(token), false);
  assert.equal(f.balanceCalls(), 1);
  assert.equal(f.state.capabilityHealth.checks.IPFS.lastError, secret);
});

test("failed capability remains degraded while retry is running", async () => {
  const f = fixture();
  f.state.capabilityHealth.checks.LLM.status = "running";
  f.state.capabilityHealth.checks.IPFS.status = "running";
  assert.equal((await f.request("/health")).body.capabilitiesDegraded, true);
});

test("monitor errors are generic and invalid methods/routes are rejected", async () => {
  const f = fixture();
  assert.equal((await f.request("/metrics")).code, 404);
  assert.equal((await f.request("/health", undefined, "POST")).code, 405);
  f.ctx.stats.getBalanceSnapshot = async () => { throw Error(secret); };
  assert.deepEqual((await f.request("/status", `Bearer ${token}`)).body, { error: "monitor_failed" });
});
