import { historyHint } from "../lib/requestPool";
// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { useEffect, useMemo, useState } from "react";
import MetricCard from "../components/MetricCard";
import { fetchTaskSchedules } from "../lib/api";
import type {
  NodeActivity,
  OracleEventItem,
  OracleNetwork,
  OracleStatus,
  RegisteredOracleNode,
  TaskSchedulesResponse,
} from "../types";

type Props = {
  activeNetwork: OracleNetwork;
  status: OracleStatus | null;
  readyToLoad: boolean;
};

const REFRESH_MS = 10_000;

function normalizeAddress(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  return text.startsWith("0x") ? text : `0x${text}`;
}

function shortAddress(address: string | null | undefined, start = 8, end = 6): string {
  const value = String(address ?? "").trim();
  if (!value) return "-";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function formatMs(value: string | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  return new Date(n).toLocaleString();
}

function formatIso(value: string | null | undefined): string {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatEventDetails(event: OracleEventItem): string {
  if (event.parsedJson == null) return "-";
  try {
    return JSON.stringify(event.parsedJson);
  } catch {
    return String(event.parsedJson);
  }
}

function eventKey(event: OracleEventItem): string {
  return `${event.txDigest || "event"}:${event.eventSeq || "0"}:${event.eventType}`;
}

function findActivity(node: RegisteredOracleNode, activityByAddress: Map<string, NodeActivity>): NodeActivity | null {
  return activityByAddress.get(normalizeAddress(node.address)) ?? null;
}

function delegatingNodeLabel(node: RegisteredOracleNode | null | undefined): string {
  if (!node) return "-";
  return node.validatorName || shortAddress(node.validatorId) || shortAddress(node.address);
}

function delegatingNodeAddress(node: RegisteredOracleNode | null | undefined): string {
  return node?.address ? shortAddress(node.address) : "-";
}

export default function MonitoringPage({ activeNetwork, status, readyToLoad }: Props) {
  const [schedules, setSchedules] = useState<TaskSchedulesResponse | null>(null);
  const [loadingSchedules, setLoadingSchedules] = useState(true);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!readyToLoad) {
      setSchedules(null);
      setScheduleError(null);
      setLoadingSchedules(true);
      return () => {
        cancelled = true;
      };
    }

    async function load(withLoading = false) {
      if (withLoading) setLoadingSchedules(true);
      try {
        const response = await fetchTaskSchedules(activeNetwork);
        if (!cancelled) {
          setSchedules(response);
          setScheduleError(null);
        }
      } catch (err) {
        if (!cancelled) setScheduleError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled && withLoading) setLoadingSchedules(false);
      }
    }

    void load(true);
    const timer = window.setInterval(() => {
      void load(false);
    }, REFRESH_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeNetwork, readyToLoad]);

  const activityByAddress = useMemo(() => {
    const map = new Map<string, NodeActivity>();
    for (const item of status?.nodeActivity ?? []) {
      map.set(normalizeAddress(item.sender), item);
    }
    return map;
  }, [status?.nodeActivity]);

  const registeredNodes = status?.registeredNodes ?? [];
  const recentEvents = (status?.recentEvents ?? []).slice(0, 10);
  const statusLoaded = Boolean(status);
  const queueNodes = schedules?.queue?.nodes ?? [];
  const queueHead = String(schedules?.queue?.head ?? "").trim();

  const nodeBySchedulerId = useMemo(() => {
    const map = new Map<string, RegisteredOracleNode>();
    for (const node of registeredNodes) {
      const nodeId = String(node.nodeId ?? "").trim();
      if (nodeId) map.set(nodeId, node);
    }
    return map;
  }, [registeredNodes]);

  return (
    <>
      {scheduleError ? <div className="alert alert-error">{scheduleError}</div> : null}
      {schedules?.warnings?.length ? (
        <div className="alert alert-warn">
          {schedules.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      <section className="grid metrics-grid monitoring-metrics-grid">
        <MetricCard
          label="Active nodes"
          value={status?.metrics.activeNodes ?? "-"}
          hint={`Window: ${status?.activeWindowMinutes ?? "-"} min`}
        />
        <MetricCard label="Registered nodes" value={statusLoaded ? registeredNodes.length : "-"} hint="On-chain registry" />
        <MetricCard label="Live scheduled tasks" value={schedules?.items.length ?? "-"} hint="Task registry" />
        <MetricCard label="Task objects" value={status?.metrics.onChainTaskObjects ?? "-"} hint={historyHint(status?.metrics.history?.onChainTaskObjects, "All on-chain")} />
        <MetricCard label="Oracle events" value={status?.metrics.totalOracleEvents ?? "-"} hint={historyHint(status?.metrics.history?.totalOracleEvents, "Total indexed")} />
      </section>

      <section className="card card-spaced">
        <div className="section-title">Registered nodes</div>
        {!statusLoaded ? (
          <div className="empty">Loading registered nodes...</div>
        ) : !registeredNodes.length ? (
          <div className="empty">No registered nodes found on this network.</div>
        ) : (
          <div className="table-wrap">
            <table className="responsive-table monitoring-nodes-table">
              <thead>
                <tr>
                  <th>Node</th>
                  <th>Validator</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  <th>Accepted templates</th>
                  <th>Delegated cap</th>
                </tr>
              </thead>
              <tbody>
                {registeredNodes.map((node) => {
                  const activity = findActivity(node, activityByAddress);
                  return (
                    <tr key={node.address}>
                      <td data-label="Node" className="mono">
                        {shortAddress(node.address)}
                      </td>
                      <td data-label="Validator">
                        {node.validatorName ? (
                          <>
                            <div>{node.validatorName}</div>
                            <div className="summary-hint mono">{shortAddress(node.validatorId)}</div>
                          </>
                        ) : (
                          <span className="mono">{shortAddress(node.validatorId)}</span>
                        )}
                      </td>
                      <td data-label="Status">
                        <span className={activity?.active ? "badge badge-ok" : "badge badge-muted"}>
                          {activity?.active ? "active" : "inactive"}
                        </span>
                      </td>
                      <td data-label="Last seen">{formatMs(activity?.lastSeenMs)}</td>
                      <td data-label="Accepted templates" className="mono">
                        {node.acceptedTemplateIds.length ? node.acceptedTemplateIds.join(", ") : "-"}
                      </td>
                      <td data-label="Delegated cap" className="mono">
                        {shortAddress(node.delegatedControllerCapId)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card card-spaced">
        <div className="section-title">Scheduler queue</div>
        {loadingSchedules ? (
          <div className="empty">Loading scheduler queue...</div>
        ) : !schedules?.queue ? (
          <div className="empty">Scheduler queue not available.</div>
        ) : (
          <>
            <div className="template-details-grid monitoring-queue-summary">
              <div className="template-kv-item">
                <span className="template-kv-label">Head</span>
                <span className="template-kv-value">
                  {delegatingNodeLabel(nodeBySchedulerId.get(queueHead))}
                  <span className="summary-hint mono"> {delegatingNodeAddress(nodeBySchedulerId.get(queueHead))}</span>
                </span>
              </div>
              <div className="template-kv-item">
                <span className="template-kv-label">Round counter</span>
                <span className="template-kv-value mono">{schedules.queue.roundCounter || "-"}</span>
              </div>
              <div className="template-kv-item">
                <span className="template-kv-label">Active round started</span>
                <span className="template-kv-value">{formatMs(schedules.queue.activeRoundStartedMs)}</span>
              </div>
              <div className="template-kv-item">
                <span className="template-kv-label">Last round completed</span>
                <span className="template-kv-value">{formatMs(schedules.queue.lastRoundCompletedMs)}</span>
              </div>
            </div>
            <div className="table-wrap" style={{ marginTop: 16 }}>
              <table className="responsive-table monitoring-queue-table">
                <thead>
                  <tr>
                    <th>Position</th>
                    <th>Delegating node</th>
                    <th>Queue state</th>
                  </tr>
                </thead>
                <tbody>
                  {queueNodes.length ? (
                    queueNodes.map((nodeId, index) => {
                      const schedulerNode = nodeBySchedulerId.get(String(nodeId).trim());
                      return (
                        <tr key={`${nodeId}-${index}`}>
                          <td data-label="Position" className="mono">
                            {index + 1}
                          </td>
                          <td data-label="Delegating node">
                            <div>{delegatingNodeLabel(schedulerNode)}</div>
                            <div className="summary-hint mono">{delegatingNodeAddress(schedulerNode)}</div>
                          </td>
                          <td data-label="Queue state">
                            {String(nodeId).trim() === queueHead ? (
                              <span className="badge badge-ok">head</span>
                            ) : (
                              <span className="badge badge-muted">waiting</span>
                            )}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={3} className="empty">
                        No nodes in scheduler queue.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <section className="card card-spaced">
        <div className="section-title">Latest 10 oracle events</div>
        {!statusLoaded ? (
          <div className="empty">Loading oracle events...</div>
        ) : !recentEvents.length ? (
          <div className="empty">No recent events found.</div>
        ) : (
          <div className="table-wrap">
            <table className="responsive-table monitoring-events-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Module</th>
                  <th>Type</th>
                  <th>Sender</th>
                  <th>Digest</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {recentEvents.map((event) => (
                  <tr key={eventKey(event)}>
                    <td data-label="Time">{formatMs(event.timestampMs)}</td>
                    <td data-label="Module">{event.module || "-"}</td>
                    <td data-label="Type" className="mono">
                      {event.eventType || "-"}
                    </td>
                    <td data-label="Sender" className="mono">
                      {shortAddress(event.sender)}
                    </td>
                    <td data-label="Digest" className="mono">
                      {shortAddress(event.txDigest)}
                    </td>
                    <td data-label="Details">
                      <span className="mono monitoring-event-details">{formatEventDetails(event)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
