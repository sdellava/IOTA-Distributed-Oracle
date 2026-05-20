// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { ConnectButton, useCurrentAccount, useIotaClientContext } from "@iota/dapp-kit";
import Menu, { Item as RcMenuItem, Divider } from "rc-menu";
import MetricCard from "./components/MetricCard";
import TaskRunner from "./components/TaskRunner";
import {
  fetchExamples,
  fetchIotaMarketPrice,
  fetchNetworkConfig,
  fetchStatusForNetwork,
  updateActiveNetwork,
} from "./lib/api";
import type { ExampleTask, IotaMarketPriceResponse, OracleNetwork, OracleStatus, OracleTemplateCost } from "./types";
import NodeManagementPage from "./pages/NodeManagementPage";
import TaskPricesPage from "./pages/TaskPricesPage";
import ValidateTaskPage from "./pages/ValidateTaskPage";
import TaskSchedulesPage from "./pages/TaskSchedulesPage";
import TermsPage from "./pages/TermsPage";
import MonitoringPage from "./pages/MonitoringPage";

const REFRESH_MS = 10_000;

type PageMode = "run" | "monitoring" | "validate" | "scheduled" | "node-management" | "task-prices" | "terms";
const FALLBACK_NETWORKS: OracleNetwork[] = ["mainnet", "testnet", "devnet"];

function taskIdFromPath(pathname: string): string {
  const match = pathname.match(/^\/task\/([^/?#]+)\/?$/i);
  if (!match) return "";

  try {
    return decodeURIComponent(match[1]).trim();
  } catch {
    return match[1].trim();
  }
}

function taskPath(taskId: string): string {
  return `/task/${encodeURIComponent(taskId.trim())}`;
}

function pushBrowserPath(pathname: string) {
  if (window.location.pathname === pathname) return;
  window.history.pushState(null, "", pathname);
}

function normalizeNetwork(value: string | null | undefined): OracleNetwork {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw === "devnet" || raw === "dev") return "devnet";
  if (raw === "testnet" || raw === "test") return "testnet";
  return "mainnet";
}

function shortAddress(address: string, start = 6, end = 4): string {
  if (!address) return "-";
  if (address.length <= start + end + 3) return address;
  return `${address.slice(0, start)}...${address.slice(-end)}`;
}

function parseIotaAtomic(value: string | null | undefined): bigint | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

function formatUsd(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  });
}

function formatIotaAtomic(value: bigint): string {
  return (Number(value) / 1_000_000_000).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

function parseBps(value: string | null | undefined): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

function profileLine(
  label: string,
  atomicValue: string | null | undefined,
  iotaUsdPrice: number | null,
  treasuryBps: number,
): string | null {
  if (iotaUsdPrice == null || iotaUsdPrice <= 0) return null;
  const atomic = parseIotaAtomic(atomicValue);
  if (atomic == null || atomic === 0n) return null;

  const iota = Number(atomic) / 1_000_000_000;
  const grossUsd = iota * iotaUsdPrice;
  const treasuryUsd = grossUsd * (treasuryBps / 10_000);
  const netUsd = grossUsd - treasuryUsd;

  return `${label}: gross $${formatUsd(grossUsd)}, treasury $${formatUsd(treasuryUsd)}, net $${formatUsd(netUsd)}`;
}

function formatPriceProfile(template: OracleTemplateCost, iotaUsdPrice: number | null, treasuryBps: number): string {
  const parts = [
    profileLine("base", template.basePriceIota, iotaUsdPrice, treasuryBps),
    profileLine("download/byte", template.pricePerDownloadByteIota, iotaUsdPrice, treasuryBps),
    profileLine("retention/day", template.pricePerRetentionDayIota, iotaUsdPrice, treasuryBps),
    profileLine(
      "retention/month (30d)",
      (() => {
        const retention = parseIotaAtomic(template.pricePerRetentionDayIota);
        return retention == null ? null : (retention * 30n).toString();
      })(),
      iotaUsdPrice,
      treasuryBps,
    ),
  ].filter(Boolean) as string[];

  return parts.length ? parts.join(" | ") : "-";
}

function buildMonthlyStorageEstimate(
  template: OracleTemplateCost,
  treasuryBps: number,
  iotaUsdPrice: number | null,
): {
  storageMonthlyAtomic: bigint;
  rawAtomic: bigint;
  feeAtomic: bigint;
  totalAtomic: bigint;
  summary: string;
} | null {
  if (!template.allowStorage) return null;

  const baseAtomic = parseIotaAtomic(template.basePriceIota);
  const perDayAtomic = parseIotaAtomic(template.pricePerRetentionDayIota);
  if (baseAtomic == null || perDayAtomic == null) return null;

  const storageMonthlyAtomic = perDayAtomic * 30n;
  const rawAtomic = baseAtomic + storageMonthlyAtomic;
  const feeAtomic = (rawAtomic * BigInt(Math.max(0, treasuryBps)) + 9_999n) / 10_000n;
  const totalAtomic = rawAtomic + feeAtomic;

  const usdPart =
    iotaUsdPrice && iotaUsdPrice > 0
      ? ` | total ~= $${formatUsd((Number(totalAtomic) / 1_000_000_000) * iotaUsdPrice)}`
      : "";

  return {
    storageMonthlyAtomic,
    rawAtomic,
    feeAtomic,
    totalAtomic,
    summary:
      `base ${formatIotaAtomic(baseAtomic)} IOTA + storage 30d ${formatIotaAtomic(storageMonthlyAtomic)} IOTA + fee ${formatIotaAtomic(feeAtomic)} IOTA = total ${formatIotaAtomic(totalAtomic)} IOTA` +
      usdPart,
  };
}

function templateLabel(template: OracleTemplateCost): string {
  return template.taskType ? `${template.templateId} - ${template.taskType}` : template.templateId;
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseCssColor(input: string | null | undefined): [number, number, number] | null {
  const value = String(input ?? "").trim();
  if (!value) return null;

  const hex = value.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    return [
      Number.parseInt(`${hex[0]}${hex[0]}`, 16),
      Number.parseInt(`${hex[1]}${hex[1]}`, 16),
      Number.parseInt(`${hex[2]}${hex[2]}`, 16),
    ];
  }

  if (/^[0-9a-f]{6}$/i.test(hex)) {
    return [
      Number.parseInt(hex.slice(0, 2), 16),
      Number.parseInt(hex.slice(2, 4), 16),
      Number.parseInt(hex.slice(4, 6), 16),
    ];
  }

  const rgbMatch = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (rgbMatch) {
    return [clampByte(Number(rgbMatch[1])), clampByte(Number(rgbMatch[2])), clampByte(Number(rgbMatch[3]))];
  }

  return null;
}

function toRgbString(rgb: [number, number, number]): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function withRgbOffset(input: string | null | undefined, offset: number): string | null {
  const rgb = parseCssColor(input);
  if (!rgb) return null;
  return toRgbString([clampByte(rgb[0] + offset), clampByte(rgb[1] + offset), clampByte(rgb[2] + offset)]);
}

function readableTextForBackground(background: string | null | undefined, dark = "#171d26", light = "#ffffff"): string {
  const rgb = parseCssColor(background);
  if (!rgb) return dark;
  const [r, g, b] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? dark : light;
}

export default function App() {
  const initialRouteTaskId = taskIdFromPath(window.location.pathname);
  const [status, setStatus] = useState<OracleStatus | null>(null);
  const [examples, setExamples] = useState<ExampleTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currentAccount = useCurrentAccount();
  const { network: walletProviderNetwork, selectNetwork: selectWalletProviderNetwork } = useIotaClientContext();
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [selectedValidateTaskId, setSelectedValidateTaskId] = useState<string>(initialRouteTaskId);
  const [pageMode, setPageMode] = useState<PageMode>(initialRouteTaskId ? "validate" : "monitoring");
  const [menuOpen, setMenuOpen] = useState(false);
  const [supportedNetworks, setSupportedNetworks] = useState<OracleNetwork[]>(FALLBACK_NETWORKS);
  const [activeNetwork, setActiveNetworkState] = useState<OracleNetwork>("mainnet");
  const [networkLoading, setNetworkLoading] = useState(false);
  const [networkConfigLoaded, setNetworkConfigLoaded] = useState(false);
  const [iotaMarketPrice, setIotaMarketPrice] = useState<IotaMarketPriceResponse | null>(null);
  const activeNetworkRef = useRef<OracleNetwork>("mainnet");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hostingText = import.meta.env.VITE_HOSTING_TEXT?.trim() || "";
  const inputBackground = import.meta.env.VITE_THEME_INPUT_BG?.trim() || "#0f1730";
  const cardBackground = import.meta.env.VITE_THEME_CARD_BG?.trim() || "rgba(12, 18, 36, 0.88)";
  const primaryBackground = import.meta.env.VITE_THEME_PRIMARY_BG?.trim() || "#121e3d";
  const themeStyle = {
    "--theme-page-bg": import.meta.env.VITE_THEME_PAGE_BG?.trim() || "#0b1020",
    "--theme-text": import.meta.env.VITE_THEME_TEXT?.trim() || "#ebeff8",
    "--theme-muted-text": import.meta.env.VITE_THEME_MUTED_TEXT?.trim() || "#aab6d3",
    "--theme-accent-text": import.meta.env.VITE_THEME_ACCENT_TEXT?.trim() || "#8fa2d0",
    "--theme-card-bg": cardBackground,
    "--theme-card-border": import.meta.env.VITE_THEME_CARD_BORDER?.trim() || "rgba(143, 162, 208, 0.14)",
    "--theme-input-bg": inputBackground,
    "--theme-input-border": import.meta.env.VITE_THEME_INPUT_BORDER?.trim() || "rgba(143, 162, 208, 0.18)",
    "--theme-primary-bg": primaryBackground,
    "--theme-primary-text": import.meta.env.VITE_THEME_PRIMARY_TEXT?.trim() || "#d8e2f7",
    "--theme-surface-text": readableTextForBackground(inputBackground),
    "--theme-card-surface-text": readableTextForBackground(cardBackground),
    "--theme-primary-contrast-text": readableTextForBackground(primaryBackground),
    "--theme-primary-hover-bg": withRgbOffset(primaryBackground, -18) || primaryBackground,
  } as CSSProperties;

  useEffect(() => {
    const root = document.documentElement;
    const entries = Object.entries(themeStyle).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    for (const [key, value] of entries) {
      root.style.setProperty(key, value);
    }
  }, [themeStyle]);

  async function refreshStatus(network = activeNetworkRef.current) {
    try {
      const data = await fetchStatusForNetwork(network);
      setStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function refreshIotaPrice() {
    try {
      const data = await fetchIotaMarketPrice();
      setIotaMarketPrice(data);
    } catch {
      // Keep previous value if market API is temporarily unavailable.
    }
  }

  useEffect(() => {
    async function init() {
      try {
        const networkConfig = await fetchNetworkConfig();
        const supported = (
          networkConfig.supportedNetworks?.length ? networkConfig.supportedNetworks : FALLBACK_NETWORKS
        ).map((item) => normalizeNetwork(item));
        setSupportedNetworks(Array.from(new Set(supported)));
        const normalizedNetwork = normalizeNetwork(networkConfig.activeNetwork);
        activeNetworkRef.current = normalizedNetwork;
        setActiveNetworkState(normalizedNetwork);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setNetworkConfigLoaded(true);
      }
      await refreshIotaPrice();
      await refreshStatus();
    }

    void init();
    const statusTimer = window.setInterval(() => void refreshStatus(), REFRESH_MS);
    const priceTimer = window.setInterval(() => void refreshIotaPrice(), REFRESH_MS);
    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(priceTimer);
    };
  }, []);

  useEffect(() => {
    activeNetworkRef.current = activeNetwork;
  }, [activeNetwork]);

  useEffect(() => {
    if (walletProviderNetwork === activeNetwork) return;
    selectWalletProviderNetwork(activeNetwork);
  }, [activeNetwork, selectWalletProviderNetwork, walletProviderNetwork]);

  useEffect(() => {
    fetchExamples()
      .then(setExamples)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    function onDocMouseDown(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, []);

  useEffect(() => {
    function syncRouteTask() {
      const routeTaskId = taskIdFromPath(window.location.pathname);
      if (!routeTaskId) return;
      setSelectedValidateTaskId(routeTaskId);
      setPageMode("validate");
    }

    window.addEventListener("popstate", syncRouteTask);
    return () => window.removeEventListener("popstate", syncRouteTask);
  }, []);

  const lastRefreshText = useMemo(() => {
    if (!status?.lastRefreshIso) return "-";
    return new Date(status.lastRefreshIso).toLocaleString();
  }, [status?.lastRefreshIso]);

  const availableTemplates = status?.costs.templates ?? [];

  const selectedTemplate = useMemo(() => {
    if (!selectedTemplateId) return null;
    return availableTemplates.find((template) => template.templateId === selectedTemplateId) ?? null;
  }, [availableTemplates, selectedTemplateId]);

  const iotaPriceText = useMemo(() => {
    if (!iotaMarketPrice) return "IOTA price unavailable";
    return `1 IOTA = $${iotaMarketPrice.usdPrice.toFixed(8)} USD`;
  }, [iotaMarketPrice]);

  const iotaPriceUpdatedText = useMemo(() => {
    if (!iotaMarketPrice?.fetchedAtIso) return "-";
    return new Date(iotaMarketPrice.fetchedAtIso).toLocaleString();
  }, [iotaMarketPrice?.fetchedAtIso]);

  const selectedTemplateMonthlyEstimate = useMemo(
    () =>
      selectedTemplate
        ? buildMonthlyStorageEstimate(
            selectedTemplate,
            parseBps(status?.costs.systemFeeBps ?? null),
            iotaMarketPrice?.usdPrice ?? null,
          )
        : null,
    [selectedTemplate, status?.costs.systemFeeBps, iotaMarketPrice?.usdPrice],
  );

  async function onNetworkChange(nextValue: string) {
    const next = normalizeNetwork(nextValue);
    if (next === activeNetwork) return;

    setNetworkLoading(true);
    try {
      const networkConfig = await updateActiveNetwork(next);
      const normalized = normalizeNetwork(networkConfig.activeNetwork);
      activeNetworkRef.current = normalized;
      setActiveNetworkState(normalized);
      await refreshStatus(normalized);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNetworkLoading(false);
    }
  }

  return (
    <div className="page" style={themeStyle}>
      <header className="hero card">
        <div className="hero-top">
          <div className="hero-main">
            <h1>IOTA Distributed Oracle</h1>
            {hostingText ? <p className="hero-hosting-text">{hostingText}</p> : null}
          </div>

          <div className="hero-side">
            <div className="wallet-toolbar">
              <div className="wallet-top-row">
                <div className="page-switcher" ref={menuRef}>
                  <button
                    type="button"
                    className="page-switcher-trigger"
                    aria-haspopup="menu"
                    aria-expanded={menuOpen}
                    onClick={() => setMenuOpen((prev) => !prev)}
                  >
                    Menu
                  </button>
                  {menuOpen ? (
                    <div className="page-switcher-popup">
                      <Menu
                        mode="vertical"
                        selectedKeys={[pageMode]}
                        className="page-switcher-popup-menu"
                        onClick={({ key }: { key: string }) => {
                          if (
                            key === "run" ||
                            key === "monitoring" ||
                            key === "validate" ||
                            key === "scheduled" ||
                            key === "node-management" ||
                            key === "task-prices" ||
                            key === "terms"
                          ) {
                            setPageMode(key);
                            if (key !== "validate") {
                              pushBrowserPath("/");
                            }
                            setMenuOpen(false);
                          }
                        }}
                      >
                        <RcMenuItem key="monitoring">Monitoring</RcMenuItem>
                        <Divider />
                        <RcMenuItem key="scheduled">Task list</RcMenuItem>
                        <Divider />
                        <RcMenuItem key="run">Create a new task</RcMenuItem>
                        <Divider />
                        <RcMenuItem key="validate">View or validate a task</RcMenuItem>
                        <Divider />
                        <RcMenuItem key="task-prices">Task prices</RcMenuItem>
                        <Divider />
                        <RcMenuItem key="terms">EULA</RcMenuItem>
                        <RcMenuItem key="node-management">Node management</RcMenuItem>
                        <Divider />
                      </Menu>
                    </div>
                  ) : null}
                </div>
                <label className="network-select-wrap" title="IOTA network">
                  <span className="sr-only">Network</span>
                  <select
                    className="network-select"
                    value={activeNetwork}
                    onChange={(event) => void onNetworkChange(event.target.value)}
                    disabled={networkLoading}
                  >
                    {supportedNetworks.map((network) => (
                      <option key={network} value={network}>
                        {network.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="wallet-connect">
                  <ConnectButton connectText="Connect Wallet" />
                </div>
              </div>
              <div className="wallet-status">
                {currentAccount ? (
                  <>
                    <span className="wallet-status-label">Connected:</span>{" "}
                    <span className="mono">{shortAddress(currentAccount.address)}</span>
                  </>
                ) : (
                  "No wallet connected"
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="hero-meta hero-meta-horizontal">
          <div className="hero-meta-item">
            <strong>Last refresh:</strong> {lastRefreshText}
          </div>
          <div className="hero-meta-item">
            <strong>Mode:</strong> {status?.mode ?? "-"}
          </div>
          <div className="hero-meta-item">
            <strong>RPC:</strong> <span className="mono">{status?.rpcUrl ?? "-"}</span>
          </div>
          <div className="hero-meta-item">
            <strong>Tasks package:</strong>{" "}
            <span className="mono">{status?.tasksPackageId ?? status?.packageId ?? "-"}</span>
          </div>
          <div className="hero-meta-item">
            <strong>System package:</strong> <span className="mono">{status?.systemPackageId ?? "-"}</span>
          </div>
          <div className="hero-meta-item">
            <strong>State:</strong> <span className="mono">{status?.stateId ?? "-"}</span>
          </div>
        </div>
      </header>

      {error ? <div className="alert alert-error">{error}</div> : null}
      {status?.warnings?.length ? (
        <div className="alert alert-warn">
          {status.warnings.map((warning) => (
            <div key={warning}>{warning}</div>
          ))}
        </div>
      ) : null}

      {pageMode === "run" ? (
        <>
          <section className="grid metrics-grid">
            <MetricCard
              label="Active nodes"
              value={status?.metrics.activeNodes ?? "-"}
              hint={`Window: ${status?.activeWindowMinutes ?? "-"} min`}
            />
            <MetricCard label="Known nodes" value={status?.metrics.knownNodes ?? "-"} hint="From env or inferred" />
            <MetricCard label="Inactive known nodes" value={status?.metrics.inactiveKnownNodes ?? "-"} />
            <MetricCard label="On-chain task objects" value={status?.metrics.onChainTaskObjects ?? "-"} hint="" />
            <MetricCard label="Total oracle events" value={status?.metrics.totalOracleEvents ?? "-"} hint="" />
          </section>

          <TaskRunner
            examples={examples}
            activeNetwork={activeNetwork}
            registeredNodes={status?.registeredNodes ?? []}
            onExecuted={() => void refreshStatus(activeNetwork)}
            onTemplateIdChange={setSelectedTemplateId}
            onOpenScheduledTasks={() => setPageMode("scheduled")}
          />

          <section className="card card-spaced">
            <div className="section-title">Configured costs</div>

            <div className="table-wrap">
              <table className="responsive-table">
                <thead>
                  <tr>
                    <th>Global setting</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td data-label="Global setting">System fee</td>
                    <td data-label="Value">{status?.costs.systemFeeBps ?? "-"}</td>
                  </tr>
                  <tr>
                    <td data-label="Global setting">Minimum payment</td>
                    <td data-label="Value">{status?.costs.minPayment ?? "-"}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="subsection-title" style={{ marginTop: 18 }}>
              Task templates
            </div>
            {!availableTemplates.length ? (
              <div className="empty">
                No approved task templates found on-chain for this network. Nodes can still advertise supported template
                IDs, but task creation and scheduling require the corresponding templates to be proposed and approved
                first.
              </div>
            ) : !selectedTemplateId ? (
              <div className="template-empty-state">Select or load a task template to view its pricing details.</div>
            ) : !selectedTemplate ? (
              <div className="template-empty-state">
                Template <span className="mono">{selectedTemplateId}</span> is not available on this network.
              </div>
            ) : (
              <div className="template-details-card">
                <div className="template-details-head">
                  <span className="template-details-title">{templateLabel(selectedTemplate)}</span>
                  <span className={`template-status-badge ${selectedTemplate.isEnabled ? "is-on" : "is-off"}`}>
                    {selectedTemplate.isEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>
                <div className="template-details-grid">
                  <div className="template-kv-item">
                    <span className="template-kv-label">Base price</span>
                    <span className="template-kv-value mono">{selectedTemplate.basePriceIota ?? "-"}</span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Storage</span>
                    <span className="template-kv-value">{selectedTemplate.allowStorage ? "yes" : "no"}</span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Input bytes max</span>
                    <span className="template-kv-value mono">{selectedTemplate.maxInputBytes ?? "-"}</span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Output bytes max</span>
                    <span className="template-kv-value mono">{selectedTemplate.maxOutputBytes ?? "-"}</span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Included download bytes</span>
                    <span className="template-kv-value mono">{selectedTemplate.includedDownloadBytes ?? "-"}</span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Price / download byte</span>
                    <span className="template-kv-value mono">{selectedTemplate.pricePerDownloadByteIota ?? "-"}</span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Min retention days</span>
                    <span className="template-kv-value mono">{selectedTemplate.minRetentionDays ?? "-"}</span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Max retention days</span>
                    <span className="template-kv-value mono">{selectedTemplate.maxRetentionDays ?? "-"}</span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Price / retention day</span>
                    <span className="template-kv-value mono">{selectedTemplate.pricePerRetentionDayIota ?? "-"}</span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Storage / month (30d)</span>
                    <span className="template-kv-value mono">
                      {selectedTemplateMonthlyEstimate
                        ? `${selectedTemplateMonthlyEstimate.storageMonthlyAtomic.toString()} (${formatIotaAtomic(selectedTemplateMonthlyEstimate.storageMonthlyAtomic)} IOTA)`
                        : "-"}
                    </span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">IPFS task total / month (30d, no extra download)</span>
                    <span className="template-kv-value">
                      {selectedTemplateMonthlyEstimate ? selectedTemplateMonthlyEstimate.summary : "-"}
                    </span>
                  </div>
                  <div className="template-kv-item">
                    <span className="template-kv-label">Price profile (USD)</span>
                    <span className="template-kv-value">
                      {formatPriceProfile(
                        selectedTemplate,
                        iotaMarketPrice?.usdPrice ?? null,
                        parseBps(status?.costs.systemFeeBps ?? null),
                      )}
                    </span>
                  </div>
                </div>
                <div className="template-price-profile">
                  <div className="template-kv-label">IOTA current price</div>
                  <div className="template-kv-value">{iotaPriceText}</div>
                  <div className="summary-hint" style={{ marginTop: 8 }}>
                    Source:{" "}
                    <a
                      href={iotaMarketPrice?.sourceUrl ?? "https://coinmarketcap.com/currencies/iota/"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      CoinMarketCap
                    </a>
                    {" • "}
                    Updated: {iotaPriceUpdatedText}
                  </div>
                </div>
              </div>
            )}
          </section>
        </>
      ) : pageMode === "monitoring" ? (
        <MonitoringPage activeNetwork={activeNetwork} status={status} readyToLoad={networkConfigLoaded} />
      ) : pageMode === "scheduled" ? (
        <TaskSchedulesPage
          activeNetwork={activeNetwork}
          tasksPackageId={status?.tasksPackageId ?? null}
          systemPackageId={status?.systemPackageId ?? null}
          readyToLoad={networkConfigLoaded}
          onSelectTask={(taskId) => {
            setSelectedValidateTaskId(taskId);
            setPageMode("validate");
            pushBrowserPath(taskPath(taskId));
          }}
        />
      ) : pageMode === "node-management" ? (
        <NodeManagementPage
          activeNetwork={activeNetwork}
          status={status}
          onChanged={() => void refreshStatus(activeNetwork)}
        />
      ) : pageMode === "task-prices" ? (
        <TaskPricesPage
          templates={availableTemplates}
          systemFeeBps={status?.costs.systemFeeBps}
          minPayment={status?.costs.minPayment}
          iotaMarketPrice={iotaMarketPrice}
        />
      ) : pageMode === "terms" ? (
        <TermsPage />
      ) : (
        <ValidateTaskPage
          initialTaskId={selectedValidateTaskId}
          activeNetwork={activeNetwork}
          readyToValidate={networkConfigLoaded}
        />
      )}
    </div>
  );
}
