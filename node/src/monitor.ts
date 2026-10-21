// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { createServer, type Server, type RequestListener } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

import type { NodeContext } from "./nodeContext";

const DEFAULT_MONITOR_HOST = "127.0.0.1";
const DEFAULT_MONITOR_PORT = 9080;

export type CapabilityHealthStatus = "disabled" | "pending" | "running" | "ok" | "failed";

export type CapabilityHealthCheckState = {
  enabled: boolean;
  status: CapabilityHealthStatus;
  lastStartedAtMs: number | null;
  lastCheckedAtMs: number | null;
  lastOkAtMs: number | null;
  lastErrorAtMs: number | null;
  lastError: string | null;
  templatesRemoved: number[];
  lastRemovalTxDigest: string | null;
  lastRemovalError: string | null;
};

export type CapabilityHealthRuntimeState = {
  workerEnabled: boolean;
  intervalMs: number | null;
  initialDelayMs: number | null;
  running: boolean;
  lastStartedAtMs: number | null;
  lastCompletedAtMs: number | null;
  checks: {
    LLM: CapabilityHealthCheckState;
    IPFS: CapabilityHealthCheckState;
  };
};

export type MonitorRuntimeState = {
  booting: boolean;
  listenersStarted: boolean;
  shutdownRequested: boolean;
  autoRegister: boolean;
  autoUnregister: boolean;
  registration: {
    attempted: boolean;
    succeeded: boolean;
    txDigest: string | null;
    lastError: string | null;
  };
  capabilityHealth: CapabilityHealthRuntimeState;
};

function resolveMonitorHost(): string {
  return String(process.env.MONITOR_HOST ?? DEFAULT_MONITOR_HOST).trim() || DEFAULT_MONITOR_HOST;
}

function resolveMonitorPort(ctx: NodeContext): number {
  const raw = String(process.env.MONITOR_PORT ?? "").trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  const nodeIndex = Number(ctx.nodeId);
  const offset = Number.isFinite(nodeIndex) && nodeIndex > 0 ? Math.floor(nodeIndex) - 1 : 0;
  return DEFAULT_MONITOR_PORT + offset;
}

function authorized(header: string | undefined, token: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

export function createMonitorHandler(ctx: NodeContext, state: MonitorRuntimeState): RequestListener {
  const token = String(process.env.MONITOR_AUTH_TOKEN ?? "").trim();
  return (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(body, null, 2));
    };
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method !== "GET") return send(405, { error: "method_not_allowed" });
      if (url.pathname !== "/health" && url.pathname !== "/status") return send(404, { error: "not_found" });

      const capabilitiesDegraded = Object.values(state.capabilityHealth.checks).some(
        (check) => check.enabled && (check.status === "failed" ||
          (check.status === "running" && check.lastError != null)),
      );
      const status = state.booting ? "booting" : "ok";
      const code = state.booting ? 503 : 200;
      if (url.pathname === "/health") {
        return send(code, {
          status,
          capabilitiesDegraded,
          capabilityHealth: {
            checks: {
              LLM: { status: state.capabilityHealth.checks.LLM.status },
              IPFS: { status: state.capabilityHealth.checks.IPFS.status },
            },
          },
        });
      }

      // Missing or weak configuration fails closed, including localhost requests.
      if (token.length < 32) return send(503, { error: "monitor_auth_not_configured" });
      if (!authorized(req.headers.authorization, token)) return send(401, { error: "unauthorized" });

      const sanitizeCheck = (check: CapabilityHealthCheckState): CapabilityHealthCheckState => ({
        ...check,
        lastError: check.lastError == null ? null : "CAPABILITY_CHECK_FAILED",
        lastRemovalError: check.lastRemovalError == null ? null : "TEMPLATE_REMOVAL_FAILED",
      });
      const capabilityHealth = {
        ...state.capabilityHealth,
        checks: {
          LLM: sanitizeCheck(state.capabilityHealth.checks.LLM),
          IPFS: sanitizeCheck(state.capabilityHealth.checks.IPFS),
        },
      };
      const taskStats = ctx.stats.getTaskStats();
      const balance = await ctx.stats.getBalanceSnapshot(ctx.client, ctx.identity.address);
      send(code, {
        status,
        nodeId: ctx.nodeId,
        address: ctx.identity.address,
        capabilitiesDegraded,
        capabilityHealth,
        acceptedTemplateIds: ctx.acceptedTemplateIds,
        acceptedTemplateIdsSource: "on-chain",
        persistedAcceptedTemplateIdsFallback: ctx.acceptedTemplateIds,
        pollMs: ctx.pollMs,
        startupMs: ctx.startupMs,
        uptimeMs: Date.now() - ctx.startupMs,
        runtime: {
          ...state, capabilityHealth,
          registration: {
            ...state.registration,
            lastError: state.registration.lastError == null ? null : "REGISTRATION_FAILED",
          },
        },
        tasks: { ...taskStats, lastError: taskStats.lastError == null ? null : "TASK_FAILED" },
        balance: { ...balance.data, error: balance.error == null ? null : "BALANCE_FETCH_FAILED" },
        monitor: { host: resolveMonitorHost(), port: resolveMonitorPort(ctx), path: url.pathname },
      });
    })().catch(() => send(500, { error: "monitor_failed" }));
  };
}

export function startMonitorServer(ctx: NodeContext, state: MonitorRuntimeState): Server {
  const monitorHost = resolveMonitorHost();
  const monitorPort = resolveMonitorPort(ctx);
  const server = createServer(createMonitorHandler(ctx, state));
  server.listen(monitorPort, monitorHost, () => {
    console.log(`[node ${ctx.nodeId}] monitor listening on http://${monitorHost}:${monitorPort}`);
  });
  return server;
}
