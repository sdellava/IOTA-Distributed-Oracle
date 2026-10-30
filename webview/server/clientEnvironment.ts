// Only preparation settings may reach the child; no wallet keys or provider tokens.
export function preparationEnvironment(base: NodeJS.ProcessEnv, settings: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const system = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMW6432|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i;
  const publicSetting = /^(?:(?:DEVNET|TESTNET|MAINNET)_)?(ORACLE_(?:.*_ID|REGISTRATION_MODE)|IOTA_(?:NETWORK|RPC_URL|SYSTEM_STATE_ID|RANDOM_OBJECT_ID|CLOCK_ID|CLOCK_OBJECT_ID)|GAS_BUDGET|EVENT_POLL_MS|WAIT_TIMEOUT_MS|STORAGE_PROBE_TIMEOUT_MS|TASK_HTTP_(?:DENIED_HOSTS|ALLOWED_HOSTS|ALLOWED_PORTS))$/;
  for (const [name, value] of Object.entries(base)) if (system.test(name)) env[name] = value;
  for (const source of [base, settings]) {
    for (const [name, value] of Object.entries(source)) if (publicSetting.test(name)) env[name] = value;
  }
  // The Webview operator's egress policy cannot be relaxed by client/.env defaults.
  for (const name of ["TASK_HTTP_DENIED_HOSTS", "TASK_HTTP_ALLOWED_HOSTS", "TASK_HTTP_ALLOWED_PORTS"]) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  // dotenv/config must not reload the client .env after filtering it above.
  env.DOTENV_CONFIG_PATH = process.platform === "win32" ? "NUL" : "/dev/null";
  env.ORACLE_PREPARE_ONLY = "1";
  return env;
}
