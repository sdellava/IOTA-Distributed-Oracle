import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { preparationEnvironment } from "../server/clientEnvironment.js";

test("child keeps public settings but neither keys nor unrelated secrets", () => {
  const env = preparationEnvironment({ PATH: "bin", CLIENT_KEY_FILE: "secret", EULA_SOURCE_TOKEN: "secret", NODE_OPTIONS: "untrusted", ORACLE_STATE_ID: "0x1" },
    { CLIENT_KEY_FILE: "other-secret", PRIVATE_KEY: "secret", MNEMONIC: "secret", IOTA_RPC_URL: "https://rpc.example.com", GAS_BUDGET: "50000000" });
  assert.equal(env.PATH, "bin"); assert.equal(env.ORACLE_STATE_ID, "0x1");
  assert.equal(env.IOTA_RPC_URL, "https://rpc.example.com"); assert.equal(env.GAS_BUDGET, "50000000");
  for (const key of ["CLIENT_KEY_FILE", "PRIVATE_KEY", "MNEMONIC", "EULA_SOURCE_TOKEN", "NODE_OPTIONS"]) assert.equal(env[key], undefined);
  assert.equal(env.ORACLE_PREPARE_ONLY, "1");
  assert.equal(env.DOTENV_CONFIG_PATH, process.platform === "win32" ? "NUL" : "/dev/null");
});
test("network-scoped public client configuration remains available", () => {
  const env = preparationEnvironment({}, { TESTNET_ORACLE_TASKS_PACKAGE_ID: "0x123", DEVNET_IOTA_RPC_URL: "https://rpc.example.com",
    MAINNET_IOTA_SYSTEM_STATE_ID: "0x5", TESTNET_CLIENT_KEY_FILE: "secret" });
  assert.equal(env.TESTNET_ORACLE_TASKS_PACKAGE_ID, "0x123");
  assert.equal(env.DEVNET_IOTA_RPC_URL, "https://rpc.example.com");
  assert.equal(env.MAINNET_IOTA_SYSTEM_STATE_ID, "0x5");
  assert.equal(env.TESTNET_CLIENT_KEY_FILE, undefined);
});
test("neither checked-in backend representation exposes execute or signing runner", () => {
  for (const ext of ["ts", "js"]) {
    assert.doesNotMatch(fs.readFileSync(new URL(`../server/index.${ext}`, import.meta.url), "utf8"), /app\.post\(["']\/api\/tasks\/execute/);
    const service = fs.readFileSync(new URL(`../server/services/oracleClient.${ext}`, import.meta.url), "utf8");
    assert.doesNotMatch(service, /executeOracleTask|spawnCreateTask/);
    assert.match(service, /preparationEnvironment/);
  }
});
