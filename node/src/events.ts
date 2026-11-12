// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

// src/events.ts (node)
// Event polling helpers.
//
// Notes:
// - The node uses RPC polling (queryEvents) with a cursor.
// - Cursors and replay watermarks are persisted in STORAGE_DIR.
// - The current on-chain package publishes oracle_tasks and systemState. oracle_messages may not exist.

import type { IotaClient } from "@iota/iota-sdk/client";
import { journalPath, readJournal, writeJournal, receiptPath } from './daemonJournal';
import { pinRpc, ROTATE_RPC } from './rpcConsistency';

export const eventPollHealth = new Map<string, {
  lastSuccessMs: number | null;
  failing: boolean;
  startedMs: number;
  failureSinceMs?: number | null;
  consecutiveFailures?: number;
  recovering?: boolean;
  historyGap?: boolean;
}>();

export const LISTENER_FAILURE_GRACE_MS = 0;

export function eventListenerDiagnostics(pollMs: number, now = Date.now()) {
  const staleAfterMs = Math.max(60_000, pollMs * 10);
  return [...eventPollHealth.entries()].map(([type, h]) => {
    const lastSuccessAgeMs = Math.max(0, now - (h.lastSuccessMs ?? h.startedMs));
    const failureDurationMs = h.failing ? Math.max(0, now - (h.failureSinceMs ?? h.startedMs)) : 0;
    const stalled = lastSuccessAgeMs >= staleAfterMs;
    const degraded = !!h.historyGap || stalled || (h.failing && failureDurationMs >= LISTENER_FAILURE_GRACE_MS);
    return {
      listener: type.split('::').slice(-2).join('::'),
      status: h.historyGap ? 'history_gap' : stalled ? 'stalled' : h.recovering ? 'recovering' : h.failing ? 'retrying' : h.lastSuccessMs == null ? 'starting' : 'ok',
      degraded,
      lastSuccessMs: h.lastSuccessMs,
      lastSuccessAgeMs,
      failureDurationMs,
      consecutiveFailures: h.consecutiveFailures ?? 0,
      historyGap: !!h.historyGap,
    };
  });
}

export function eventListenersDegraded(pollMs: number, now = Date.now()): boolean {
  return eventListenerDiagnostics(pollMs, now).some(h => h.degraded);
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function nestedCauseMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const cause = (error as any).cause;
  return cause instanceof Error ? cause.message : String(cause ?? "");
}

function isTransientRpcError(error: unknown): boolean {
  const message = `${formatErrorMessage(error)} ${nestedCauseMessage(error)}`.toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("econnreset") ||
    message.includes("connect timeout") ||
    message.includes("headers timeout") ||
    message.includes("socket hang up") ||
    message.includes("network") ||
    message.includes("und_err")
  );
}

export function decodeVecU8(v: unknown): Uint8Array {
  if (v == null) return new Uint8Array();
  if (v instanceof Uint8Array) return v;

  if (Array.isArray(v)) return Uint8Array.from(v.map((n) => Number(n) & 0xff));

  if (typeof v === "object") {
    const o: any = v;
    if (Array.isArray(o.bytes)) return Uint8Array.from(o.bytes.map((n: any) => Number(n) & 0xff));
    if (o.value != null) return decodeVecU8(o.value);
    if (o.fields != null) return decodeVecU8(o.fields);
  }

  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return new Uint8Array();
    if (s.startsWith("0x")) {
      try {
        return Uint8Array.from(Buffer.from(s.slice(2), "hex"));
      } catch {
        return new Uint8Array();
      }
    }
    try {
      return Uint8Array.from(Buffer.from(s, "base64"));
    } catch {
      return new Uint8Array();
    }
  }

  return new Uint8Array();
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function eventKey(ev: any): string {
  const id = ev?.id;
  if (id && typeof id === "object") {
    const txDigest = String((id as any).txDigest ?? "");
    const eventSeq = String((id as any).eventSeq ?? "");
    if (txDigest || eventSeq) return `${txDigest}:${eventSeq}`;
  }
  return JSON.stringify(id ?? ev ?? null);
}

export async function pollEvents(opts: {
  client: IotaClient;
  moveEventType: string;
  pollMs: number;
  minTimestampMs?: number;
  signal?: AbortSignal;
  checkpointPath?: string;
  onEvent: (ev: any) => Promise<void> | void;
}) {
  const { moveEventType, pollMs, minTimestampMs, onEvent } = opts;
  let client = pinRpc(opts.client);
  const path = opts.checkpointPath ?? journalPath('events', moveEventType);
  const saved = readJournal<any>(path);
  const since = saved?.since ?? minTimestampMs ?? 0;
  let cursor: any = saved?.cursor ?? null;
  const seen = new Set<string>();
  let consecutiveFailures = 0;
  let watermark = saved?.watermark ?? since;
  const watermarkKeys = new Set<string>(saved?.watermarkKeys ?? []);
  let rescanning = saved?.rescanning ?? false;
  let historyGap = saved?.historyGap ?? false;
  const save = () => writeJournal(path, { cursor, since, watermark, watermarkKeys: [...watermarkKeys], rescanning, historyGap });
  eventPollHealth.set(moveEventType, { lastSuccessMs: null, failing: false, startedMs: Date.now(), historyGap });

  while (!opts.signal?.aborted) {
    let page: any;
    try {
      page = await client.queryEvents({
        query: { MoveEventType: moveEventType },
        cursor: cursor ?? null,
        limit: 50,
        order: "ascending",
      } as any);
      consecutiveFailures = 0;
      const health = eventPollHealth.get(moveEventType)!;
      health.lastSuccessMs = Date.now();
      health.failing = rescanning || health.failing;
      health.recovering = rescanning;
      health.consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const health = eventPollHealth.get(moveEventType)!;
      health.failing = true;
      health.failureSinceMs ??= Date.now();
      health.consecutiveFailures = consecutiveFailures;
      if (/data_pruned|cursor.*pruned/i.test(formatErrorMessage(error))) {
        historyGap = true;
        health.historyGap = true;
      }
      // Re-read retained history rather than jumping past potentially pending events.
      if (cursor && /could not find the referenced transaction|invalid cursor|cursor.*pruned/i.test(formatErrorMessage(error))) {
        cursor = null;
        rescanning = true;
        health.recovering = true;
      }
      if (isTransientRpcError(error) && consecutiveFailures >= 3 && (opts.client as any)[ROTATE_RPC]) {
        client = (opts.client as any)[ROTATE_RPC]();
        cursor = null;
        rescanning = true;
        health.recovering = true;
      }
      save();
      const waitMs = Math.min(15_000, pollMs * Math.max(2, consecutiveFailures));
      const suffix = isTransientRpcError(error) ? " transient RPC error" : " polling error";
      console.warn(
        `[events] ${moveEventType}${suffix}; retry in ${waitMs} ms (attempt ${consecutiveFailures}): ${formatErrorMessage(error)}`,
      );
      await sleep(waitMs);
      continue;
    }

    let handlerFailed = false;
    for (const ev of page.data ?? []) {
      const evTs = Number((ev as any)?.timestampMs ?? 0);
      if (since && evTs > 0 && evTs < since) continue;

      const key = eventKey(ev);
      if (seen.has(key)) continue;
      if (readJournal<{ done: boolean }>(receiptPath(path, key))?.done) continue;
      seen.add(key);
      if (seen.size > 2000) {
        const first = seen.values().next().value;
        if (first) seen.delete(first);
      }
      try {
        await onEvent(ev);
        writeJournal(receiptPath(path, key), { done: true });
        if (evTs > watermark) { watermark = evTs; watermarkKeys.clear(); }
        if (evTs === watermark) watermarkKeys.add(key);
        cursor = ev.id;
        save();
      } catch (error) {
        seen.delete(key);
        handlerFailed = true;
        const health = eventPollHealth.get(moveEventType)!;
        health.failing = true;
        health.failureSinceMs ??= Date.now();
        console.warn(
          `[events] handler failed for ${moveEventType} event ${key}: ${formatErrorMessage(error)}`,
        );
        break;
      }
    }
    if (handlerFailed) { await sleep(pollMs); continue; }

    if (page.hasNextPage) {
      cursor = page.nextCursor;
      save();
      continue;
    }

    rescanning = false;
    eventPollHealth.get(moveEventType)!.failing = false;
    eventPollHealth.get(moveEventType)!.failureSinceMs = null;
    eventPollHealth.get(moveEventType)!.recovering = false;
    cursor = page.nextCursor ?? cursor;
    save();
    await sleep(pollMs);
  }
}

/**
 * Optional legacy channel.
 * If the package does not publish oracle_messages::OracleMessage, this listener simply sees no events.
 */
export async function listenOracleMessages(opts: {
  client: IotaClient;
  nodeId: string;
  myAddress: string;
  moveEventType: string;
  pollMs: number;
  minTimestampMs?: number;
  onMessage: (m: { from: string; payload: Uint8Array }) => Promise<void> | void;
}) {
  const { client, myAddress, moveEventType, pollMs, minTimestampMs, onMessage } = opts;

  await pollEvents({
    client,
    moveEventType,
    pollMs,
    minTimestampMs,
    onEvent: async (ev) => {
      const pj: any = ev.parsedJson ?? {};
      const to = String(pj.to ?? "").toLowerCase();
      if (to !== myAddress.toLowerCase()) return;

      const from = String(pj.from ?? "");
      const payload = decodeVecU8(pj.payload);
      await onMessage({ from, payload });
    },
  });
}

export async function listenTaskAssigned(opts: {
  client: IotaClient;
  nodeId: string;
  myAddress: string;
  moveEventType: string;
  pollMs: number;
  minTimestampMs?: number;
  onAssigned: (a: { taskId: string; creator: string; runIndex?: number }) => Promise<void> | void;
}) {
  const { client, myAddress, moveEventType, pollMs, minTimestampMs, onAssigned } = opts;

  await pollEvents({
    client,
    moveEventType,
    pollMs,
    minTimestampMs,
    onEvent: async (ev) => {
      const type = String((ev as any)?.type ?? "");
      const pj: any = ev.parsedJson ?? {};
      let taskId = "";
      let creator = "";
      let runIndex: number | undefined;

      if (type.endsWith("::oracle_tasks::TaskRunSubmitted")) {
        taskId = String(pj.task_id ?? "");
        if (pj.run_index != null) runIndex = Number(pj.run_index ?? 0);
      } else {
        if (Number(pj.kind ?? -1) !== 2) return;
        const to = String(pj.addr0 ?? "").toLowerCase();
        if (to !== myAddress.toLowerCase()) return;
        taskId = String(pj.task_id ?? "");
        creator = String(pj.actor ?? "");
      }

      if (taskId) await onAssigned({ taskId, creator, runIndex });
    },
  });
}

export async function listenTaskDataRequested(opts: {
  client: IotaClient;
  moveEventType: string; // `${pkg}::oracle_tasks::TaskLifecycleEvent`
  pollMs: number;
  minTimestampMs?: number;
  onRequested: (a: { taskId: string; failedRound: number; dataDeadlineMs: number }) => Promise<void> | void;
}) {
  const { client, moveEventType, pollMs, minTimestampMs, onRequested } = opts;
  await pollEvents({
    client,
    moveEventType,
    pollMs,
    minTimestampMs,
    onEvent: async (ev) => {
      const pj: any = ev.parsedJson ?? {};
      if (Number(pj.kind ?? -1) !== 4) return;
      const taskId = String(pj.task_id ?? "");
      if (!taskId) return;
      const failedRound = Number(pj.round ?? 0);
      const dataDeadlineMs = Number(pj.value0 ?? 0);
      await onRequested({ taskId, failedRound, dataDeadlineMs });
    },
  });
}

export async function listenTaskMediationStarted(opts: {
  client: IotaClient;
  moveEventType: string;
  pollMs: number;
  minTimestampMs?: number;
  onStarted: (a: {
    taskId: string;
    toRound?: number;
    runIndex?: number;
  }) => Promise<void> | void;
}) {
  const { client, moveEventType, pollMs, minTimestampMs, onStarted } = opts;
  await pollEvents({
    client,
    moveEventType,
    pollMs,
    minTimestampMs,
    onEvent: async (ev) => {
      const type = String((ev as any)?.type ?? "");
      const pj: any = ev.parsedJson ?? {};
      if (type.endsWith("::oracle_tasks::TaskRunMediationStarted")) {
        const taskId = String(pj.task_id ?? "");
        if (!taskId) return;
        await onStarted({
          taskId,
          runIndex: pj.run_index != null ? Number(pj.run_index ?? 0) : undefined,
        });
        return;
      }

      if (Number(pj.kind ?? -1) !== 6) return;
      const taskId = String(pj.task_id ?? "");
      if (!taskId) return;
      await onStarted({ taskId, toRound: Number(pj.round ?? 0) });
    },
  });
}
