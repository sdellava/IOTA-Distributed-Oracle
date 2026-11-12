import assert from "node:assert/strict";
import test from "node:test";
import { createHistoryCounter, createStatusCache, type HistoryPage } from "../server/historyMetrics.js";
import { createBoundedFetch, historyBudget } from "../server/upstream.js";
import { createRequestPool, historyHint } from "../src/lib/requestPool.js";
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test("large histories advance a bounded number of pages and never expose partial totals", async () => {
  let clock = 0; let calls = 0;
  const counter = createHistoryCounter({ now: () => clock, pages: 2 });
  const load = async () => ({ count: 50, cursor: `page-${++calls}`, hasNextPage: calls < 5 });
  assert.equal(counter.read("history", "snapshot", load).value, null); await settle();
  assert.equal(calls, 2); assert.equal(counter.read("history", "snapshot", load).value, null);
  clock += 10000; counter.read("history", "snapshot", load); await settle();
  assert.equal(calls, 4); assert.equal(counter.read("history", "snapshot", load).value, null);
  clock += 10000; counter.read("history", "snapshot", load); await settle();
  assert.equal(counter.read("history", "snapshot", load).value, 250); assert.equal(calls, 5);
  clock += 10000; assert.equal(counter.read("history", "snapshot", load).state, "current"); assert.equal(calls, 5);
});
test("append-only event totals resume after the last event without recounting the prefix", async () => {
  let clock = 0; const received: unknown[] = [];
  const pages: HistoryPage[] = [
    { count: 2, cursor: { txDigest: "tx1", eventSeq: "0" }, hasNextPage: true },
    { count: 1, cursor: { txDigest: "tx2", eventSeq: "0" }, hasNextPage: false },
    { count: 2, cursor: { txDigest: "tx3", eventSeq: "0" }, hasNextPage: false },
    { count: 0, cursor: { txDigest: "tx3", eventSeq: "0" }, hasNextPage: false },
  ];
  const counter = createHistoryCounter({ now: () => clock });
  const load = async (cursor: any) => { received.push(cursor); return pages.shift()!; };
  counter.read("events", "append", load); await settle(); assert.equal(counter.read("events", "append", load).value, 3);
  clock += 10000; counter.read("events", "append", load); await settle();
  assert.deepEqual(received[2], { txDigest: "tx2", eventSeq: "0" });
  assert.equal(counter.read("events", "append", load).value, 5);
  clock += 10000; counter.read("events", "append", load); await settle(); assert.equal(counter.read("events", "append", load).value, 5);
});
test("failures retain validated progress, back off and do not double count resumed pages", async () => {
  let clock = 0; let calls = 0;
  const counter = createHistoryCounter({ now: () => clock });
  const load = async (cursor: any): Promise<HistoryPage> => {
    calls++; if (calls === 1) return { count: 50, cursor: "a", hasNextPage: true };
    if (calls === 2) throw new Error("UPSTREAM_CAPACITY");
    assert.equal(cursor, "a"); return { count: 3, cursor: "b", hasNextPage: false };
  };
  counter.read("objects", "snapshot", load); await settle();
  assert.equal(counter.read("objects", "snapshot", load).state, "unavailable"); assert.equal(calls, 2);
  clock = 29999; counter.read("objects", "snapshot", load); assert.equal(calls, 2);
  clock = 30000; counter.read("objects", "snapshot", load); await settle();
  assert.equal(counter.read("objects", "snapshot", load).value, 53);
});
test("mutable object counts rebuild a generation and retain the last complete result", async () => {
  let clock = 0; let calls = 0;
  const counter = createHistoryCounter({ now: () => clock, pages: 1, refreshMs: 30000 });
  const load = async (cursor: any) => {
    calls++; if (calls === 1) return { count: 20, cursor: "old", hasNextPage: false };
    if (calls === 2) { assert.equal(cursor, null); return { count: 5, cursor: "new", hasNextPage: true }; }
    return { count: 3, cursor: "end", hasNextPage: false };
  };
  counter.read("objects", "snapshot", load); await settle();
  clock = 30000; assert.equal(counter.read("objects", "snapshot", load).value, 20); await settle();
  assert.equal(counter.read("objects", "snapshot", load).state, "updating");
  clock += 10000; counter.read("objects", "snapshot", load); await settle();
  assert.equal(counter.read("objects", "snapshot", load).value, 8);
});
test("same-key history work is shared, malformed/repeated cursors cannot commit", async () => {
  let clock = 0; let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const counter = createHistoryCounter({ now: () => clock });
  const load = async (): Promise<HistoryPage> => { calls++; await gate; return { count: 5, cursor: null, hasNextPage: true }; };
  for (let index = 0; index < 20; index++) counter.read("same", "snapshot", load);
  await settle(); assert.equal(calls, 1); release(); await settle();
  assert.equal(counter.read("same", "snapshot", load).value, null);
  clock = 30000;
  let steps = 0; const repeated = async () => ({ count: 5, cursor: "same", hasNextPage: ++steps < 3 });
  counter.read("same", "snapshot", repeated); await settle();
  assert.equal(counter.read("same", "snapshot", repeated).state, "unavailable"); assert.equal(steps, 2);
});
test("status requests share inflight work, cache briefly and isolate network/config keys", async () => {
  let clock = 0; let calls = 0;
  const cache = createStatusCache<string>(5000, 8, () => clock);
  const load = async () => { calls++; await settle(); return "status"; };
  await Promise.all(Array.from({ length: 20 }, () => cache("testnet", load))); assert.equal(calls, 1);
  await cache("testnet", load); assert.equal(calls, 1);
  await cache("mainnet", load); assert.equal(calls, 2);
  clock = 5001; await cache("testnet", load); assert.equal(calls, 3);
  await assert.rejects(cache("failed", async () => { throw new Error("rpc failed"); }));
  assert.equal(await cache("failed", async () => "recovered"), "recovered");
});
test("historical sub-budget cannot consume all capacity reserved for operational reads", async () => {
  let requests = 0;
  const global = createBoundedFetch({ rate: 10, concurrency: 10, fetch: (async () => { requests++; return new Response("ok"); }) as any });
  const historical = createBoundedFetch({ fetch: global, rate: 2, concurrency: 1 });
  await historical("https://graphql.example.com"); await historical("https://graphql.example.com");
  await assert.rejects(historical("https://graphql.example.com"), /UPSTREAM_CAPACITY/);
  for (let index = 0; index < 8; index++) await global("https://rpc.example.com");
  assert.equal(requests, 10); await assert.rejects(global("https://rpc.example.com"), /UPSTREAM_CAPACITY/);
});
test("frontend polling shares pending requests and labels incomplete historical metrics", async () => {
  let calls = 0; const pool = createRequestPool();
  const load = async () => { calls++; await settle(); return "ok"; };
  await Promise.all([pool("testnet", load), pool("testnet", load)]); assert.equal(calls, 1);
  await pool("mainnet", load); assert.equal(calls, 2);
  assert.equal(historyHint({ value: null, state: "counting", asOf: null }), "Counting history…");
  assert.match(historyHint({ value: 20, state: "updating", asOf: "2026-11-12T08:00:00Z" }), /Last completed count/);
});
test("custom low upstream limits still reserve operational capacity", async () => {
  assert.deepEqual(historyBudget(1200, 32, 60), { rate: 60, concurrency: 3 });
  assert.deepEqual(historyBudget(10, 2, 60), { rate: 1, concurrency: 1 });
  assert.deepEqual(historyBudget(1, 1, 60), { rate: 0, concurrency: 0 });
  let calls = 0;
  const request = createBoundedFetch({ ...historyBudget(1, 1, 60), fetch: (async () => { calls++; return new Response("ok"); }) as any });
  await assert.rejects(request("https://history.example.com"), /UPSTREAM_CAPACITY/); assert.equal(calls, 0);
});
