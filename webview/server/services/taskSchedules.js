import { readClient, boundedFetch } from "../upstream.js";
// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary
import { IotaClient } from "@iota/iota-sdk/client";
import { getRuntimeConfig } from "../config.js";
function asRecord(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function getMoveFields(obj) {
    const c = obj?.data?.content;
    if (!c || c.dataType !== "moveObject")
        return {};
    return (c.fields ?? {});
}
function toArray(value) {
    if (Array.isArray(value))
        return value;
    const record = asRecord(value);
    if (!record)
        return [];
    for (const key of ["items", "contents", "vec", "value"]) {
        const nested = record[key];
        if (Array.isArray(nested))
            return nested;
    }
    return [];
}
function toText(value) {
    if (typeof value === "string")
        return value;
    if (typeof value === "number" || typeof value === "bigint")
        return String(value);
    const record = asRecord(value);
    if (!record)
        return "";
    for (const key of ["value", "id", "objectId", "bytes", "balance"]) {
        const nested = record[key];
        if (typeof nested === "string" || typeof nested === "number" || typeof nested === "bigint") {
            return String(nested);
        }
    }
    return "";
}
function statusLabel(status) {
    switch (status) {
        case 1:
            return "ACTIVE";
        case 2:
            return "SUSPENDED";
        case 9:
            return "CANCELLED";
        case 10:
            return "ENDED";
        default:
            return String(status || "-");
    }
}
function balanceToString(value) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "bigint")
        return String(value);
    const record = asRecord(value);
    if (!record)
        return "0";
    for (const key of ["value", "balance", "total"]) {
        if (record[key] != null)
            return balanceToString(record[key]);
    }
    return "0";
}
async function readTaskSchedule(client, id) {
    const obj = await client.getObject({ id, options: { showContent: true } });
    const f = getMoveFields(obj);
    if (!Object.keys(f).length)
        return null;
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
export async function getTaskSchedules(network) {
    const runtime = getRuntimeConfig(network);
    const warnings = [];
    const registryId = runtime.oracleTaskRegistryId || null;
    const schedulerQueueId = runtime.oracleTaskSchedulerQueueId || null;
    if (!registryId)
        warnings.push("Missing ORACLE_TASK_REGISTRY_ID for active network.");
    if (!schedulerQueueId)
        warnings.push("Missing ORACLE_TASK_SCHEDULER_QUEUE_ID for active network.");
    const client = readClient(runtime.rpcUrl);
    let queue = null;
    if (schedulerQueueId) {
        try {
            const queueObj = await client.getObject({ id: schedulerQueueId, options: { showContent: true } });
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
        }
        catch (e) {
            warnings.push(`Failed to read scheduler queue: ${String(e?.message ?? e)}`);
        }
    }
    const items = [];
    if (registryId) {
        try {
            const registryObj = await client.getObject({ id: registryId, options: { showContent: true } });
            const fields = getMoveFields(registryObj);
            const ids = toArray(fields.live_task_ids).map(toText).filter(Boolean);
            for (const id of ids) {
                try {
                    const item = await readTaskSchedule(client, id);
                    if (item)
                        items.push(item);
                }
                catch (e) {
                    warnings.push(`Failed to read task schedule ${id}: ${String(e?.message ?? e)}`);
                }
            }
        }
        catch (e) {
            warnings.push(`Failed to read task registry: ${String(e?.message ?? e)}`);
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
