// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { useMemo, useState } from "react";
import type { IotaMarketPriceResponse, OracleTemplateCost } from "../types";

type Props = {
  templates: OracleTemplateCost[];
  systemFeeBps: string | null | undefined;
  minPayment: string | null | undefined;
  iotaMarketPrice: IotaMarketPriceResponse | null;
};

type CurrencyMode = "usd" | "eur";

type TemplateQuote = {
  base: bigint | null;
  downloadUnit: bigint;
  retentionUnit: bigint;
  schedulerFee: bigint;
  minPayment: bigint;
  minRetentionDays: bigint;
  minRetentionCost: bigint;
  minPerNodeRaw: bigint | null;
  minRawTask: bigint | null;
  minSystemFee: bigint | null;
  minTotal: bigint | null;
  minRequiredPayment: bigint | null;
  minDirect: bigint | null;
  minScheduledPerRun: bigint | null;
};

const IOTA_DECIMALS = 1_000_000_000;

function parseAtomicIota(value: string | null | undefined): bigint | null {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!/^\d+$/.test(trimmed)) return null;
  return BigInt(trimmed);
}

function parseBps(value: string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseU64(value: string | null | undefined): bigint {
  const parsed = parseAtomicIota(value);
  return parsed ?? 0n;
}

function formatNumber(value: number, minimumFractionDigits = 0, maximumFractionDigits = 6): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits,
    maximumFractionDigits,
  });
}

function formatInteger(value: string | null | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "-";
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  return n.toLocaleString();
}

function formatIotaAtomic(value: bigint | null | undefined, digits = 6): string {
  if (value == null) return "-";
  return `${formatNumber(Number(value) / IOTA_DECIMALS, 0, digits)} IOTA`;
}

function formatCurrency(value: bigint | null, market: IotaMarketPriceResponse | null, currency: CurrencyMode): string {
  if (value == null || !market) return "-";
  const iota = Number(value) / IOTA_DECIMALS;
  const usd = iota * market.usdPrice;
  const selected = currency === "eur" ? usd * market.usdToEurRate : usd;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: 2,
    maximumFractionDigits: selected < 1 ? 6 : 2,
  }).format(selected);
}

function ceilDiv(value: bigint, divisor: bigint): bigint {
  if (divisor <= 0n) return 0n;
  return (value + divisor - 1n) / divisor;
}

function computeTemplateQuote(template: OracleTemplateCost, systemFeeBps: number, minPayment: bigint): TemplateQuote {
  const base = parseAtomicIota(template.basePriceIota);
  const downloadUnit = parseU64(template.pricePerDownloadByteIota);
  const retentionUnit = parseU64(template.pricePerRetentionDayIota);
  const schedulerFee = parseU64(template.schedulerFeeIota);
  const minRetentionDays = parseU64(template.minRetentionDays);
  const minRetentionCost = retentionUnit * minRetentionDays;

  if (base == null) {
    return {
      base,
      downloadUnit,
      retentionUnit,
      schedulerFee,
      minPayment,
      minRetentionDays,
      minRetentionCost,
      minPerNodeRaw: null,
      minRawTask: null,
      minSystemFee: null,
      minTotal: null,
      minRequiredPayment: null,
      minDirect: null,
      minScheduledPerRun: null,
    };
  }

  const minPerNodeRaw = base + minRetentionCost;
  const minRawTask = minPerNodeRaw;
  const minSystemFee = systemFeeBps > 0 ? ceilDiv(minRawTask * BigInt(systemFeeBps), 10_000n) : 0n;
  const minTotal = minRawTask + minSystemFee;
  const minRequiredPayment = minTotal > minPayment ? minTotal : minPayment;
  const minDirect = minRequiredPayment;
  const minScheduledPerRun = minRequiredPayment + schedulerFee;

  return {
    base,
    downloadUnit,
    retentionUnit,
    schedulerFee,
    minPayment,
    minRetentionDays,
    minRetentionCost,
    minPerNodeRaw,
    minRawTask,
    minSystemFee,
    minTotal,
    minRequiredPayment,
    minDirect,
    minScheduledPerRun,
  };
}

function CostItem({
  label,
  value,
  hint,
  tone = "normal",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "normal" | "accent" | "muted";
}) {
  return (
    <div className={`price-component price-component-${tone}`}>
      <div className="template-kv-label">{label}</div>
      <div className="template-kv-value mono">{value}</div>
      {hint ? <div className="summary-hint">{hint}</div> : null}
    </div>
  );
}

export default function TaskPricesPage({ templates, systemFeeBps, minPayment, iotaMarketPrice }: Props) {
  const [showEuro, setShowEuro] = useState(false);
  const currency: CurrencyMode = showEuro ? "eur" : "usd";
  const feeBps = useMemo(() => parseBps(systemFeeBps), [systemFeeBps]);
  const minPaymentAtomic = useMemo(() => parseU64(minPayment), [minPayment]);

  return (
    <section className="card card-spaced task-prices-page">
      <div className="task-prices-head">
        <div>
          <div className="section-title">Task Prices</div>
          <p className="task-prices-intro">
            The page shows the complete pricing model used by task creation. Template values are fixed on-chain; runtime
            values such as requested nodes, declared download bytes, retention days, and run count are applied when a
            specific task is prepared.
          </p>
        </div>

        <label className="currency-toggle">
          <input type="checkbox" checked={showEuro} onChange={(event) => setShowEuro(event.target.checked)} />
          <span>Show EUR instead of USD</span>
        </label>
      </div>

      <div className="price-formula-panel">
        <div className="subsection-title">Pricing formula</div>
        <div className="price-formula-grid">
          <CostItem
            label="Per-node raw"
            value="base + download + retention"
            hint="download = extra bytes x unit price; retention = days x day price"
            tone="accent"
          />
          <CostItem label="Raw task" value="per-node raw x requested nodes" />
          <CostItem label="System fee" value="ceil(raw task x fee bps / 10000)" />
          <CostItem label="Required payment" value="max(raw task + system fee, min payment)" tone="accent" />
          <CostItem label="Direct one-shot" value="required payment" />
          <CostItem label="Scheduled run" value="required payment + scheduler fee" />
        </div>
        <div className="summary-hint">
          Current global system fee: <span className="mono">{feeBps} bps</span>. Minimum payment:{" "}
          <span className="mono">{formatIotaAtomic(minPaymentAtomic)}</span>. IOTA/USD:{" "}
          <span className="mono">{iotaMarketPrice ? iotaMarketPrice.usdPrice.toFixed(8) : "-"}</span>. USD/EUR:{" "}
          <span className="mono">{iotaMarketPrice ? iotaMarketPrice.usdToEurRate.toFixed(4) : "-"}</span>.
        </div>
      </div>

      {!templates.length ? (
        <div className="empty">
          No approved task templates found on-chain for this network. Prices will appear here as soon as templates are
          available.
        </div>
      ) : (
        <div className="price-template-list">
          {templates.map((template) => {
            const quote = computeTemplateQuote(template, feeBps, minPaymentAtomic);
            return (
              <article className="price-template-card" key={template.templateId}>
                <div className="price-template-head">
                  <div>
                    <div className="template-kv-label">Template</div>
                    <div className="price-template-title">
                      <span className="mono">{template.templateId}</span>
                      <span>{template.taskType || "-"}</span>
                    </div>
                  </div>
                  <span className={`template-status-badge ${template.isEnabled ? "is-on" : "is-off"}`}>
                    {template.isEnabled ? "Enabled" : "Disabled"}
                  </span>
                </div>

                <div className="price-component-grid">
                  <CostItem
                    label="Base price"
                    value={formatIotaAtomic(quote.base)}
                    hint="Fixed base amount for one node execution."
                  />
                  <CostItem
                    label="Scheduler fee"
                    value={formatIotaAtomic(quote.schedulerFee)}
                    hint="Added only to each scheduled run, not to direct one-shot tasks."
                  />
                  <CostItem
                    label="Input bytes max"
                    value={formatInteger(template.maxInputBytes)}
                    hint="Maximum accepted payload size for this template."
                    tone="muted"
                  />
                  <CostItem
                    label="Output bytes max"
                    value={formatInteger(template.maxOutputBytes)}
                    hint="Maximum declared output/download size."
                    tone="muted"
                  />
                  <CostItem
                    label="Included download bytes"
                    value={formatInteger(template.includedDownloadBytes)}
                    hint="Bytes included before extra download pricing starts."
                  />
                  <CostItem
                    label="Price per extra byte"
                    value={formatIotaAtomic(quote.downloadUnit, 9)}
                    hint="Applied to max(0, declared bytes - included bytes)."
                  />
                  <CostItem
                    label="Storage"
                    value={template.allowStorage ? "Allowed" : "Not allowed"}
                    hint="Controls whether retention pricing can be used."
                    tone={template.allowStorage ? "accent" : "muted"}
                  />
                  <CostItem
                    label="Retention days"
                    value={`${formatInteger(template.minRetentionDays)} min / ${formatInteger(template.maxRetentionDays)} max`}
                    hint="Runtime retention_days must stay inside this range."
                  />
                  <CostItem
                    label="Retention price/day"
                    value={formatIotaAtomic(quote.retentionUnit)}
                    hint="Multiplied by task retention_days."
                  />
                  <CostItem
                    label="Min retention cost"
                    value={formatIotaAtomic(quote.minRetentionCost)}
                    hint={`${quote.minRetentionDays.toString()} day(s) x retention price/day.`}
                  />
                  <CostItem
                    label="Minimum per-node raw"
                    value={formatIotaAtomic(quote.minPerNodeRaw)}
                    hint="Base price + minimum retention cost, before requested_nodes."
                    tone="accent"
                  />
                  <CostItem
                    label="System fee on minimum"
                    value={formatIotaAtomic(quote.minSystemFee)}
                    hint={`${feeBps} bps rounded up on minimum raw task price.`}
                  />
                  <CostItem
                    label="Required payment min"
                    value={formatIotaAtomic(quote.minRequiredPayment)}
                    hint={`After min payment floor: ${formatIotaAtomic(quote.minPayment)}.`}
                    tone="accent"
                  />
                  <CostItem
                    label="Direct one-shot min"
                    value={formatIotaAtomic(quote.minDirect)}
                    hint={formatCurrency(quote.minDirect, iotaMarketPrice, currency)}
                    tone="accent"
                  />
                  <CostItem
                    label="Scheduled per-run min"
                    value={formatIotaAtomic(quote.minScheduledPerRun)}
                    hint={formatCurrency(quote.minScheduledPerRun, iotaMarketPrice, currency)}
                    tone="accent"
                  />
                </div>
              </article>
            );
          })}
        </div>
      )}

      <div className="summary-hint">
        Minimum totals assume one requested node, zero extra download bytes, and the template minimum retention days.
        Real task quotes scale with requested_nodes, declared download bytes, retention_days, and scheduled run count.
      </div>
    </section>
  );
}
