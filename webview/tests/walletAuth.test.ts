import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { Ed25519Keypair } from "@iota/iota-sdk/keypairs/ed25519";
import { createWalletAuth, PREPARATION_ROUTES } from "../server/walletAuth.js";
import { authenticateWebview } from "../../client/src/webviewAuth.js";
import { request as httpRequest } from "node:http";

async function fixture(options: Partial<Parameters<typeof createWalletAuth>[0]> = {}) {
  const app = express();
  let calls = 0;
  let hold: (() => Promise<void>) | undefined;
  const auth = createWalletAuth({ networks: ["testnet", "mainnet"], ...options });
  app.use(auth.perimeter); app.use(express.json()); auth.install(app);
  for (const route of PREPARATION_ROUTES) app.post(route, auth.operation(async (req, res) => {
    calls++; await hold?.(); res.json({ sender: req.body.sender, network: req.body.network });
  }));
  app.get("/api/status", (_req, res) => res.json({ public: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, body: unknown, token?: string, headers = {}) => fetch(base + path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const challenge = async (key: Ed25519Keypair) => (await post("/api/auth/challenge", { address: key.toIotaAddress(), network: "testnet" })).json();
  const sign = async (key: Ed25519Keypair, value: any) => ({ challengeId: value.challengeId,
    signature: (await key.signPersonalMessage(new TextEncoder().encode(value.message))).signature });
  const login = async (key: Ed25519Keypair) => (await post("/api/auth/verify", await sign(key, await challenge(key)))).json();
  const close = () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  const rawPost = (path: string, body: unknown, token: string, host: string, headers = {}) => new Promise<number>((resolve, reject) => {
    const req = httpRequest(base + path, { method: "POST", headers: { Host: host, "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers } }, res => {
      res.resume(); res.on("end", () => resolve(res.statusCode!));
    }); req.on("error", reject); req.end(JSON.stringify(body));
  });
  return { base, post, rawPost, challenge, sign, login, close, calls: () => calls, hold: (fn?: () => Promise<void>) => { hold = fn; } };
}

test("all operational routes reject anonymous callers before any work; public status remains readable", async t => {
  const f = await fixture(); t.after(f.close);
  for (const route of PREPARATION_ROUTES) {
    for (const alias of [route, route + "/", route.toUpperCase()]) assert.equal((await f.post(alias, {})).status, 401, alias);
  }
  assert.equal(f.calls(), 0);
  assert.equal((await fetch(f.base + "/api/status")).status, 200);
});
test("real personal-message signature authenticates all preparation paths with bound sender/network", async t => {
  const f = await fixture(); t.after(f.close);
  const key = new Ed25519Keypair(); const session = await f.login(key);
  assert.equal(session.address, key.toIotaAddress()); assert.equal(session.tokenType, "Bearer");
  for (const route of PREPARATION_ROUTES) {
    const r = await f.post(route, { sender: key.toIotaAddress(), network: "testnet" }, session.token);
    assert.equal(r.status, 200, route); assert.equal(r.headers.get("cache-control"), "no-store");
  }
  assert.equal(f.calls(), PREPARATION_ROUTES.size);
});
test("wrong signer, altered message, transaction-intent signature and concurrent replay fail", async t => {
  const f = await fixture(); t.after(f.close);
  const key = new Ed25519Keypair(); const other = new Ed25519Keypair();
  const c = await f.challenge(key);
  assert.equal((await f.post("/api/auth/verify", await f.sign(other, c))).status, 401);
  const changed = await f.challenge(key);
  assert.equal((await f.post("/api/auth/verify", await f.sign(key, { ...changed, message: changed.message + "changed" }))).status, 401);
  const transaction = await f.challenge(key);
  const signed = await key.signTransaction(new TextEncoder().encode(transaction.message));
  assert.equal((await f.post("/api/auth/verify", { challengeId: transaction.challengeId, signature: signed.signature })).status, 401);
  const replay = await f.sign(key, await f.challenge(key));
  const results = await Promise.all([f.post("/api/auth/verify", replay), f.post("/api/auth/verify", replay)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
});
test("challenge and session expiry, revocation and tokens in query strings are enforced", async t => {
  let clock = Date.now();
  const f = await fixture({ now: () => clock, challengeTtlMs: 10, sessionTtlMs: 20 }); t.after(f.close);
  const key = new Ed25519Keypair(); const c = await f.challenge(key); const proof = await f.sign(key, c);
  clock += 11; assert.equal((await f.post("/api/auth/verify", proof)).status, 401);
  const session = await f.login(key); const body = { sender: key.toIotaAddress(), network: "testnet" };
  assert.equal((await f.post(`/api/tasks/prepare-wallet?token=${session.token}`, body)).status, 401);
  clock += 21; assert.equal((await f.post("/api/tasks/prepare-wallet", body, session.token)).status, 401);
  const fresh = await f.login(key);
  assert.equal((await f.post("/api/auth/logout", {}, fresh.token)).status, 204);
  assert.equal((await f.post("/api/tasks/prepare-wallet", body, fresh.token)).status, 401);
});
test("a valid session cannot select another wallet, network, origin or service", async t => {
  const f = await fixture(); t.after(f.close);
  const key = new Ed25519Keypair(); const session = await f.login(key);
  assert.equal((await f.post("/api/tasks/prepare-wallet", { sender: new Ed25519Keypair().toIotaAddress(), network: "testnet" }, session.token)).status, 403);
  assert.equal((await f.post("/api/tasks/prepare-wallet", { sender: key.toIotaAddress(), network: "mainnet" }, session.token)).status, 403);
  assert.equal((await f.post("/api/tasks/prepare-wallet", { sender: key.toIotaAddress(), network: "testnet" }, session.token, { Origin: "https://evil.example.com" })).status, 403);
  assert.equal(await f.rawPost("/api/tasks/prepare-wallet", { sender: key.toIotaAddress(), network: "testnet" }, session.token, "other.example.com"), 401);
  const c = await f.challenge(key);
  assert.equal((await f.post("/api/auth/verify", await f.sign(key, c), undefined, { Origin: f.base })).status, 401);
  assert.equal(f.calls(), 0);
});
test("browser-origin sessions work and cannot be reused without that origin", async t => {
  const f = await fixture(); t.after(f.close);
  const key = new Ed25519Keypair();
  const c = await (await f.post("/api/auth/challenge", { address: key.toIotaAddress(), network: "testnet" }, undefined, { Origin: f.base })).json();
  const session = await (await f.post("/api/auth/verify", await f.sign(key, c), undefined, { Origin: f.base })).json();
  const body = { sender: key.toIotaAddress(), network: "testnet" };
  assert.equal((await f.post("/api/tasks/prepare-wallet", body, session.token, { Origin: f.base })).status, 200);
  assert.equal((await f.post("/api/tasks/prepare-wallet", body, session.token)).status, 401);
});
test("bounded challenge store, issuance rate and per-wallet preparation rate reject excess work", async t => {
  const bounded = await fixture({ maxEntries: 1 }); t.after(bounded.close);
  const key = new Ed25519Keypair();
  assert.equal((await bounded.post("/api/auth/challenge", { address: key.toIotaAddress(), network: "testnet" })).status, 200);
  assert.equal((await bounded.post("/api/auth/challenge", { address: key.toIotaAddress(), network: "testnet" })).status, 429);
  const limited = await fixture({ authLimit: 1 }); t.after(limited.close);
  await limited.challenge(key);
  assert.equal((await limited.post("/api/auth/challenge", { address: key.toIotaAddress(), network: "testnet" })).status, 429);
  const f = await fixture({ preparationLimit: 1 }); t.after(f.close);
  const session = await f.login(key); const body = { sender: key.toIotaAddress(), network: "testnet" };
  assert.equal((await f.post("/api/tasks/prepare-wallet", body, session.token)).status, 200);
  const denied = await f.post("/api/tasks/prepare-wallet", body, session.token);
  assert.equal(denied.status, 429); assert.equal(denied.headers.get("retry-after"), "60"); assert.equal(f.calls(), 1);
});
test("concurrent preparation slots are limited and released", async t => {
  const f = await fixture({ maxConcurrent: 1 }); t.after(f.close);
  const key = new Ed25519Keypair(); const session = await f.login(key);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const gate = new Promise<void>(r => { release = r; });
  f.hold(async () => { entered(); await gate; });
  const body = { sender: key.toIotaAddress(), network: "testnet" };
  const first = f.post("/api/tasks/prepare-wallet", body, session.token);
  await started;
  assert.equal((await f.post("/api/tasks/prepare-wallet", body, session.token)).status, 429);
  release(); assert.equal((await first).status, 200); f.hold();
  assert.equal((await f.post("/api/tasks/prepare-wallet", body, session.token)).status, 200);
});
test("noninteractive standalone client signs locally and obtains a usable session", async t => {
  const f = await fixture(); t.after(f.close);
  const key = new Ed25519Keypair(); const session = await authenticateWebview(f.base, "testnet", key);
  assert.equal((await f.post("/api/tasks/prepare-wallet", { sender: key.toIotaAddress(), network: "testnet" }, session.token)).status, 200);
});
test("development proxy can preserve browser Host and Origin without allowing cross-origin login", async t => {
  const f = await fixture(); t.after(f.close);
  const body = { address: new Ed25519Keypair().toIotaAddress(), network: "testnet" };
  assert.equal(await f.rawPost("/api/auth/challenge", body, "", "localhost:5173", { Origin: "http://localhost:5173" }), 200);
  assert.equal(await f.rawPost("/api/auth/challenge", body, "", "localhost:5173", { Origin: "http://evil.example.com" }), 403);
});
test("aborting HTTP does not release a slot while preparation work is still running", async t => {
  const f = await fixture({ maxConcurrent: 1 }); t.after(f.close);
  const key = new Ed25519Keypair(); const session = await f.login(key);
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>(r => { entered = r; }); const gate = new Promise<void>(r => { release = r; });
  f.hold(async () => { entered(); await gate; });
  const body = { sender: key.toIotaAddress(), network: "testnet" };
  const controller = new AbortController();
  const aborted = fetch(f.base + "/api/node-management/prepare-wallet", { method: "POST", signal: controller.signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` }, body: JSON.stringify(body) }).catch(() => undefined);
  await started; controller.abort(); await aborted;
  await new Promise(r => setTimeout(r, 20));
  assert.equal((await f.post("/api/node-management/prepare-wallet", body, session.token)).status, 429);
  assert.equal(f.calls(), 1);
  release(); await new Promise(r => setImmediate(r)); f.hold();
  assert.equal((await f.post("/api/node-management/prepare-wallet", body, session.token)).status, 200);
});
