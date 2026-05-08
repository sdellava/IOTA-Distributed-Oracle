// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { IotaClient } from "@iota/iota-sdk/client";

import { bytesToUtf8, decodeVecU8 } from "../events";
import { getMoveFields } from "../utils/move";

function extractObjectId(x: any): string {
  if (!x) return "";
  if (typeof x === "string") return x;
  if (typeof x !== "object") return "";

  const direct = x.objectId ?? x.id ?? x.value ?? x.inner ?? x.bytes;
  if (typeof direct === "string") return direct;

  if (x.fields) {
    const nested = extractObjectId(x.fields);
    if (nested) return nested;
  }

  return "";
}

export type TaskBundle = {
  taskId: string;
  taskFields: Record<string, any>;
  configId: string;
  runtimeId: string;
  configFields: Record<string, any>;
  runtimeFields: Record<string, any>;
};

export type TaskResultRecord = {
  seq: number;
  runIndex: number;
  producedAtMs: number;
  result: string;
  resultHashHex: string;
  reasonCode: number;
};

export function taskCreatedAtMs(bundle: Pick<TaskBundle, "taskFields" | "runtimeFields">): number {
  return Number(bundle.taskFields?.last_run_ms ?? bundle.runtimeFields?.created_at_ms ?? 0) || 0;
}

export function isTaskFreshForNode(bundle: Pick<TaskBundle, "taskFields" | "runtimeFields">, startupMs: number): boolean {
  const createdAt = taskCreatedAtMs(bundle);
  const skewMs = 5_000;
  return createdAt <= 0 || createdAt + skewMs >= startupMs;
}

export async function loadTaskBundle(client: IotaClient, taskId: string): Promise<TaskBundle> {
  const taskObj = await client.getObject({ id: taskId, options: { showContent: true, showType: true } });
  const taskFields = getMoveFields(taskObj);

  return {
    taskId,
    taskFields,
    configId: taskId,
    runtimeId: taskId,
    configFields: taskFields,
    runtimeFields: taskFields,
  };
}

function deepFindSeq(x: any): number | null {
  if (x == null) return null;
  if (typeof x === "number") return Number.isFinite(x) ? x : null;
  if (typeof x === "string") {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof x !== "object") return null;

  const direct = (x.seq ?? x.fields?.seq ?? x.value?.seq ?? x.value?.fields?.seq) as any;
  if (direct != null) return deepFindSeq(direct);
  if (x.fields) return deepFindSeq(x.fields);
  if (x.value) return deepFindSeq(x.value);
  return null;
}

function getDynamicFieldValueFields(obj: any): Record<string, any> {
  const fields = getMoveFields(obj);
  const value = fields.value as any;
  if (value?.fields && typeof value.fields === "object") return value.fields as Record<string, any>;
  if (value && typeof value === "object") return value as Record<string, any>;
  return {};
}

function isTaskResultField(obj: any): boolean {
  const type = String(obj?.data?.content?.type ?? "");
  return type.includes("TaskResultKey") && type.includes("TaskResult");
}

export async function loadLatestTaskResult(
  client: IotaClient,
  bundle: Pick<TaskBundle, "taskId" | "taskFields">,
): Promise<TaskResultRecord | null> {
  const latestSeq = Number(bundle.taskFields.latest_result_seq ?? 0) || 0;
  if (latestSeq <= 0) return null;

  let cursor: string | null | undefined = null;
  for (;;) {
    const page = await client.getDynamicFields({ parentId: bundle.taskId, cursor, limit: 50 });
    for (const item of page.data as any[]) {
      const seq = deepFindSeq(item?.name);
      if (seq !== latestSeq) continue;

      const fieldObj = await client.getObject({ id: item.objectId, options: { showContent: true, showType: true } });
      if (!isTaskResultField(fieldObj)) continue;

      const valueFields = getDynamicFieldValueFields(fieldObj);
      return {
        seq: latestSeq,
        runIndex: Number(valueFields.run_index ?? 0) || 0,
        producedAtMs: Number(valueFields.produced_at_ms ?? 0) || 0,
        result: bytesToUtf8(decodeVecU8(valueFields.result)),
        resultHashHex: Buffer.from(decodeVecU8(valueFields.result_hash)).toString("hex"),
        reasonCode: Number(valueFields.reason_code ?? 0) || 0,
      };
    }

    if (!page.hasNextPage) break;
    cursor = page.nextCursor as any;
  }

  return null;
}
