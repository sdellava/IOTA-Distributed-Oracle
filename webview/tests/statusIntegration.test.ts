import assert from "node:assert/strict";
import test from "node:test";

test("complete status service answers operational reads while large historical work is pending or throttled", async t => {
  const originalFetch = globalThis.fetch;
  const keys = ["TESTNET_ORACLE_TASKS_PACKAGE_ID", "TESTNET_ORACLE_STATE_ID", "TESTNET_IOTA_RPC_URL", "TESTNET_IOTA_GRAPHQL_URL",
    "MAINNET_ORACLE_TASKS_PACKAGE_ID", "MAINNET_ORACLE_STATE_ID", "MAINNET_IOTA_RPC_URL", "MAINNET_IOTA_GRAPHQL_URL", "WEBVIEW_HISTORY_PER_MINUTE"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.TESTNET_ORACLE_TASKS_PACKAGE_ID = "0x" + "1".repeat(64);
  process.env.MAINNET_ORACLE_TASKS_PACKAGE_ID = "0x" + "2".repeat(64);
  process.env.TESTNET_ORACLE_STATE_ID = process.env.MAINNET_ORACLE_STATE_ID = "0x" + "3".repeat(64);
  process.env.TESTNET_IOTA_RPC_URL = process.env.MAINNET_IOTA_RPC_URL = "https://rpc.example.com";
  process.env.TESTNET_IOTA_GRAPHQL_URL = process.env.MAINNET_IOTA_GRAPHQL_URL = "https://graphql.example.com";
  process.env.WEBVIEW_HISTORY_PER_MINUTE = "2";
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let checkpoints = 0; let historicalCalls = 0;
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    const historical = Boolean(body.query?.includes?.("CountTaskObjects")) || (body.method === "iotax_queryEvents" && body.params[3] === false);
    if (historical) { historicalCalls++; await gate; }
    if (body.query) return Response.json({ data: { objects: { nodes: [{ address: "0x1" }], pageInfo: { hasNextPage: true, endCursor: "more" } } } });
    let result: unknown;
    switch (body.method) {
      case "iota_getLatestCheckpointSequenceNumber": checkpoints++; result = "100"; break;
      case "iota_getObject": result = { data: { content: { dataType: "moveObject", fields: { node_registry_id: "0x" + "4".repeat(64), oracle_nodes: [] } } } }; break;
      case "iotax_getDynamicFields": result = { data: [], hasNextPage: false, nextCursor: null }; break;
      case "iotax_queryEvents": result = historical
        ? { data: Array.from({ length: 50 }, (_, index) => ({ id: { txDigest: `tx-${index}`, eventSeq: "0" } })), hasNextPage: true, nextCursor: { txDigest: "tx-49", eventSeq: "0" } }
        : { data: [], hasNextPage: false, nextCursor: null }; break;
      default: throw new Error(`Unexpected RPC method: ${body.method}`);
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  }) as any;
  t.after(async () => {
    release(); await new Promise(resolve => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; }
  });
  const { getOracleStatus } = await import("../server/services/oracleStatus.js");
  const results = await Promise.all(Array.from({ length: 20 }, () => getOracleStatus("testnet")));
  assert.equal(checkpoints, 1);
  for (const status of results) {
    assert.equal(status.latestCheckpoint, "100");
    assert.equal(status.metrics.totalOracleEvents, null);
    assert.equal(status.metrics.onChainTaskObjects, null);
    assert.ok(!status.warnings.some(warning => /UPSTREAM_CAPACITY/.test(warning)));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(historicalCalls <= 2, `history used ${historicalCalls} calls`);
  const other = await getOracleStatus("mainnet");
  assert.equal(other.latestCheckpoint, "100"); assert.equal(checkpoints, 2);
  assert.ok(!other.warnings.some(warning => /UPSTREAM_CAPACITY/.test(warning)));
  assert.equal(historicalCalls, 2);
});
