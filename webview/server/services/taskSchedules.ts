// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { IotaClient } from "@iota/iota-sdk/client";
import { getRuntimeConfig, type OracleNetwork } from "../config.js";
import type { TaskScheduleItem, TaskSchedulesResponse } from "../types.js";

type GraphqlTaskObjectsResponse = {
  data?: {
    objects?: {
      nodes?: { address?: string | null }[];
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
    };
  };
  errors?: { message?: string }[];
};

const TASK_OBJECT_DISCOVERY_PAGE_SIZE = 50;
const TASK_OBJECT_DISCOVERY_MAX = 1000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getMoveFields(obj: any): Record<string, any> {
  const c: any = obj?.data?.content;
  if (!c || c.dataType !== "moveObject") return {};
  return (c.fields ?? {}) as Record<string, any>;
}

function toArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ["items", "contents", "vec", "value"]) {
    const nested = record[key];
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function toText(value: any): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  const record = asRecord(value);
  if (!record) return "";
  for (const key of ["value", "id", "objectId", "bytes", "balance"]) {
    const nested = record[key];
    if (typeof nested === "string" || typeof nested === "number" || typeof nested === "bigint") {
      return String(nested);
    }
  }
  return "";
}

function normalizeAddress(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  return text.startsWith("0x") ? text : `0x${text}`;
}

function statusLabel(status: number): string {
  switch (status) {
    case 1:
      return "ACTIVE";
    case 2:
      return "SUSPENDED";
    case 3:
      return "DEPLETED";
    case 9:
      return "CANCELLED";
    case 10:
      return "ENDED";
    case 11:
      return "COMPLETED";
    default:
      return String(status || "-");
  }
}

function balanceToString(value: any): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return String(value);
  const record = asRecord(value);
  if (!record) return "0";
  for (const key of ["value", "balance", "total"]) {
    if (record[key] != null) return balanceToString(record[key]);
  }
  return "0";
}

async function readTaskSchedule(client: IotaClient, id: string): Promise<TaskScheduleItem | null> {
  const obj = await client.getObject({ id, options: { showContent: true } } as any);
  const f = getMoveFields(obj);
  if (!Object.keys(f).length) return null;
  return {
    id,
    creator: toText(f.creator).toLowerCase(),
    status: Number(toText(f.status) || 0),
    statusLabel: statusLabel(Number(toText(f.status) || 0)),
    templateId: toText(f.template_id),
    runCount: toText(f.latest_result_seq),
    nextRunMs: toText(f.next_run_ms),
    lastRunMs: toText(f.last_run_ms),
    startScheduleMs: toText(f.start_schedule_ms),
    endScheduleMs: toText(f.end_schedule_ms),
    intervalMs: toText(f.interval_ms),
    balanceIota: balanceToString(f.available_balance_iota),
    lastSchedulerNode: toText(f.last_scheduler_node).toLowerCase() || null,
  };
}

function getGraphqlEndpoint(network: string | undefined): string | null {
  const normalized = String(network ?? "").trim().toLowerCase();
  if (normalized === "mainnet") return "https://graphql.mainnet.iota.cafe";
  if (normalized === "testnet") return "https://graphql.testnet.iota.cafe";
  if (normalized === "devnet") return "https://graphql.devnet.iota.cafe";
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

async function listTaskObjectIds(
  network: string | undefined,
  packageId: string | null,
  warnings: string[],
): Promise<string[]> {
  if (!packageId) return [];

  const graphqlUrl = getGraphqlEndpoint(network);
  if (!graphqlUrl) return [];

  const structType = `${packageId}::oracle_tasks::Task`;
  const query = `
    query ListTaskObjects($type: String!, $after: String) {
      objects(first: ${TASK_OBJECT_DISCOVERY_PAGE_SIZE}, after: $after, filter: { type: $type }) {
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

  const ids: string[] = [];
  let cursor: string | null = null;

  try {
    for (;;) {
      const payload: GraphqlTaskObjectsResponse = await fetchGraphqlPayload<GraphqlTaskObjectsResponse>(graphqlUrl, query, {
        type: structType,
        after: cursor,
      });
      if (payload.errors?.length) {
        throw new Error(payload.errors.map((item: { message?: string }) => item.message || "Unknown GraphQL error").join("; "));
      }

      for (const node of payload.data?.objects?.nodes ?? []) {
        const id = normalizeAddress(node.address);
        if (id) ids.push(id);
      }

      const pageInfo: { hasNextPage?: boolean; endCursor?: string | null } | undefined =
        payload.data?.objects?.pageInfo;
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor ?? null;
      if (!cursor || ids.length >= TASK_OBJECT_DISCOVERY_MAX) break;
    }
  } catch (e: any) {
    warnings.push(`Failed to discover task objects: ${String(e?.message ?? e)}`);
  }

  return ids;
}

export async function getTaskSchedules(network?: string): Promise<TaskSchedulesResponse> {
  const runtime = getRuntimeConfig(network as OracleNetwork | undefined);
  const warnings: string[] = [];
  const registryId = runtime.oracleTaskRegistryId || null;
  const schedulerQueueId = runtime.oracleTaskSchedulerQueueId || null;
  const tasksPackageId = runtime.oracleTasksPackageId || null;

  if (!registryId) warnings.push("Missing ORACLE_TASK_REGISTRY_ID for active network.");
  if (!schedulerQueueId) warnings.push("Missing ORACLE_TASK_SCHEDULER_QUEUE_ID for active network.");

  const client = new IotaClient({ url: runtime.rpcUrl });

  let queue: TaskSchedulesResponse["queue"] = null;
  if (schedulerQueueId) {
    try {
      const queueObj = await client.getObject({ id: schedulerQueueId, options: { showContent: true } } as any);
      const q = getMoveFields(queueObj);
      const nodes = toArray(q.node_ids ?? q.nodes)
        .map(toText)
        .filter(Boolean)
        .map((x) => x.toLowerCase());
      queue = {
        head: nodes[0] ?? null,
        nodes,
        activeRoundStartedMs: toText(q.active_round_started_ms),
        lastRoundCompletedMs: toText(q.last_round_completed_ms),
        roundCounter: toText(q.round_counter),
      };
    } catch (e: any) {
      warnings.push(`Failed to read scheduler queue: ${String(e?.message ?? e)}`);
    }
  }

  const items: TaskScheduleItem[] = [];
  const taskIds = new Set<string>();
  if (registryId) {
    try {
      const registryObj = await client.getObject({ id: registryId, options: { showContent: true } } as any);
      const fields = getMoveFields(registryObj);
      for (const id of toArray(fields.live_task_ids).map(toText).filter(Boolean)) {
        taskIds.add(normalizeAddress(id));
      }
    } catch (e: any) {
      warnings.push(`Failed to read task registry: ${String(e?.message ?? e)}`);
    }
  }

  for (const id of await listTaskObjectIds(runtime.network, tasksPackageId, warnings)) {
    taskIds.add(normalizeAddress(id));
  }

  for (const id of taskIds) {
    try {
      const item = await readTaskSchedule(client, id);
      if (item) items.push(item);
    } catch (e: any) {
      warnings.push(`Failed to read task schedule ${id}: ${String(e?.message ?? e)}`);
    }
  }

  items.sort((a, b) => Number(a.nextRunMs || "0") - Number(b.nextRunMs || "0") || a.id.localeCompare(b.id));

  return {
    ok: true,
    network: runtime.network,
    registryId,
    schedulerQueueId,
    queue,
    items,
    warnings,
  };
}
