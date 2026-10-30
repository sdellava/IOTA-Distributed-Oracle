import { readClient, boundedFetch } from "../upstream.js";
// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { toB64 } from "@iota/bcs";
import { IotaClient } from "@iota/iota-sdk/client";
import { Transaction } from "@iota/iota-sdk/transactions";
import { getRuntimeConfig, type OracleNetwork } from "../config.js";
import type {
  PreparedNodeManagementWalletResponse,
  PreparedProposalApprovalWalletResponse,
} from "../types.js";

type RegisteredNodeRecord = {
  address: string;
  pubkeyBytes: number[];
  delegatedControllerCapId: string | null;
  acceptedTemplateIds: string[];
};

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

function normalizeAddress(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  return text.startsWith("0x") ? text : `0x${text}`;
}

function toObjectId(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = normalizeAddress(value);
    return normalized || null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const key of ["objectId", "object_id", "id", "value"]) {
    const nested = record[key];
    if (typeof nested === "string") {
      const normalized = normalizeAddress(nested);
      if (normalized) return normalized;
    }
  }
  for (const key of ["fields", "content"]) {
    const nested = record[key];
    const nestedId = toObjectId(nested);
    if (nestedId) return nestedId;
  }
  return null;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n) : null;
  }
  const record = asRecord(value);
  if (!record) return null;
  return toNumber(record.value);
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

function toByteArray(value: unknown): number[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) return value as number[];
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["bytes", "value", "data", "contents"]) {
    const nested = record[key];
    if (Array.isArray(nested) && nested.every((item) => typeof item === "number")) return nested as number[];
  }
  return [];
}

function normalizeTemplateIds(value: unknown): number[] {
  const ids = toArray(value)
    .map((item) => toNumber(item))
    .filter((item): item is number => item != null && item >= 0);
  return Array.from(new Set(ids)).sort((a, b) => a - b);
}

function registrationMode(networkRaw: string | undefined): "dev" | "prod" {
  const normalized = String(networkRaw ?? "").trim().toLowerCase();
  return normalized === "dev" || normalized === "devnet" || normalized === "local" || normalized === "localnet"
    ? "dev"
    : "prod";
}

function gasBudget(): number {
  const raw = process.env.WEBVIEW_NODE_MANAGEMENT_GAS_BUDGET?.trim() || process.env.GAS_BUDGET?.trim();
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 50_000_000;
}

async function serializeTransactionForWallet(tx: Transaction, client: IotaClient): Promise<string> {
  const bytes = await tx.build({ client });
  return toB64(bytes);
}

async function getStateFields(client: IotaClient, stateId: string): Promise<Record<string, unknown>> {
  const response: any = await client.getObject({
    id: stateId,
    options: { showContent: true },
  });
  const fields = extractFields(response?.data?.content);
  if (!fields) throw new Error(`Unable to parse oracle state ${stateId}`);
  return fields;
}

async function resolveNodeRegistryId(client: IotaClient, stateId: string): Promise<string> {
  const stateFields = await getStateFields(client, stateId);
  const nodeRegistryId = toObjectId(stateFields.node_registry_id);
  if (!nodeRegistryId) throw new Error(`State ${stateId} does not expose node_registry_id`);
  return nodeRegistryId;
}

async function readRegisteredNode(client: IotaClient, stateId: string, sender: string): Promise<RegisteredNodeRecord | null> {
  const nodeRegistryId = await resolveNodeRegistryId(client, stateId);
  const response: any = await client.getObject({
    id: nodeRegistryId,
    options: { showContent: true },
  });
  const fields = extractFields(response?.data?.content) ?? {};
  const senderAddress = normalizeAddress(sender);
  for (const item of toArray(fields.oracle_nodes)) {
    const nodeFields = extractFields(item) ?? asRecord(item) ?? {};
    const address = normalizeAddress(nodeFields.addr);
    if (!address || address !== senderAddress) continue;
    return {
      address,
      pubkeyBytes: toByteArray(nodeFields.pubkey),
      delegatedControllerCapId: toObjectId(nodeFields.delegated_controller_cap_id),
      acceptedTemplateIds: normalizeTemplateIds(nodeFields.accepted_template_ids).map(String),
    };
  }
  return null;
}

export async function prepareNodeManagementForWallet(
  sender: string,
  acceptedTemplateIds: number[],
  network?: OracleNetwork,
): Promise<PreparedNodeManagementWalletResponse> {
  const runtime = getRuntimeConfig(network);
  if (!runtime.oracleStateId) throw new Error("ORACLE_STATE_ID is not configured for the selected network.");
  if (!runtime.oracleSystemPackageId) throw new Error("ORACLE_SYSTEM_PACKAGE_ID is not configured for the selected network.");

  const client = readClient(runtime.rpcUrl);
  const normalizedSender = normalizeAddress(sender);
  if (!normalizedSender) throw new Error("Wallet sender address is required.");

  const node = await readRegisteredNode(client, runtime.oracleStateId, normalizedSender);
  if (!node) {
    throw new Error(`No registered oracle node found for wallet ${normalizedSender}.`);
  }
  if (!node.pubkeyBytes.length) {
    throw new Error(`Registered oracle node ${normalizedSender} does not expose a pubkey.`);
  }

  const uniqueTemplateIds = Array.from(
    new Set(
      acceptedTemplateIds
        .map((item) => Math.floor(Number(item)))
        .filter((item) => Number.isFinite(item) && item >= 0),
    ),
  ).sort((a, b) => a - b);

  const mode = registrationMode(runtime.network);
  const registryId = await resolveNodeRegistryId(client, runtime.oracleStateId);
  const tx = new Transaction();
  tx.setSender(normalizedSender);
  tx.setGasBudget(gasBudget());

  if (mode === "dev") {
    tx.moveCall({
      target: `${runtime.oracleSystemPackageId}::systemState::register_oracle_node_dev`,
      arguments: [
        tx.object(registryId),
        tx.pure.address(normalizedSender),
        tx.pure.vector("u8", node.pubkeyBytes),
        tx.pure.vector("u64", uniqueTemplateIds.map((item) => String(item))),
      ],
    });
  } else {
    if (!node.delegatedControllerCapId) {
      throw new Error(`Node ${normalizedSender} does not expose a delegated controller cap required for prod registration.`);
    }
    tx.moveCall({
      target: `${runtime.oracleSystemPackageId}::systemState::register_oracle_node`,
      arguments: [
        tx.object(registryId),
        tx.object(runtime.oracleStateId),
        tx.object("0x5"),
        tx.object(node.delegatedControllerCapId),
        tx.pure.address(normalizedSender),
        tx.pure.vector("u8", node.pubkeyBytes),
        tx.pure.vector("u64", uniqueTemplateIds.map((item) => String(item))),
      ],
    });
  }

  return {
    ok: true,
    mode: "prepare-node-management-webview",
    sender: normalizedSender,
    nodeAddress: node.address,
    serializedTransaction: await serializeTransactionForWallet(tx, client),
    gasBudget: String(gasBudget()),
    acceptedTemplateIds: uniqueTemplateIds.map(String),
    target:
      mode === "dev"
        ? `${runtime.oracleSystemPackageId}::systemState::register_oracle_node_dev`
        : `${runtime.oracleSystemPackageId}::systemState::register_oracle_node`,
    registrationMode: mode,
    delegatedControllerCapId: node.delegatedControllerCapId,
  };
}

export async function prepareProposalApprovalForWallet(
  sender: string,
  proposalId: number,
  templateId: number,
  network?: OracleNetwork,
): Promise<PreparedProposalApprovalWalletResponse> {
  const runtime = getRuntimeConfig(network);
  if (!runtime.oracleStateId) throw new Error("ORACLE_STATE_ID is not configured for the selected network.");
  if (!runtime.oracleSystemPackageId) throw new Error("ORACLE_SYSTEM_PACKAGE_ID is not configured for the selected network.");

  const normalizedSender = normalizeAddress(sender);
  if (!normalizedSender) throw new Error("Wallet sender address is required.");

  const tx = new Transaction();
  tx.setSender(normalizedSender);
  tx.setGasBudget(gasBudget());
  tx.moveCall({
    target: `${runtime.oracleSystemPackageId}::systemState::approve_task_template_proposal`,
    arguments: [
      tx.object(await resolveNodeRegistryId(readClient(runtime.rpcUrl), runtime.oracleStateId)),
      tx.object(runtime.oracleStateId),
      tx.object(runtime.iotaClockObjectId || "0x6"),
      tx.pure.u64(String(proposalId)),
    ],
  });

  return {
    ok: true,
    mode: "prepare-proposal-approval-webview",
    sender: normalizedSender,
    proposalId: String(proposalId),
    templateId: String(templateId),
    serializedTransaction: await serializeTransactionForWallet(tx, readClient(runtime.rpcUrl)),
    gasBudget: String(gasBudget()),
    target: `${runtime.oracleSystemPackageId}::systemState::approve_task_template_proposal`,
  };
}
