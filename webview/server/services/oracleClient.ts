// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import dotenv from "dotenv";
import { preparationEnvironment } from "../clientEnvironment.js";
import { config, getRuntimeConfig, type OracleNetwork } from "../config.js";

const activeChildren = new Set<ChildProcess>();
let cleanupHooksInstalled = false;
let reservedChildren = 0;

function npmCommand(): string {
  return "npm";
}

async function buildClientEnv(network?: OracleNetwork): Promise<NodeJS.ProcessEnv> {
  const runtime = getRuntimeConfig(network);
  const envPath = path.join(config.oracleClientDir, ".env");
  let parsed: Record<string, string> = {};

  try {
    const raw = await fs.readFile(envPath, "utf8");
    parsed = dotenv.parse(raw);
  } catch {
    parsed = {};
  }

  const runtimeOverrides: Record<string, string> = {
    IOTA_NETWORK: runtime.network,
    IOTA_RPC_URL: runtime.rpcUrl,
  };

  if (runtime.oracleTasksPackageId) {
    runtimeOverrides.ORACLE_TASKS_PACKAGE_ID = runtime.oracleTasksPackageId;
    runtimeOverrides.ORACLE_PACKAGE_ID = runtime.oracleTasksPackageId;
  }

  if (runtime.oracleSystemPackageId) {
    runtimeOverrides.ORACLE_SYSTEM_PACKAGE_ID = runtime.oracleSystemPackageId;
  }

  if (runtime.oracleStateId) {
    runtimeOverrides.ORACLE_STATE_ID = runtime.oracleStateId;
    runtimeOverrides.ORACLE_STATUS_ID = runtime.oracleStateId;
    runtimeOverrides.ORACLE_SYSTEM_STATE_ID = runtime.oracleStateId;
  }

  if (runtime.oracleNodeRegistryId) {
    runtimeOverrides.ORACLE_NODE_REGISTRY_ID = runtime.oracleNodeRegistryId;
  }

  if (runtime.oracleTreasuryId) {
    runtimeOverrides.ORACLE_TREASURY_ID = runtime.oracleTreasuryId;
    runtimeOverrides.ORACLE_TREASURY_OBJECT_ID = runtime.oracleTreasuryId;
  }

  if (runtime.oracleTaskRegistryId) {
    runtimeOverrides.ORACLE_TASK_REGISTRY_ID = runtime.oracleTaskRegistryId;
  }

  if (runtime.oracleTaskSchedulerQueueId) {
    runtimeOverrides.ORACLE_TASK_SCHEDULER_QUEUE_ID = runtime.oracleTaskSchedulerQueueId;
  }

  if (runtime.oracleTasksPackageId) {
    runtimeOverrides.ORACLE_TASKS_PACKAGE_ID = runtime.oracleTasksPackageId;
  }

  if (runtime.iotaRandomObjectId) {
    runtimeOverrides.IOTA_RANDOM_OBJECT_ID = runtime.iotaRandomObjectId;
  }

  if (runtime.iotaClockObjectId) {
    runtimeOverrides.IOTA_CLOCK_OBJECT_ID = runtime.iotaClockObjectId;
    runtimeOverrides.IOTA_CLOCK_ID = runtime.iotaClockObjectId;
  }

  return {
    ...preparationEnvironment(process.env, parsed),
    ...runtimeOverrides,
  };
}

async function spawnClientCommand(args: string[], network?: OracleNetwork) {
  if (args[0] !== "run" || args[1] !== "create" || args[2] !== "--" ||
      !["prepare-webview", "prepare-task-schedule-webview", "prepare-scheduled-task-action-webview"].includes(args[3])) {
    throw new Error("Only wallet preparation commands are supported.");
  }
  const env = await buildClientEnv(network);
  const effectiveArgs = ["--silent", ...args];

  if (process.platform === "win32") {
    return spawn("cmd.exe", ["/d", "/s", "/c", "npm", ...effectiveArgs], {
      cwd: config.oracleClientDir,
      shell: false,
      env,
    });
  }

  return spawn(npmCommand(), effectiveArgs, {
    cwd: config.oracleClientDir,
    shell: false,
    env,
  });
}

function childTimeoutMs(): number {
  const raw = process.env.WEBVIEW_CLIENT_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 120_000;
}

function terminateChild(child: ChildProcess, reason: string) {
  if (child.killed || child.exitCode != null) return;

  try {
    if (process.platform === "win32") {
      void spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        shell: false,
      });
      return;
    }

    child.kill("SIGTERM");
    setTimeout(() => {
      if (!child.killed && child.exitCode == null) {
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  } catch {
    console.warn(`[iota_oracle_webview] failed to terminate child (${reason}) pid=${String(child.pid ?? "?")}`);
  }
}

function installCleanupHooks() {
  if (cleanupHooksInstalled) return;
  cleanupHooksInstalled = true;

  const cleanup = (reason: string) => {
    for (const child of activeChildren) {
      terminateChild(child, reason);
    }
  };

  process.on("exit", () => cleanup("exit"));
  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
}

async function runChildCommand(childFactory: () => Promise<ChildProcess>) {
  if (reservedChildren >= 4) throw new Error("Preparation capacity reached. Retry later.");
  reservedChildren++;
  try {
    installCleanupHooks();

    const child = await childFactory();
    activeChildren.add(child);

    return await new Promise<{
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const timeout = setTimeout(() => {
        terminateChild(child, "timeout");
      }, childTimeoutMs());

      child.stdout?.on("data", (chunk) => {
        stdout += String(chunk);
      });

      child.stderr?.on("data", (chunk) => {
        stderr += String(chunk);
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        activeChildren.delete(child);
        reject(error);
      });

      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        activeChildren.delete(child);
        resolve({ stdout, stderr, exitCode });
      });
    });
  } finally { reservedChildren--; }
}

function extractJsonFromStdout(stdout: string): any {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Wallet preparation returned empty stdout.");
  }

  try {
    return JSON.parse(trimmed);
  } catch {}

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }

  const firstBrace = trimmed.indexOf("{");
  if (firstBrace >= 0) {
    const candidate = trimmed.slice(firstBrace).trim();
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  throw new Error("Wallet preparation did not return valid JSON.");
}

function normalizeTaskPayloadInput(input: unknown): Record<string, unknown> {
  let value: unknown = input;

  if (typeof value === "string") {
    value = JSON.parse(value);
  }

  if (!value || typeof value !== "object") {
    throw new Error("Task payload must be a JSON object.");
  }

  const record = value as Record<string, unknown>;

  const unwrapped = record.task ?? record.payload ?? record.taskJson ?? record.json ?? record;

  let task: unknown = unwrapped;

  if (typeof task === "string") {
    task = JSON.parse(task);
  }

  if (!task || typeof task !== "object") {
    throw new Error("Normalized task payload must be a JSON object.");
  }

  const normalized = { ...(task as Record<string, unknown>) };

  if (typeof normalized.template_id === "string" && /^\d+$/.test(normalized.template_id)) {
    normalized.template_id = Number(normalized.template_id);
  }

  if (typeof normalized.template_id !== "number" || !Number.isFinite(normalized.template_id)) {
    throw new Error('Task JSON must contain numeric "template_id"');
  }

  return normalized;
}


async function spawnPrepareWalletTask(taskFilePath: string, sender: string, network?: OracleNetwork) {
  return spawnClientCommand(["run", "create", "--", "prepare-webview", taskFilePath, sender], network);
}

async function spawnPrepareTaskScheduleWalletTask(
  taskFilePath: string,
  scheduleFilePath: string,
  sender: string,
  network?: OracleNetwork,
) {
  return spawnClientCommand(
    ["run", "create", "--", "prepare-task-schedule-webview", taskFilePath, scheduleFilePath, sender],
    network,
  );
}

async function spawnPrepareScheduledTaskActionWalletTask(
  actionFilePath: string,
  sender: string,
  network?: OracleNetwork,
) {
  return spawnClientCommand(
    ["run", "create", "--", "prepare-scheduled-task-action-webview", actionFilePath, sender],
    network,
  );
}

export async function listExampleTasks() {
  try {
    const entries = await fs.readdir(config.oracleExamplesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => ({
        name: entry.name,
        path: path.join(config.oracleExamplesDir, entry.name),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export async function readExampleTask(exampleName: string) {
  await fs.access(config.oracleExamplesDir).catch(() => {
    throw new Error(`Oracle examples directory not found: ${config.oracleExamplesDir}`);
  });

  const fullPath = path.resolve(config.oracleExamplesDir, exampleName);
  if (!fullPath.startsWith(config.oracleExamplesDir)) {
    throw new Error("Invalid example path.");
  }

  const content = await fs.readFile(fullPath, "utf8");
  return JSON.parse(content);
}

export async function prepareOracleTaskForWallet(task: unknown, sender: string, network?: OracleNetwork) {
  await fs.access(config.oracleClientDir).catch(() => {
    throw new Error(`Oracle client directory not found: ${config.oracleClientDir}`);
  });

  const normalizedSender = String(sender ?? "").trim();
  if (!/^0x[0-9a-f]{1,64}$/i.test(normalizedSender)) {
    throw new Error("A valid wallet sender address is required.");
  }

  const normalizedTask = normalizeTaskPayloadInput(task);

  await fs.mkdir(path.join(os.tmpdir(), "iota_oracle_webview"), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "iota_oracle_webview", "task-"));
  const taskFilePath = path.join(tempDir, "task.json");
  await fs.writeFile(taskFilePath, `${JSON.stringify(normalizedTask, null, 2)}\n`, "utf8");

  const startedAt = new Date().toISOString();
  try {
    const result = await runChildCommand(() => spawnPrepareWalletTask(taskFilePath, normalizedSender, network));

    if (result.exitCode !== 0) {
      const code = (result.stderr + result.stdout).match(/TASK_[A-Z_0-9]+/)?.[0];
      console.warn(JSON.stringify({ event: "preparation_failed", code: code || "PREPARATION_FAILED" }));
      throw new Error(code || "Wallet preparation failed. Check task parameters, wallet balance and network availability.");
    }

    const parsed = extractJsonFromStdout(result.stdout);

    return {
      ...parsed,
      exitCode: result.exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function prepareOracleTaskScheduleForWallet(
  task: unknown,
  schedule: unknown,
  sender: string,
  network?: OracleNetwork,
) {
  await fs.access(config.oracleClientDir).catch(() => {
    throw new Error(`Oracle client directory not found: ${config.oracleClientDir}`);
  });

  const normalizedSender = String(sender ?? "").trim();
  if (!/^0x[0-9a-f]{1,64}$/i.test(normalizedSender)) {
    throw new Error("A valid wallet sender address is required.");
  }

  const normalizedTask = normalizeTaskPayloadInput(task);
  const normalizedSchedule =
    schedule && typeof schedule === "object" && !Array.isArray(schedule)
      ? { ...(schedule as Record<string, unknown>) }
      : (() => {
          throw new Error("Schedule payload must be a JSON object.");
        })();

  await fs.mkdir(path.join(os.tmpdir(), "iota_oracle_webview"), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "iota_oracle_webview", "task-schedule-"));
  const taskFilePath = path.join(tempDir, "task.json");
  const scheduleFilePath = path.join(tempDir, "schedule.json");
  await fs.writeFile(taskFilePath, `${JSON.stringify(normalizedTask, null, 2)}\n`, "utf8");
  await fs.writeFile(scheduleFilePath, `${JSON.stringify(normalizedSchedule, null, 2)}\n`, "utf8");

  const startedAt = new Date().toISOString();
  try {
    const result = await runChildCommand(
      () => spawnPrepareTaskScheduleWalletTask(taskFilePath, scheduleFilePath, normalizedSender, network),
    );

    if (result.exitCode !== 0) {
      const code = (result.stderr + result.stdout).match(/TASK_[A-Z_0-9]+/)?.[0];
      console.warn(JSON.stringify({ event: "preparation_failed", code: code || "PREPARATION_FAILED" }));
      throw new Error(code || "Wallet preparation failed. Check task parameters, wallet balance and network availability.");
    }

    const parsed = extractJsonFromStdout(result.stdout);

    return {
      ...parsed,
      exitCode: result.exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function prepareScheduledTaskActionForWallet(
  action: unknown,
  sender: string,
  network?: OracleNetwork,
) {
  await fs.access(config.oracleClientDir).catch(() => {
    throw new Error(`Oracle client directory not found: ${config.oracleClientDir}`);
  });

  const normalizedSender = String(sender ?? "").trim();
  if (!/^0x[0-9a-f]{1,64}$/i.test(normalizedSender)) {
    throw new Error("A valid wallet sender address is required.");
  }

  const normalizedAction =
    action && typeof action === "object" && !Array.isArray(action)
      ? { ...(action as Record<string, unknown>) }
      : (() => {
          throw new Error("Scheduled task action payload must be a JSON object.");
        })();

  await fs.mkdir(path.join(os.tmpdir(), "iota_oracle_webview"), { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "iota_oracle_webview", "scheduled-task-action-"));
  const actionFilePath = path.join(tempDir, "action.json");
  await fs.writeFile(actionFilePath, `${JSON.stringify(normalizedAction, null, 2)}\n`, "utf8");

  const startedAt = new Date().toISOString();
  try {
    const result = await runChildCommand(
      () => spawnPrepareScheduledTaskActionWalletTask(actionFilePath, normalizedSender, network),
    );

    if (result.exitCode !== 0) {
      const code = (result.stderr + result.stdout).match(/TASK_[A-Z_0-9]+/)?.[0];
      console.warn(JSON.stringify({ event: "preparation_failed", code: code || "PREPARATION_FAILED" }));
      throw new Error(code || "Wallet preparation failed. Check task parameters, wallet balance and network availability.");
    }

    const parsed = extractJsonFromStdout(result.stdout);

    return {
      ...parsed,
      exitCode: result.exitCode,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
