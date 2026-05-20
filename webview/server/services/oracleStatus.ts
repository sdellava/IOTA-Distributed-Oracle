// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { IotaClient } from "@iota/iota-sdk/client";
import { config, getRuntimeConfig, type OracleNetwork } from "../config.js";
import type {
  NodeActivity,
  OracleEventItem,
  OracleStatusResponse,
  OracleTemplateCost,
  PendingTemplateProposal,
  RegisteredOracleNode,
} from "../types.js";

type RpcEvent = {
  id?: { txDigest?: string; eventSeq?: string };
  sender?: string;
  transactionModule?: string;
  type?: string;
  parsedJson?: unknown;
  timestampMs?: string;
};

type RpcObjectResponse = {
  data?: {
    content?: unknown;
  };
};

type RpcSystemStateSummary = {
  activeValidators?: unknown[];
  active_validators?: unknown[];
};

type RpcDynamicFieldPage = {
  data?: Array<{
    objectId?: string;
    objectType?: string;
    name?: {
      type?: string;
      value?: unknown;
    };
  }>;
  hasNextPage?: boolean;
  nextCursor?: string | null;
};

type GraphqlTaskObjectsResponse = {
  data?: {
    objects?: {
      nodes?: Array<{ address?: string }>;
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
      };
    };
  };
  errors?: Array<{ message?: string }>;
};

type GraphqlEventsResponse = {
  data?: {
    events?: {
      nodes?: Array<{ timestamp?: string | null }>;
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
      };
    };
  };
  errors?: Array<{ message?: string }>;
};

type TaskObjectCountCacheEntry = {
  value: number | null;
  fetchedAtMs: number;
};

const TASK_OBJECT_COUNT_CACHE_TTL_MS = 30_000;
const EXECUTION_MESSAGE_KINDS = new Set([2, 3, 4, 7]);
const taskObjectCountCache = new Map<string, TaskObjectCountCacheEntry>();
const totalOracleEventsCache = new Map<string, TaskObjectCountCacheEntry>();

function normalizeAddress(value: string): string {
  const t = String(value ?? "").trim().toLowerCase();
  if (!t) return "";
  return t.startsWith("0x") ? t : `0x${t}`;
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

function toU64String(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.value === "string") return record.value;
  if (typeof record.value === "number" || typeof record.value === "bigint") return String(record.value);
  if (typeof record.id === "string") return record.id;
  return null;
}

function toBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "bigint") return value !== 0n;
  if (typeof value === "string") {
    const t = value.trim().toLowerCase();
    return t === "1" || t === "true" || t === "yes";
  }
  return false;
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

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
    try {
      return new TextDecoder().decode(Uint8Array.from(value as number[]));
    } catch {
      return String(value);
    }
  }
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.value === "string") return record.value;
  if (Array.isArray(record.bytes) && record.bytes.every((item) => typeof item === "number")) {
    return toText(record.bytes);
  }
  return "";
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

function toScalarString(value: unknown): string | null {
  const u64 = toU64String(value);
  if (u64 != null) return u64;

  if (typeof value === "boolean") return value ? "true" : "false";

  const text = toText(value).trim();
  return text || null;
}

function collectStringValues(value: unknown, out: string[]): void {
  const scalar = toScalarString(value);
  if (scalar != null) {
    out.push(scalar);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
    return;
  }

  const record = asRecord(value);
  if (!record) return;

  const nestedFields = extractFields(value);
  if (nestedFields && nestedFields !== record) {
    collectStringValues(nestedFields, out);
  }

  for (const key of ["items", "contents", "vec", "value", "fields", "data"]) {
    if (key in record) collectStringValues(record[key], out);
  }
}

function toStringArray(value: unknown): string[] {
  const out: string[] = [];
  collectStringValues(value, out);
  return out.filter((item, index) => item.length > 0 && out.indexOf(item) === index);
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

function extractByCandidateKeys(value: unknown, keys: string[]): string | null {
  const record = extractFields(value) ?? asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    if (!(key in record)) continue;
    const match = toObjectId(record[key]);
    if (match) return match;
  }
  return null;
}

function extractNestedObjectIdByCandidatePaths(value: unknown, paths: string[][]): string | null {
  const root = extractFields(value) ?? asRecord(value);
  if (!root) return null;
  for (const path of paths) {
    let current: unknown = root;
    let missing = false;
    for (const segment of path) {
      const record = extractFields(current) ?? asRecord(current);
      if (!record || !(segment in record)) {
        missing = true;
        break;
      }
      current = record[segment];
    }
    if (missing) continue;
    const match = toObjectId(current);
    if (match) return match;
  }
  return null;
}

function extractTextByCandidateKeys(value: unknown, keys: string[]): string | null {
  const record = extractFields(value) ?? asRecord(value);
  if (!record) return null;
  for (const key of keys) {
    if (!(key in record)) continue;
    const nested = record[key];
    const direct = toText(nested).trim();
    if (direct) return direct;

    const nestedFields = extractFields(nested) ?? asRecord(nested);
    if (!nestedFields) continue;
    for (const nestedKey of ["name", "value", "contents", "bytes"]) {
      if (!(nestedKey in nestedFields)) continue;
      const text = toText(nestedFields[nestedKey]).trim();
      if (text) return text;
    }
  }
  return null;
}

function extractNestedTextByCandidatePaths(value: unknown, paths: string[][]): string | null {
  const root = extractFields(value) ?? asRecord(value);
  if (!root) return null;
  for (const path of paths) {
    let current: unknown = root;
    let missing = false;
    for (const segment of path) {
      const record = extractFields(current) ?? asRecord(current);
      if (!record || !(segment in record)) {
        missing = true;
        break;
      }
      current = record[segment];
    }
    if (missing) continue;
    const direct = toText(current).trim();
    if (direct) return direct;
    const nested = extractFields(current) ?? asRecord(current);
    if (!nested) continue;
    for (const nestedKey of ["name", "value", "contents", "bytes"]) {
      if (!(nestedKey in nested)) continue;
      const text = toText(nested[nestedKey]).trim();
      if (text) return text;
    }
  }
  return null;
}

function extractDelegatedControllerCapId(value: unknown): string | null {
  return (
    extractByCandidateKeys(value, [
      "delegated_controller_cap",
      "delegated_controller_cap_id",
      "delegated_cap",
      "delegated_cap_id",
      "controller_cap",
      "controller_cap_id",
      "delegation",
      "delegation_cap",
      "delegation_cap_id",
    ]) ??
    extractNestedObjectIdByCandidatePaths(value, [
      ["delegation", "delegated_controller_cap"],
      ["delegation", "delegated_controller_cap_id"],
      ["delegation", "controller_cap"],
      ["delegation", "controller_cap_id"],
    ])
  );
}

function extractValidatorIdFromDelegatedCap(value: unknown): string | null {
  return (
    extractByCandidateKeys(value, [
      "validator_id",
      "validatorId",
      "validator_node_id",
      "validatorNodeId",
      "validator",
      "validator_node",
      "validator_address",
      "validatorAddress",
      "iota_address",
      "iotaAddress",
      "node_id",
      "nodeId",
      "staking_pool_id",
      "stakingPoolId",
    ]) ??
    extractNestedObjectIdByCandidatePaths(value, [
      ["validator", "id"],
      ["validator", "address"],
      ["validator_metadata", "iota_address"],
      ["validator_metadata", "iotaAddress"],
      ["metadata", "iota_address"],
      ["metadata", "iotaAddress"],
    ])
  );
}

function extractValidatorSummaryId(value: unknown): string | null {
  return (
    extractByCandidateKeys(value, [
      "validator_id",
      "validatorId",
      "validator_node_id",
      "validatorNodeId",
      "validator_address",
      "validatorAddress",
      "iota_address",
      "iotaAddress",
      "id",
      "node_id",
      "nodeId",
      "staking_pool_id",
      "stakingPoolId",
      "operationCapId",
      "operation_cap_id",
    ]) ??
    extractNestedObjectIdByCandidatePaths(value, [
      ["validator", "id"],
      ["validator", "address"],
      ["metadata", "iota_address"],
      ["metadata", "iotaAddress"],
    ])
  );
}

function extractValidatorSummaryName(value: unknown): string | null {
  return (
    extractTextByCandidateKeys(value, [
      "name",
      "validatorName",
      "validator_name",
      "metadata_name",
      "metadataName",
      "description",
    ]) ??
    extractNestedTextByCandidatePaths(value, [
      ["metadata", "name"],
      ["validator_metadata", "name"],
      ["details", "name"],
    ])
  );
}

function normalizeEvent(moduleName: string, event: RpcEvent): OracleEventItem {
  return {
    txDigest: event.id?.txDigest ?? "",
    eventSeq: event.id?.eventSeq ?? "",
    sender: normalizeAddress(event.sender ?? ""),
    module: event.transactionModule ?? moduleName,
    eventType: event.type ?? "",
    timestampMs: event.timestampMs ?? null,
    parsedJson: event.parsedJson ?? null,
  };
}

function eventRecord(event: OracleEventItem): Record<string, unknown> {
  return asRecord(event.parsedJson) ?? {};
}

function activitySender(event: OracleEventItem): string {
  const parsed = eventRecord(event);
  return normalizeAddress(String(parsed.sender ?? event.sender ?? ""));
}

function isExecutionMessageEvent(event: OracleEventItem): boolean {
  const parsed = eventRecord(event);
  const taskId = String(parsed.task_id ?? "").trim();
  const kind = Number(parsed.kind ?? -1);
  return Boolean(taskId) && EXECUTION_MESSAGE_KINDS.has(kind);
}

async function queryModuleEvents(
  client: IotaClient,
  packageId: string,
  moduleName: string,
  eventFetchLimit: number,
): Promise<OracleEventItem[]> {
  if (!packageId) return [];
  const page = await client.queryEvents({
    query: { MoveModule: { package: packageId, module: moduleName } },
    limit: eventFetchLimit,
  });
  return (page.data ?? []).map((event) => normalizeEvent(moduleName, event as RpcEvent));
}

function getGraphqlEndpoint(network: string | undefined): string | null {
  const normalized = String(network ?? "").trim().toLowerCase();
  if (normalized === "mainnet") return "https://graphql.mainnet.iota.cafe";
  if (normalized === "testnet") return "https://graphql.testnet.iota.cafe";
  if (normalized === "devnet") return "https://graphql.devnet.iota.cafe";
  if (normalized === "localnet") return "http://127.0.0.1:8000";
  return null;
}

async function fetchGraphqlPayload<T>(
  graphqlUrl: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL request failed: HTTP ${response.status}`);
  }

  return (await response.json()) as T;
}

async function countOnChainTaskObjects(
  network: string | undefined,
  packageId: string,
  warnings: string[],
): Promise<number | null> {
  if (!packageId) return null;

  const graphqlUrl = getGraphqlEndpoint(network);
  if (!graphqlUrl) return null;

  const structType = `${packageId}::oracle_tasks::Task`;
  const cacheKey = `${graphqlUrl}|${structType}`;
  const cached = taskObjectCountCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs < TASK_OBJECT_COUNT_CACHE_TTL_MS) {
    return cached.value;
  }

  const query = `
    query CountTaskObjects($type: String!, $after: String) {
      objects(first: 50, after: $after, filter: { type: $type }) {
        nodes {
          address
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  let total = 0;
  let cursor: string | null = null;

  try {
    for (;;) {
      const payload: GraphqlTaskObjectsResponse = await fetchGraphqlPayload<GraphqlTaskObjectsResponse>(graphqlUrl, query, {
        type: structType,
        after: cursor,
      });
      if (payload.errors?.length) {
        const message = payload.errors.map((item: { message?: string }) => item.message || "Unknown GraphQL error").join("; ");
        throw new Error(message);
      }

      const nodes = payload.data?.objects?.nodes ?? [];
      const pageInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined = payload.data?.objects?.pageInfo;
      total += nodes.length;

      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor ?? null;
      if (!cursor) break;
    }
  } catch (error) {
    warnings.push(`Unable to count on-chain task objects: ${String(error)}`);
    taskObjectCountCache.set(cacheKey, { value: null, fetchedAtMs: now });
    return null;
  }

  taskObjectCountCache.set(cacheKey, { value: total, fetchedAtMs: now });
  return total;
}

async function countModuleEventsViaGraphql(
  graphqlUrl: string,
  emittingModule: string,
): Promise<number> {
  const query = `
    query CountModuleEvents($module: String!, $after: String) {
      events(first: 50, after: $after, filter: { emittingModule: $module }) {
        nodes {
          timestamp
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  let total = 0;
  let cursor: string | null = null;

  for (;;) {
    const payload: GraphqlEventsResponse = await fetchGraphqlPayload<GraphqlEventsResponse>(graphqlUrl, query, {
      module: emittingModule,
      after: cursor,
    });
    if (payload.errors?.length) {
      const message = payload.errors.map((item: { message?: string }) => item.message || "Unknown GraphQL error").join("; ");
      throw new Error(message);
    }

    const nodes = payload.data?.events?.nodes ?? [];
    const pageInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined = payload.data?.events?.pageInfo;
    total += nodes.length;

    if (!pageInfo?.hasNextPage) break;
    cursor = pageInfo.endCursor ?? null;
    if (!cursor) break;
  }

  return total;
}

async function countTotalOracleEvents(
  network: string | undefined,
  packageId: string,
  warnings: string[],
): Promise<number | null> {
  if (!packageId) return null;

  const graphqlUrl = getGraphqlEndpoint(network);
  if (!graphqlUrl) return null;

  const cacheKey = `${graphqlUrl}|${packageId}|oracle-events`;
  const cached = totalOracleEventsCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.fetchedAtMs < TASK_OBJECT_COUNT_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const [taskModuleEvents, messageModuleEvents] = await Promise.all([
      countModuleEventsViaGraphql(graphqlUrl, `${packageId}::oracle_tasks`),
      countModuleEventsViaGraphql(graphqlUrl, `${packageId}::oracle_messages`),
    ]);
    const total = taskModuleEvents + messageModuleEvents;
    totalOracleEventsCache.set(cacheKey, { value: total, fetchedAtMs: now });
    return total;
  } catch (error) {
    warnings.push(`Unable to count total oracle events: ${String(error)}`);
    totalOracleEventsCache.set(cacheKey, { value: null, fetchedAtMs: now });
    return null;
  }
}

async function getStateObjectContent(client: IotaClient, stateId: string, warnings: string[]): Promise<unknown | null> {
  try {
    const response = (await client.getObject({ id: stateId, options: { showContent: true } })) as RpcObjectResponse;
    return response?.data?.content ?? null;
  } catch (error) {
    warnings.push(`Unable to read oracle system state: ${String(error)}`);
    return null;
  }
}

async function getNodeRegistryContent(client: IotaClient, stateId: string, warnings: string[]): Promise<unknown | null> {
  const stateContent = await getStateObjectContent(client, stateId, warnings);
  if (!stateContent) return null;
  const stateFields = extractFields(stateContent) ?? {};
  const nodeRegistryId = toObjectId(stateFields.node_registry_id);
  if (!nodeRegistryId) return stateContent;
  return getObjectContent(client, nodeRegistryId, warnings, "node registry");
}

async function getObjectContent(client: IotaClient, objectId: string, warnings: string[], label: string): Promise<unknown | null> {
  try {
    const response = (await client.getObject({ id: objectId, options: { showContent: true } })) as RpcObjectResponse;
    return response?.data?.content ?? null;
  } catch (error) {
    warnings.push(`Unable to read ${label} ${objectId}: ${String(error)}`);
    return null;
  }
}

function parseRegisteredNodes(content: unknown): RegisteredOracleNode[] {
  const stateFields = extractFields(content) ?? {};
  const oracleNodes = toArray(stateFields.oracle_nodes);
  const stateId = toObjectId(stateFields.id);

  const out: RegisteredOracleNode[] = [];
  for (const node of oracleNodes) {
    const fields = extractFields(node) ?? asRecord(node) ?? {};
    const nodeId = toNumber(fields.node_id ?? fields.nodeId);
    const address = normalizeAddress(String(fields.addr ?? (fields.addr as any)?.value ?? ""));
    if (!address) continue;
    const pubkey = fields.pubkey ?? null;
    const acceptedTemplateIds = toStringArray(fields.accepted_template_ids ?? fields.supported_template_ids);
    const delegatedControllerCapIdRaw = extractDelegatedControllerCapId(fields);
    const delegatedControllerCapId =
      delegatedControllerCapIdRaw && stateId && normalizeAddress(delegatedControllerCapIdRaw) === normalizeAddress(stateId)
        ? null
        : delegatedControllerCapIdRaw;
    const validatorAddress = normalizeAddress(String(fields.validator ?? (fields.validator as any)?.value ?? ""));
    out.push({
      nodeId: nodeId == null ? null : String(nodeId),
      address,
      pubkey,
      pubkeyBytes: toByteArray(pubkey).length,
      acceptedTemplateIds,
      delegatedControllerCapId,
      validatorId: validatorAddress || null,
    });
  }

  return out.sort((a, b) => a.address.localeCompare(b.address));
}

function parsePendingTemplateProposals(content: unknown): PendingTemplateProposal[] {
  const stateFields = extractFields(content) ?? {};
  const raw = toArray(stateFields.template_proposals);
  const proposals: PendingTemplateProposal[] = [];

  for (const item of raw) {
    const fields = extractFields(item) ?? asRecord(item) ?? {};
    const proposalId = toNumber(fields.proposal_id);
    const templateId = toNumber(fields.template_id);
    if (proposalId == null || templateId == null) continue;
    const electorateSize = toNumber(fields.electorate_size) ?? 0;
    proposals.push({
      proposalId: String(proposalId),
      templateId: String(templateId),
      proposalKind: toNumber(fields.proposal_kind) ?? 0,
      approvals: String(toNumber(fields.approvals) ?? 0),
      electorateSize: String(electorateSize),
      approvalsNeeded: String(Math.floor(electorateSize / 2) + 1),
      taskType: toText(fields.task_type).trim() || null,
      isEnabled: fields.is_enabled == null ? null : toBool(fields.is_enabled),
    });
  }

  proposals.sort((a, b) => Number(a.proposalId) - Number(b.proposalId));
  return proposals;
}

function formatAcceptedTasks(
  acceptedTemplateIds: string[],
  _templates: OracleTemplateCost[],
): string[] {
  return acceptedTemplateIds.map((templateId) => String(templateId));
}

function toNodeActivity(
  events: OracleEventItem[],
  activeThresholdMs: number,
  registeredNodes: RegisteredOracleNode[],
  registryWasRead = false,
): NodeActivity[] {
  const map = new Map<string, NodeActivity>();
  const allowed = new Set(registeredNodes.map((node) => normalizeAddress(node.address)).filter(Boolean));
  const restrictToRegistered = registryWasRead || allowed.size > 0;

  for (const node of registeredNodes) {
    const address = normalizeAddress(node.address);
    if (!address) continue;
    map.set(address, {
      sender: address,
      acceptedTasks: [],
      lastSeenMs: null,
      active: false,
    });
  }

  for (const event of events) {
    const sender = activitySender(event);
    if (!sender) continue;
    if (restrictToRegistered && !allowed.has(sender)) continue;

    const existing = map.get(sender);
    const candidateTs = event.timestampMs ?? null;
    const existingTs = existing?.lastSeenMs ?? null;
    const latestTs = Number(candidateTs ?? "0") >= Number(existingTs ?? "0") ? candidateTs : existingTs;
    const active = Number(latestTs ?? "0") >= activeThresholdMs;

    map.set(sender, {
      sender,
      acceptedTasks: existing?.acceptedTasks ?? [],
      lastSeenMs: latestTs,
      active,
    });
  }

  return [...map.values()].sort(
    (a, b) =>
      Number(b.lastSeenMs ?? "0") - Number(a.lastSeenMs ?? "0") ||
      b.acceptedTasks.length - a.acceptedTasks.length ||
      a.sender.localeCompare(b.sender),
  );
}

async function listDynamicFields(
  client: IotaClient,
  parentId: string,
  warnings: string[],
): Promise<NonNullable<RpcDynamicFieldPage["data"]>> {
  const out: NonNullable<RpcDynamicFieldPage["data"]> = [];
  let cursor: string | null | undefined = null;
  try {
    for (;;) {
      const page = (await (client as any).getDynamicFields({ parentId, cursor, limit: 50 })) as RpcDynamicFieldPage;
      out.push(...(page.data ?? []));
      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
      if (!cursor) break;
    }
  } catch (error) {
    warnings.push(`Unable to read state dynamic fields: ${String(error)}`);
  }
  return out;
}

function parseTaskTemplate(dynamicFieldContent: unknown): OracleTemplateCost | null {
  const outerFields = extractFields(dynamicFieldContent);
  if (!outerFields) return null;
  const valueFields = extractFields(outerFields.value) ?? asRecord(outerFields.value);
  if (!valueFields) return null;
  const templateId = toU64String(valueFields.template_id);
  if (!templateId) return null;
  return {
    templateId,
    taskType: toText(valueFields.task_type),
    isEnabled: toBool(valueFields.is_enabled),
    basePriceIota: toU64String(valueFields.base_price_iota),
    schedulerFeeIota: toU64String(valueFields.scheduler_fee_iota),
    maxInputBytes: toU64String(valueFields.max_input_bytes),
    maxOutputBytes: toU64String(valueFields.max_output_bytes),
    includedDownloadBytes: toU64String(valueFields.included_download_bytes),
    pricePerDownloadByteIota: toU64String(valueFields.price_per_download_byte_iota),
    allowStorage: toBool(valueFields.allow_storage),
    minRetentionDays: toU64String(valueFields.min_retention_days),
    maxRetentionDays: toU64String(valueFields.max_retention_days),
    pricePerRetentionDayIota: toU64String(valueFields.price_per_retention_day_iota),
  };
}

async function getConfiguredCosts(client: IotaClient, stateId: string, warnings: string[]) {
  const empty = { systemFeeBps: null, minPayment: null, templates: [] as OracleTemplateCost[] };
  if (!stateId) return empty;
  const content = await getStateObjectContent(client, stateId, warnings);
  if (!content) return empty;
  const stateFields = extractFields(content);
  if (!stateFields) {
    warnings.push("Unable to parse oracle system state fields.");
    return empty;
  }
  const dynamicFields = await listDynamicFields(client, stateId, warnings);
  const templateFields = dynamicFields.filter((item) => String(item.name?.type ?? "").includes("TaskTemplateKey"));
  const templates: OracleTemplateCost[] = [];
  for (const field of templateFields) {
    if (!field.objectId) continue;
    try {
      const response = (await client.getObject({ id: field.objectId, options: { showContent: true } })) as RpcObjectResponse;
      const template = parseTaskTemplate(response?.data?.content);
      if (template) templates.push(template);
    } catch (error) {
      warnings.push(`Unable to read task template dynamic field ${field.objectId}: ${String(error)}`);
    }
  }
  templates.sort((a, b) => Number(a.templateId) - Number(b.templateId));
  return {
    systemFeeBps: toU64String(stateFields.system_fee_bps),
    minPayment: toU64String(stateFields.min_payment),
    templates,
  };
}

async function getActiveValidatorSummaries(client: IotaClient, warnings: string[]): Promise<unknown[]> {
  try {
    const state = (await (client as any).getLatestIotaSystemState()) as RpcSystemStateSummary | null;
    if (!state) return [];
    if (Array.isArray(state.activeValidators)) return state.activeValidators;
    if (Array.isArray(state.active_validators)) return state.active_validators;
  } catch (error) {
    warnings.push(`Unable to read validator summaries: ${String(error)}`);
  }
  return [];
}

async function enrichRegisteredNodesWithValidatorInfo(
  client: IotaClient,
  nodes: RegisteredOracleNode[],
  warnings: string[],
): Promise<RegisteredOracleNode[]> {
  if (nodes.length === 0) return nodes;

  const validatorSummaries = await getActiveValidatorSummaries(client, warnings);
  const validatorNameById = new Map<string, string>();
  for (const summary of validatorSummaries) {
    const validatorId = extractValidatorSummaryId(summary);
    const validatorName = extractValidatorSummaryName(summary);
    if (!validatorId) {
      warnings.push(`Unable to extract validator id from active validator summary: ${JSON.stringify(summary)}`);
      continue;
    }
    if (!validatorName) {
      warnings.push(`Unable to extract validator name from active validator summary ${validatorId}.`);
      continue;
    }
    validatorNameById.set(validatorId, validatorName);
  }

  return Promise.all(
    nodes.map(async (node) => {
      if (!node.delegatedControllerCapId) {
        const validatorName = node.validatorId ? validatorNameById.get(node.validatorId) ?? null : null;
        return {
          ...node,
          validatorName,
        };
      }
      const capContent = await getObjectContent(
        client,
        node.delegatedControllerCapId,
        warnings,
        "delegated controller cap",
      );
      const validatorId = capContent ? extractValidatorIdFromDelegatedCap(capContent) : null;
      if (node.delegatedControllerCapId && capContent && !validatorId) {
        warnings.push(`Unable to extract validator id from delegated controller cap ${node.delegatedControllerCapId} for oracle node ${node.address}.`);
      }
      const validatorName = validatorId ? validatorNameById.get(validatorId) ?? null : null;
      if (validatorId && !validatorName) {
        warnings.push(`Validator summary not found for validator id ${validatorId} linked to oracle node ${node.address}.`);
      }
      return {
        ...node,
        validatorId: validatorId ?? node.validatorId ?? null,
        validatorName,
      };
    }),
  );
}

export async function getOracleStatus(network?: string): Promise<OracleStatusResponse> {
  const runtime = getRuntimeConfig(network as OracleNetwork | undefined);
  const client = new IotaClient({ url: runtime.rpcUrl });
  const warnings: string[] = [];
  if (!runtime.oracleTasksPackageId) {
    warnings.push("ORACLE_TASKS_PACKAGE_ID is not configured. Dashboard is running in degraded mode.");
  }

  const activeThresholdMs = Date.now() - config.activeWindowMinutes * 60 * 1000;
  let latestCheckpoint: string | null = null;
  try {
    latestCheckpoint = await client.getLatestCheckpointSequenceNumber();
  } catch (error) {
    warnings.push(`Unable to read latest checkpoint: ${String(error)}`);
  }

  const stateContent = runtime.oracleStateId ? await getStateObjectContent(client, runtime.oracleStateId, warnings) : null;
  const nodeRegistryContent = runtime.oracleStateId ? await getNodeRegistryContent(client, runtime.oracleStateId, warnings) : null;
  const hasReadableNodeRegistry = nodeRegistryContent != null;
  const registeredNodesRaw = hasReadableNodeRegistry ? parseRegisteredNodes(nodeRegistryContent) : [];
  const pendingTemplateProposals = stateContent ? parsePendingTemplateProposals(stateContent) : [];
  const registeredNodes = await enrichRegisteredNodesWithValidatorInfo(client, registeredNodesRaw, warnings);
  const registeredNodeAddresses = registeredNodes.map((node) => node.address);
  const configuredCosts = await getConfiguredCosts(client, runtime.oracleStateId, warnings);
  const validatorInfoByAddress = new Map(
    registeredNodes.map((node) => [
      normalizeAddress(node.address),
      {
        validatorId: node.validatorId ?? null,
        validatorName: node.validatorName ?? null,
      },
    ]),
  );
  const acceptedTasksByAddress = new Map(
    registeredNodes.map((node) => [
      normalizeAddress(node.address),
      formatAcceptedTasks(node.acceptedTemplateIds, configuredCosts.templates),
    ]),
  );

  let taskEvents: OracleEventItem[] = [];
  let messageEvents: OracleEventItem[] = [];
  if (runtime.oracleTasksPackageId) {
    try {
      [taskEvents, messageEvents] = await Promise.all([
        queryModuleEvents(client, runtime.oracleTasksPackageId, config.oracleTaskModule, config.eventFetchLimit),
        queryModuleEvents(client, runtime.oracleTasksPackageId, config.oracleMessageModule, config.eventFetchLimit),
      ]);
    } catch (error) {
      warnings.push(`Unable to query oracle events: ${String(error)}`);
    }
  }

  const combined = [...taskEvents, ...messageEvents].sort((a, b) => Number(b.timestampMs ?? "0") - Number(a.timestampMs ?? "0"));
  const executionMessages = messageEvents
    .filter(isExecutionMessageEvent)
    .sort((a, b) => Number(b.timestampMs ?? "0") - Number(a.timestampMs ?? "0"));
  const configuredNodeAddresses = [...new Set(config.oracleNodeAddresses.map(normalizeAddress).filter(Boolean))];
  const effectiveRegisteredNodes = hasReadableNodeRegistry
    ? registeredNodeAddresses
    : registeredNodeAddresses.length > 0
      ? registeredNodeAddresses
      : configuredNodeAddresses;
  const nodeActivity = toNodeActivity(
    executionMessages,
    activeThresholdMs,
    effectiveRegisteredNodes.map((address) => ({
      address,
      pubkey: null,
      pubkeyBytes: 0,
      acceptedTemplateIds: acceptedTasksByAddress.get(normalizeAddress(address))?.map((item) => item.split(" - ")[0]) ?? [],
      validatorId: validatorInfoByAddress.get(normalizeAddress(address))?.validatorId ?? null,
      validatorName: validatorInfoByAddress.get(normalizeAddress(address))?.validatorName ?? null,
    })),
    hasReadableNodeRegistry,
  ).map((node) => ({
    ...node,
    acceptedTasks: acceptedTasksByAddress.get(normalizeAddress(node.sender)) ?? [],
    validatorId: validatorInfoByAddress.get(normalizeAddress(node.sender))?.validatorId ?? null,
    validatorName: validatorInfoByAddress.get(normalizeAddress(node.sender))?.validatorName ?? null,
  }));
  const activeNodes = nodeActivity.filter((node) => node.active).length;
  const knownNodes = effectiveRegisteredNodes.length > 0 ? effectiveRegisteredNodes.length : null;
  const inactiveKnownNodes = knownNodes == null ? null : knownNodes - activeNodes;
  const onChainTaskObjects = await countOnChainTaskObjects(runtime.network, runtime.oracleTasksPackageId, warnings);
  const totalOracleEvents = await countTotalOracleEvents(runtime.network, runtime.oracleTasksPackageId, warnings);

  return {
    ok: true,
    mode: runtime.oracleTasksPackageId ? "live" : "degraded",
    network: runtime.network || "unknown",
    rpcUrl: runtime.rpcUrl,
    packageId: runtime.oracleTasksPackageId || null,
    tasksPackageId: runtime.oracleTasksPackageId || null,
    systemPackageId: runtime.oracleSystemPackageId || null,
    stateId: runtime.oracleStateId || null,
    latestCheckpoint,
    activeWindowMinutes: config.activeWindowMinutes,
    eventFetchLimit: config.eventFetchLimit,
    lastRefreshIso: new Date().toISOString(),
    metrics: {
      activeNodes,
      knownNodes,
      inactiveKnownNodes,
      onChainTaskObjects,
      totalOracleEvents,
      taskEvents: taskEvents.length,
      messageEvents: messageEvents.length,
      totalEvents: combined.length,
    },
    costs: configuredCosts,
    pendingTemplateProposals,
    registeredNodes,
    nodeActivity,
    recentEvents: combined.slice(0, 50),
    warnings,
  };
}
