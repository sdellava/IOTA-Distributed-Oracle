import assert from "node:assert/strict";
import test from "node:test";
import { registerWalletSigner, walletPost } from "../src/lib/walletSession.js";

test("frontend shares one wallet login across concurrent preparations and reuses session", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; registerWalletSigner(); });
  let signatures = 0; let challenges = 0; let preparations = 0;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (url === "/api/auth/challenge") { challenges++; return Response.json({ message: "authentication", challengeId: "id" }); }
    if (url === "/api/auth/verify") return Response.json({ token: "test-session", expiresAt: Date.now() + 60000 });
    preparations++; assert.equal((init.headers as any).Authorization, "Bearer test-session"); return Response.json({ ok: true });
  }) as any;
  registerWalletSigner({ address: "0x123", sign: async () => { signatures++; return { signature: "test-signature" }; } });
  const body = { sender: "0x123", network: "testnet" };
  await Promise.all([walletPost("/api/tasks/prepare-wallet", body), walletPost("/api/tasks/prepare-task-schedule-wallet", body)]);
  await walletPost("/api/tasks/prepare-wallet", body);
  assert.equal(signatures, 1); assert.equal(challenges, 1); assert.equal(preparations, 3);
});
test("frontend renews once on server restart/expiry and never retries a forbidden operation", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; registerWalletSigner(); });
  let signatures = 0; let operations = 0;
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/auth/challenge") return Response.json({ message: "authentication", challengeId: "id" });
    if (url === "/api/auth/verify") return Response.json({ token: "test-session", expiresAt: Date.now() + 60000 });
    return Response.json({}, { status: ++operations === 1 ? 401 : 403 });
  }) as any;
  registerWalletSigner({ address: "0x123", sign: async () => { signatures++; return { signature: "sig" }; } });
  const response = await walletPost("/api/tasks/prepare-wallet", { sender: "0x123", network: "testnet" });
  assert.equal(response.status, 403); assert.equal(signatures, 2); assert.equal(operations, 2);
});
test("disconnect or wallet change during signing prevents preparation with stale identity", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; registerWalletSigner(); });
  let started!: () => void; let finish!: () => void; let prepared = false;
  const ready = new Promise<void>(r => { started = r; }); const gate = new Promise<void>(r => { finish = r; });
  globalThis.fetch = (async (url: string) => {
    if (url === "/api/auth/challenge") return Response.json({ message: "authentication", challengeId: "id" });
    prepared = true; return Response.json({});
  }) as any;
  registerWalletSigner({ address: "0x123", sign: async () => { started(); await gate; return { signature: "sig" }; } });
  const operation = walletPost("/api/tasks/prepare-wallet", { sender: "0x123", network: "testnet" });
  await ready; registerWalletSigner(); finish();
  await assert.rejects(operation, /Wallet or network changed/); assert.equal(prepared, false);
  await assert.rejects(walletPost("/api/tasks/prepare-wallet", { sender: "0x123", network: "testnet" }), /Connect the wallet/);
});
test("wallet refusal does not fall back to anonymous or server-signed execution", async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; registerWalletSigner(); });
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ message: "authentication", challengeId: "id" }); }) as any;
  registerWalletSigner({ address: "0x123", sign: async () => { throw new Error("User rejected"); } });
  await assert.rejects(walletPost("/api/tasks/prepare-wallet", { sender: "0x123", network: "testnet" }), /User rejected/);
  assert.equal(calls, 1);
});
