// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { useEffect, useMemo, useRef, useState } from "react";
import { useCurrentAccount, useSignAndExecuteTransaction } from "@iota/dapp-kit";
import { IotaClient } from "@iota/iota-sdk/client";
import {
  prepareNodeManagementWallet,
  prepareProposalApprovalWallet,
} from "../lib/api";
import { getChainForOracleNetwork } from "../lib/iotaNetwork";
import type { OracleNetwork, OracleStatus, OracleTemplateCost } from "../types";

type Props = {
  activeNetwork: OracleNetwork;
  status: OracleStatus | null;
  onChanged?: () => void;
};

const MAINNET_RPC_URL = import.meta.env.VITE_IOTA_MAINNET_RPC_URL?.trim() || "https://api.mainnet.iota.cafe";
const TESTNET_RPC_URL = import.meta.env.VITE_IOTA_TESTNET_RPC_URL?.trim() || "https://api.testnet.iota.cafe";
const DEVNET_RPC_URL =
  import.meta.env.VITE_IOTA_DEVNET_RPC_URL?.trim() ||
  import.meta.env.VITE_IOTA_RPC_URL?.trim() ||
  "https://api.devnet.iota.cafe";

function normalizeAddress(value: unknown): string {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return "";
  return text.startsWith("0x") ? text : `0x${text}`;
}

function shortAddress(address: string | null | undefined, start = 6, end = 4): string {
  const value = String(address ?? "").trim();
  if (!value) return "-";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function templateLabel(template: OracleTemplateCost): string {
  return template.taskType ? `${template.templateId} - ${template.taskType}` : template.templateId;
}

const SCHEDULER_TEMPLATE: OracleTemplateCost = {
  templateId: "0",
  taskType: "Scheduler loop capability",
  isEnabled: true,
  basePriceIota: null,
  schedulerFeeIota: null,
  maxInputBytes: null,
  maxOutputBytes: null,
  includedDownloadBytes: null,
  pricePerDownloadByteIota: null,
  allowStorage: false,
  minRetentionDays: null,
  maxRetentionDays: null,
  pricePerRetentionDayIota: null,
};

function proposalKindLabel(kind: number): string {
  if (kind === 1) return "UPSERT";
  if (kind === 2) return "REMOVE";
  return String(kind);
}

export default function NodeManagementPage({ activeNetwork, status, onChanged }: Props) {
  const currentAccount = useCurrentAccount();
  const connectedAddress = normalizeAddress(currentAccount?.address);
  const [selectedTemplateIds, setSelectedTemplateIds] = useState<number[]>([]);
  const [approvedProposalIds, setApprovedProposalIds] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busyProposalId, setBusyProposalId] = useState<string | null>(null);
  const lastSyncedNodeAddressRef = useRef("");
  const lastSyncedTemplateSignatureRef = useRef("");

  const rpcClients = useMemo(
    () => ({
      mainnet: new IotaClient({ url: MAINNET_RPC_URL }),
      testnet: new IotaClient({ url: TESTNET_RPC_URL }),
      devnet: new IotaClient({ url: DEVNET_RPC_URL }),
    }),
    [],
  );
  const networkClient = rpcClients[activeNetwork];
  const { mutateAsync: signAndExecuteTransaction } = useSignAndExecuteTransaction({
    execute: async ({ bytes, signature }) =>
      await networkClient.executeTransactionBlock({
        transactionBlock: bytes,
        signature,
        options: {
          showRawEffects: true,
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        },
      }),
  });

  const node = useMemo(
    () => status?.registeredNodes.find((item) => normalizeAddress(item.address) === connectedAddress) ?? null,
    [connectedAddress, status?.registeredNodes],
  );
  const nodeTemplateIds = useMemo(
    () =>
      node?.acceptedTemplateIds
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item >= 0)
        .sort((a, b) => a - b) ?? [],
    [node?.acceptedTemplateIds],
  );
  const nodeTemplateSignature = useMemo(() => nodeTemplateIds.join(","), [nodeTemplateIds]);

  useEffect(() => {
    if (!node) {
      setSelectedTemplateIds([]);
      lastSyncedNodeAddressRef.current = "";
      lastSyncedTemplateSignatureRef.current = "";
      return;
    }
    const nodeAddress = normalizeAddress(node.address);
    setSelectedTemplateIds((prev) => {
      const prevSignature = prev.join(",");
      const nodeChanged = lastSyncedNodeAddressRef.current !== nodeAddress;
      const canResync =
        nodeChanged ||
        prevSignature === lastSyncedTemplateSignatureRef.current ||
        prevSignature === nodeTemplateSignature;
      return canResync ? nodeTemplateIds : prev;
    });
    lastSyncedNodeAddressRef.current = nodeAddress;
    lastSyncedTemplateSignatureRef.current = nodeTemplateSignature;
  }, [node, nodeTemplateIds, nodeTemplateSignature]);

  useEffect(() => {
    let cancelled = false;

    async function loadApprovedProposals() {
      if (!connectedAddress || !status?.stateId) {
        if (!cancelled) setApprovedProposalIds([]);
        return;
      }

      try {
        const approved = new Set<string>();
        let cursor: string | null | undefined = null;

        for (;;) {
          const page: any = await networkClient.getDynamicFields({
            parentId: status.stateId,
            cursor,
            limit: 100,
          } as any);

          for (const item of page?.data ?? []) {
            const nameType = String(item?.name?.type ?? "");
            if (!nameType.includes("TemplateProposalApprovalKey")) continue;
            const value = item?.name?.value ?? {};
            const voter = normalizeAddress(value?.voter);
            if (voter !== connectedAddress) continue;
            const proposalId = String(value?.proposal_id ?? "").trim();
            if (proposalId) approved.add(proposalId);
          }

          if (!page?.hasNextPage || !page?.nextCursor) break;
          cursor = page.nextCursor;
        }

        if (!cancelled) setApprovedProposalIds(Array.from(approved).sort((a, b) => Number(a) - Number(b)));
      } catch {
        if (!cancelled) setApprovedProposalIds([]);
      }
    }

    void loadApprovedProposals();

    return () => {
      cancelled = true;
    };
  }, [connectedAddress, networkClient, status?.stateId, activeNetwork]);

  const templates = useMemo(() => [SCHEDULER_TEMPLATE, ...(status?.costs.templates ?? [])], [status?.costs.templates]);
  const pendingProposals = status?.pendingTemplateProposals ?? [];
  const canApproveProposals = Boolean(node);
  const allTemplateIds = useMemo(
    () =>
      templates
        .map((item) => Number(item.templateId))
        .filter((item) => Number.isFinite(item) && item >= 0)
        .sort((a, b) => a - b),
    [templates],
  );
  const allTemplatesSelected = useMemo(
    () =>
      allTemplateIds.length > 0 &&
      allTemplateIds.every((templateId) => selectedTemplateIds.includes(templateId)),
    [allTemplateIds, selectedTemplateIds],
  );
  const hasTemplateChanges = useMemo(() => {
    if (!node) return false;
    return nodeTemplateSignature !== selectedTemplateIds.join(",");
  }, [node, nodeTemplateSignature, selectedTemplateIds]);

  function toggleTemplate(templateId: number) {
    setSelectedTemplateIds((prev) =>
      prev.includes(templateId) ? prev.filter((item) => item !== templateId) : [...prev, templateId].sort((a, b) => a - b),
    );
  }

  function selectAllTemplates() {
    setSelectedTemplateIds(allTemplateIds);
  }

  function clearAllTemplates() {
    setSelectedTemplateIds([]);
  }

  async function waitForDigest(digest: string) {
    if (!digest || typeof (networkClient as any)?.waitForTransaction !== "function") return;
    try {
      await (networkClient as any).waitForTransaction({
        digest,
        options: {
          showEffects: true,
          showObjectChanges: true,
          showEvents: true,
        },
      });
    } catch {
      // Best effort only.
    }
  }

  async function handleSave() {
    if (!currentAccount?.address) {
      setError("Connect a wallet to manage the node.");
      return;
    }
    if (!node) {
      setError("The connected wallet is not registered as an oracle node on this network.");
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const prepared = await prepareNodeManagementWallet(selectedTemplateIds, currentAccount.address, activeNetwork);
      const execution = await signAndExecuteTransaction({
        transaction: prepared.serializedTransaction,
        chain: getChainForOracleNetwork(activeNetwork),
      });
      const digest = String((execution as any)?.digest ?? "").trim();
      await waitForDigest(digest);
      setNotice(`Node updated${digest ? ` (${digest})` : ""}.`);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove(proposalId: string, templateId: string) {
    if (!currentAccount?.address) {
      setError("Connect a wallet to approve proposals.");
      return;
    }
    if (!node) {
      setError("Only registered oracle nodes can approve proposals.");
      return;
    }

    setBusyProposalId(proposalId);
    setError(null);
    setNotice(null);
    try {
      const prepared = await prepareProposalApprovalWallet(
        Number(proposalId),
        Number(templateId),
        currentAccount.address,
        activeNetwork,
      );
      const execution = await signAndExecuteTransaction({
        transaction: prepared.serializedTransaction,
        chain: getChainForOracleNetwork(activeNetwork),
      });
      const digest = String((execution as any)?.digest ?? "").trim();
      await waitForDigest(digest);
      setApprovedProposalIds((prev) =>
        prev.includes(proposalId) ? prev : [...prev, proposalId].sort((a, b) => Number(a) - Number(b)),
      );
      setNotice(`Proposal ${proposalId} approved${digest ? ` (${digest})` : ""}.`);
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyProposalId(null);
    }
  }

  return (
    <>
      {error ? <div className="alert alert-error">{error}</div> : null}
      {notice ? <div className="alert alert-warn">{notice}</div> : null}

      <section className="card card-spaced">
        <div className="section-title">Node state</div>
        {!connectedAddress ? (
          <div className="empty">Connect a wallet to manage a node.</div>
        ) : !node ? (
          <div className="empty">
            No oracle node is registered for <span className="mono">{shortAddress(connectedAddress)}</span> on this network.
          </div>
        ) : (
          <div className="template-details-grid">
            <div className="template-kv-item">
              <span className="template-kv-label">Node address</span>
              <span className="template-kv-value mono">{node.address}</span>
            </div>
            <div className="template-kv-item">
              <span className="template-kv-label">Current templates</span>
              <span className="template-kv-value mono">
                {node.acceptedTemplateIds.length ? node.acceptedTemplateIds.join(", ") : "<none>"}
              </span>
            </div>
            <div className="template-kv-item">
              <span className="template-kv-label">Delegated controller cap</span>
              <span className="template-kv-value mono">{shortAddress(node.delegatedControllerCapId)}</span>
            </div>
            <div className="template-kv-item">
              <span className="template-kv-label">Validator</span>
              <span className="template-kv-value">
                {node.validatorName ? `${node.validatorName} (${shortAddress(node.validatorId)})` : shortAddress(node.validatorId)}
              </span>
            </div>
          </div>
        )}
      </section>

      <section className="card card-spaced">
        <div className="section-title">Supported task types</div>
        {!connectedAddress || !node ? (
          <div className="empty">Node registration required to update supported task types.</div>
        ) : !templates.length ? (
          <div className="empty">No approved task templates available on this network.</div>
        ) : (
          <>
            <div className="summary-hint" style={{ marginBottom: 16 }}>
              Template <span className="mono">0</span> is reserved for scheduler capability and can be enabled from this same list when needed.
            </div>
            <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
              <button
                type="button"
                className="page-switcher-trigger"
                disabled={saving || allTemplatesSelected}
                onClick={selectAllTemplates}
              >
                Select all
              </button>
              <button
                type="button"
                className="page-switcher-trigger"
                disabled={saving || selectedTemplateIds.length === 0}
                onClick={clearAllTemplates}
              >
                Clear all
              </button>
            </div>
            <div className="table-wrap">
              <table className="responsive-table">
                <thead>
                  <tr>
                    <th>Enabled</th>
                    <th>Template</th>
                    <th>Status</th>
                    <th>Base price</th>
                  </tr>
                </thead>
                <tbody>
                  {templates.map((template) => {
                    const templateId = Number(template.templateId);
                    const checked = selectedTemplateIds.includes(templateId);
                    return (
                      <tr key={template.templateId}>
                        <td data-label="Enabled">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleTemplate(templateId)}
                            disabled={saving}
                          />
                        </td>
                        <td data-label="Template">{templateLabel(template)}</td>
                        <td data-label="Status">
                          <span className={`template-status-badge ${template.isEnabled ? "is-on" : "is-off"}`}>
                            {template.isEnabled ? "Enabled" : "Disabled"}
                          </span>
                        </td>
                        <td data-label="Base price" className="mono">
                          {template.basePriceIota ?? "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                className="page-switcher-trigger"
                disabled={!hasTemplateChanges || saving}
                onClick={() => void handleSave()}
              >
                {saving ? "Saving..." : "Save node configuration"}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card card-spaced">
        <div className="section-title">Task approvals</div>
        {!pendingProposals.length ? (
          <div className="empty">No pending template proposals.</div>
        ) : (
          <div className="table-wrap">
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>Proposal</th>
                  <th>Template</th>
                  <th>Kind</th>
                  <th>Task type</th>
                  <th>Approvals</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {pendingProposals.map((proposal) => (
                  <tr key={proposal.proposalId}>
                    <td data-label="Proposal" className="mono">
                      {proposal.proposalId}
                    </td>
                    <td data-label="Template" className="mono">
                      {proposal.templateId}
                    </td>
                    <td data-label="Kind">{proposalKindLabel(proposal.proposalKind)}</td>
                    <td data-label="Task type">{proposal.taskType ?? "-"}</td>
                    <td data-label="Approvals" className="mono">
                      {proposal.approvals}/{proposal.approvalsNeeded}
                    </td>
                    <td data-label="Action">
                      {approvedProposalIds.includes(proposal.proposalId) ? (
                        <button
                          type="button"
                          className="scheduled-action-button"
                          disabled
                        >
                          Approved
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="scheduled-action-button"
                          disabled={!canApproveProposals || busyProposalId === proposal.proposalId}
                          onClick={() => void handleApprove(proposal.proposalId, proposal.templateId)}
                        >
                          {busyProposalId === proposal.proposalId ? "Approving..." : "Approve"}
                        </button>
                      )}
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
