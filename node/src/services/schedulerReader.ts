// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { IotaClient } from "@iota/iota-sdk/client";

import {
  getStateId,
  getTaskRegistryId,
  getTaskSchedulerQueueId,
} from "../config/env";
import { resolveNodeRegistryId } from "./nodeRegistry";
import { getAnyMoveFields, getMoveFields } from "../utils/move";

export type SchedulerQueueSnapshot = {
  id: string;
  nodeIds: number[];
  headNodeId: number | null;
  activeRoundStartedMs: number;
  lastRoundCompletedMs: number;
  roundCounter: number;
};

export type RegisteredOracleNodeSnapshot = {
  nodeId: number;
  addr: string;
  acceptedTemplateIds: number[];
};

export type NodeRegistrySnapshot = {
  id: string;
  lastCommitteePruneEpoch: string;
  nodes: RegisteredOracleNodeSnapshot[];
};

export type TaskSnapshot = {
  id: string;
  creator: string;
  status: number;
  executionState: number;
  templateId: number;
  nextRunMs: number;
  endScheduleMs: number;
  lastRunMs: number;
  availableBalanceIota: string;
};

function toArray(value: any): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") {
    if (Array.isArray(value.items)) return value.items;
    if (Array.isArray(value.contents)) return value.contents;
    if (Array.isArray(value.vec)) return value.vec;
  }
  return [];
}

function toStr(value: any): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value && typeof value === "object") {
    if (typeof value.value === "string") return value.value;
    if (typeof value.id === "string") return value.id;
    if (typeof value.objectId === "string") return value.objectId;
    if (typeof value.bytes === "string") return value.bytes;
  }
  return "";
}

function toNum(value: any): number {
  const n = Number(toStr(value) || value || 0);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function toBalanceString(value: any): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (value && typeof value === "object") {
    for (const key of ["value", "balance", "total", "coin"]) {
      const nested = (value as any)[key];
      if (nested != null) return toBalanceString(nested);
    }
  }
  return "0";
}

export async function readTaskSchedulerQueue(
  client: IotaClient,
  queueId = getTaskSchedulerQueueId(),
): Promise<SchedulerQueueSnapshot> {
  const obj = await client.getObject({ id: queueId, options: { showContent: true } } as any);
  const f = getMoveFields(obj);
  const nodeIds = toArray(f.node_ids).map(toNum).filter((x) => x > 0);
  return {
    id: queueId,
    nodeIds,
    headNodeId: nodeIds[0] ?? null,
    activeRoundStartedMs: toNum(f.active_round_started_ms),
    lastRoundCompletedMs: toNum(f.last_round_completed_ms),
    roundCounter: toNum(f.round_counter),
  };
}

export async function readRegisteredOracleNodes(
  client: IotaClient,
  stateId = getStateId(),
): Promise<RegisteredOracleNodeSnapshot[]> {
  return (await readNodeRegistrySnapshot(client, stateId)).nodes;
}

export async function readNodeRegistrySnapshot(
  client: IotaClient,
  stateId = getStateId(),
): Promise<NodeRegistrySnapshot> {
  const nodeRegistryId = await resolveNodeRegistryId(client, stateId);
  const obj = await client.getObject({ id: nodeRegistryId, options: { showContent: true } } as any);
  const f = getMoveFields(obj);
  const nodes = toArray(f.oracle_nodes)
    .map((item) => getAnyMoveFields(item))
    .map((node) => ({
      nodeId: toNum(node.node_id),
      addr: toStr(node.addr).toLowerCase(),
      acceptedTemplateIds: toArray(node.accepted_template_ids).map(toNum).filter((x) => x >= 0),
    }))
    .filter((node) => node.nodeId > 0 && !!node.addr);
  return {
    id: nodeRegistryId,
    lastCommitteePruneEpoch: toStr(f.last_committee_prune_epoch),
    nodes,
  };
}

export async function readRegisteredOracleNodeByAddr(
  client: IotaClient,
  addr: string,
  stateId = getStateId(),
): Promise<RegisteredOracleNodeSnapshot | null> {
  const normalizedAddr = String(addr ?? "").trim().toLowerCase();
  if (!normalizedAddr) return null;
  const nodes = await readRegisteredOracleNodes(client, stateId);
  return nodes.find((node) => node.addr === normalizedAddr) ?? null;
}

export async function readTaskRegistry(client: IotaClient, registryId = getTaskRegistryId()): Promise<string[]> {
  const obj = await client.getObject({ id: registryId, options: { showContent: true } } as any);
  const f = getMoveFields(obj);
  return toArray(f.live_task_ids).map(toStr).filter(Boolean);
}

export async function readTask(client: IotaClient, taskId: string): Promise<TaskSnapshot> {
  const obj = await client.getObject({ id: taskId, options: { showContent: true } } as any);
  const f = getMoveFields(obj);
  return {
    id: taskId,
    creator: toStr(f.creator).toLowerCase(),
    status: toNum(f.status),
    executionState: toNum(f.execution_state),
    templateId: toNum(f.template_id),
    nextRunMs: toNum(f.next_run_ms),
    endScheduleMs: toNum(f.end_schedule_ms),
    lastRunMs: toNum(f.last_run_ms),
    availableBalanceIota: toBalanceString(f.available_balance_iota),
  };
}

export async function listDueTasks(
  client: IotaClient,
  nowMs: number,
  registryId = getTaskRegistryId(),
): Promise<TaskSnapshot[]> {
  const ids = await readTaskRegistry(client, registryId);
  const out: TaskSnapshot[] = [];
  for (const id of ids) {
    try {
      const task = await readTask(client, id);
      if (task.status !== 1 && task.status !== 10) continue;
      if (task.nextRunMs <= 0 || task.nextRunMs > nowMs) continue;
      out.push(task);
    } catch (e: any) {
      console.warn(`[scheduler] read task failed id=${id}: ${String(e?.message ?? e)}`);
    }
  }
  out.sort((a, b) => a.nextRunMs - b.nextRunMs || a.id.localeCompare(b.id));
  return out;
}
