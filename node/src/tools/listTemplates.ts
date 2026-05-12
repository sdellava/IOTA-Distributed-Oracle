// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import "dotenv/config";
import { iotaClient } from "../iota.js";
import { getStateId } from "../config/env.js";

type TaskTemplate = {
  templateId: number;
  taskType: string;
  isEnabled: boolean;
  basePriceIota: string | null;
  maxInputBytes: string | null;
  maxOutputBytes: string | null;
  allowStorage: boolean;
};

type PendingProposal = {
  proposalId: number;
  kind: "upsert" | "remove" | "unknown";
  templateId: number;
  approvals: number;
  electorateSize: number;
  approvalsNeeded: number;
};

type OracleNetwork = "devnet" | "testnet" | "mainnet";

const RETRYABLE_PATTERNS = [
  "fetch failed",
  "network",
  "timeout",
  "timed out",
  "econnreset",
  "socket hang up",
  "failed to fetch",
];

function parseArgs(argv: string[]) {
  const raw = argv.slice(2);
  const flags = new Set<string>();
  let network: OracleNetwork | null = null;
  let stateId: string | null = null;

  for (let i = 0; i < raw.length; i += 1) {
    const token = String(raw[i] ?? "").trim();
    const normalized = token.toLowerCase();

    if (normalized === "--network") {
      const next = String(raw[i + 1] ?? "").trim();
      if (!next) throw new Error("Missing value for --network");
      i += 1;
      const v = normalizeNetwork(next);
      if (!v) throw new Error(`Invalid --network value: ${next}. Use devnet|testnet|mainnet`);
      network = v;
      continue;
    }

    if (normalized.startsWith("--network=")) {
      const next = normalized.slice("--network=".length).trim();
      const v = normalizeNetwork(next);
      if (!v) throw new Error(`Invalid --network value: ${next}. Use devnet|testnet|mainnet`);
      network = v;
      continue;
    }

    if (normalized === "--state-id") {
      const next = String(raw[i + 1] ?? "").trim();
      if (!next) throw new Error("Missing value for --state-id");
      i += 1;
      stateId = next;
      continue;
    }

    if (normalized.startsWith("--state-id=")) {
      const next = token.slice("--state-id=".length).trim();
      if (!next) throw new Error("Missing value for --state-id");
      stateId = next;
      continue;
    }

    flags.add(normalized);
  }

  return {
    pending: flags.has("--pending"),
    pendingOnly: flags.has("--pending-only"),
    json: flags.has("--json"),
    help: flags.has("--help") || flags.has("-h"),
    network,
    stateId,
  };
}

function normalizeNetwork(value: string): OracleNetwork | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "dev" || v === "devnet" || v === "local" || v === "localnet") return "devnet";
  if (v === "test" || v === "testnet") return "testnet";
  if (v === "main" || v === "mainnet") return "mainnet";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function extractFields(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (!record) return null;
  const fields = asRecord(record.fields);
  if (fields) return fields;
  const content = asRecord(record.content);
  if (content) return extractFields(content);
  const nestedValue = asRecord(record.value);
  if (nestedValue) return nestedValue;
  return null;
}

function toNum(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }
  const record = asRecord(value);
  if (!record) return 0;
  return toNum(record.value);
}

function toTemplateId(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }
  const record = asRecord(value);
  if (!record || !("value" in record)) return null;
  return toTemplateId(record.value);
}

function toStr(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (Array.isArray(value) && value.every((x) => typeof x === "number")) {
    try {
      return new TextDecoder().decode(Uint8Array.from(value as number[]));
    } catch {
      return "";
    }
  }
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.value === "string") return record.value;
  if (Array.isArray(record.bytes) && record.bytes.every((x) => typeof x === "number")) {
    return toStr(record.bytes);
  }
  return "";
}

function toBool(value: unknown): boolean {
  return toNum(value) !== 0;
}

function toArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["items", "contents", "vec", "value"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function majorityThreshold(total: number): number {
  if (total <= 0) return 0;
  return Math.floor(total / 2) + 1;
}

function isRetryableError(error: unknown): boolean {
  const msg = String((error as any)?.message ?? error ?? "").toLowerCase();
  return RETRYABLE_PATTERNS.some((pattern) => msg.includes(pattern));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(label: string, fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt >= maxAttempts) break;
      const backoffMs = 400 * attempt;
      console.error(`[warn] ${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${backoffMs} ms: ${String((error as any)?.message ?? error)}`);
      await sleep(backoffMs);
    }
  }
  throw lastError;
}

async function getStateFields(stateIdOverride?: string | null) {
  const stateId = String(stateIdOverride ?? "").trim() || getStateId();
  const client = iotaClient();
  const res: any = await withRetry("getObject(state)", () =>
    client.getObject({
      id: stateId,
      options: { showContent: true },
    }),
  );
  const fields = extractFields(res?.data?.content);
  if (!fields) throw new Error(`Cannot parse state object fields for ${stateId}`);
  return { client, stateId, fields };
}

async function listTemplateDynamicFields(client: any, stateId: string): Promise<TaskTemplate[]> {
  const out: TaskTemplate[] = [];
  let cursor: string | null | undefined = null;

  for (;;) {
    const page: any = await withRetry("getDynamicFields(state)", () =>
      client.getDynamicFields({ parentId: stateId, cursor, limit: 50 }),
    );
    for (const item of page?.data ?? []) {
      const nameType = String(item?.name?.type ?? "");
      if (!nameType.includes("TaskTemplateKey")) continue;
      const objectId = String(item?.objectId ?? "").trim();
      if (!objectId) continue;

      const obj: any = await withRetry(`getObject(template:${objectId})`, () =>
        client.getObject({ id: objectId, options: { showContent: true } }),
      );
      const outerFields = extractFields(obj?.data?.content);
      if (!outerFields) continue;
      const valueFields = extractFields(outerFields.value) ?? asRecord(outerFields.value);
      if (!valueFields) continue;

      const templateId = toTemplateId(valueFields.template_id);
      if (templateId == null || templateId < 0) continue;

      out.push({
        templateId,
        taskType: toStr(valueFields.task_type),
        isEnabled: toBool(valueFields.is_enabled),
        basePriceIota: toStr(valueFields.base_price_iota) || null,
        maxInputBytes: toStr(valueFields.max_input_bytes) || null,
        maxOutputBytes: toStr(valueFields.max_output_bytes) || null,
        allowStorage: toBool(valueFields.allow_storage),
      });
    }

    if (!page?.hasNextPage || !page?.nextCursor) break;
    cursor = page.nextCursor;
  }

  out.sort((a, b) => a.templateId - b.templateId);
  return out;
}

function getPendingProposals(fields: Record<string, unknown>): PendingProposal[] {
  const items = toArray(fields.template_proposals);
  const out: PendingProposal[] = [];

  for (const item of items) {
    const p = extractFields(item) ?? asRecord(item) ?? {};
    const proposalId = toNum(p.proposal_id);
    const kindRaw = toNum(p.proposal_kind);
    const kind = kindRaw === 1 ? "upsert" : kindRaw === 2 ? "remove" : "unknown";
    const templateId = toTemplateId(p.template_id);
    const approvals = toNum(p.approvals);
    const electorateSize = toNum(p.electorate_size);
    const approvalsNeeded = majorityThreshold(electorateSize);
    if (proposalId <= 0 || templateId == null || templateId < 0) continue;

    out.push({
      proposalId,
      kind,
      templateId,
      approvals,
      electorateSize,
      approvalsNeeded,
    });
  }

  out.sort((a, b) => a.proposalId - b.proposalId);
  if (out.length > 0) return out;

  // Backward compatibility with single-proposal state layout.
  const active = toNum(fields.template_proposal_active);
  if (active === 1) {
    const proposalId = toNum(fields.template_proposal_id);
    const kindRaw = toNum(fields.template_proposal_kind);
    const kind = kindRaw === 1 ? "upsert" : kindRaw === 2 ? "remove" : "unknown";
    const templateId = toTemplateId(fields.proposed_template_id);
    const approvals = toNum(fields.template_proposal_approvals);
    const electorateSize = toNum(fields.template_proposal_electorate_size);
    const approvalsNeeded = majorityThreshold(electorateSize);
    if (proposalId > 0 && templateId != null && templateId >= 0) {
      out.push({
        proposalId,
        kind,
        templateId,
        approvals,
        electorateSize,
        approvalsNeeded,
      });
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage:
  npm exec tsx src/tools/listTemplates.ts [--network devnet|testnet|mainnet] [--state-id 0x...] [--pending] [--pending-only] [--json]

Options:
  --network      Force network for env resolution (sets IOTA_NETWORK for this process)
  --state-id     Override the oracle state object id to inspect
  --pending       Also show pending template proposals
  --pending-only  Show only pending proposal details
  --json          Print JSON output
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  if (args.network) {
    process.env.IOTA_NETWORK = args.network;
  }

  const { client, stateId, fields } = await getStateFields(args.stateId);
  const pending = getPendingProposals(fields);
  const approved = await listTemplateDynamicFields(client, stateId);
  const resolvedNetwork = normalizeNetwork(String(process.env.IOTA_NETWORK ?? "")) ?? "mainnet";

  const out = {
    network: resolvedNetwork,
    stateId,
    approvedTemplates: approved,
    pendingProposals: pending,
  };

  if (args.json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (!args.pendingOnly) {
    console.log(`Network: ${resolvedNetwork}`);
    console.log(`State: ${stateId}`);
    console.log(`Approved templates: ${approved.length}`);
    for (const t of approved) {
      console.log(
        `- id=${t.templateId} type=${t.taskType || "-"} enabled=${t.isEnabled ? "yes" : "no"} storage=${t.allowStorage ? "yes" : "no"} base=${t.basePriceIota ?? "-"}`,
      );
    }
  }

  if (args.pending || args.pendingOnly) {
    console.log("");
    if (pending.length === 0) {
      console.log("Pending proposals: none");
    } else {
      console.log(`Pending proposals: ${pending.length}`);
      for (const p of pending) {
        console.log(`- proposal_id=${p.proposalId} kind=${p.kind} template_id=${p.templateId} approvals=${p.approvals}/${p.approvalsNeeded}`);
      }
    }
  }
}

main().catch((e: any) => {
  console.error(
    JSON.stringify(
      {
        error: "template_list_failed",
        message: e?.message ?? String(e),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
