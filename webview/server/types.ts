// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

export type OracleEventItem = {
  txDigest: string;
  eventSeq: string;
  sender: string;
  module: string;
  eventType: string;
  timestampMs: string | null;
  parsedJson: unknown;
};

export type NodeActivity = {
  sender: string;
  acceptedTasks: string[];
  lastSeenMs: string | null;
  active: boolean;
  validatorId?: string | null;
  validatorName?: string | null;
};

export type RegisteredOracleNode = {
  nodeId?: string | null;
  address: string;
  pubkey: unknown;
  pubkeyBytes: number;
  acceptedTemplateIds: string[];
  delegatedControllerCapId?: string | null;
  validatorId?: string | null;
  validatorName?: string | null;
};

export type OracleTemplateCost = {
  templateId: string;
  taskType: string;
  isEnabled: boolean;
  basePriceIota: string | null;
  schedulerFeeIota: string | null;
  maxInputBytes: string | null;
  maxOutputBytes: string | null;
  includedDownloadBytes: string | null;
  pricePerDownloadByteIota: string | null;
  allowStorage: boolean;
  minRetentionDays: string | null;
  maxRetentionDays: string | null;
  pricePerRetentionDayIota: string | null;
};

export type PendingTemplateProposal = {
  proposalId: string;
  templateId: string;
  proposalKind: number;
  approvals: string;
  electorateSize: string;
  approvalsNeeded: string;
  taskType: string | null;
  isEnabled: boolean | null;
};

export type OracleStatusResponse = {
  ok: boolean;
  mode: "live" | "degraded";
  network: string;
  rpcUrl: string;
  packageId: string | null;
  tasksPackageId: string | null;
  systemPackageId: string | null;
  stateId: string | null;
  latestCheckpoint: string | null;
  activeWindowMinutes: number;
  eventFetchLimit: number;
  lastRefreshIso: string;
  metrics: {
    activeNodes: number;
    knownNodes: number | null;
    inactiveKnownNodes: number | null;
    onChainTaskObjects: number | null;
    totalOracleEvents: number | null;
    taskEvents: number;
    messageEvents: number;
    totalEvents: number;
  };
  costs: {
    systemFeeBps: string | null;
    minPayment: string | null;
    templates: OracleTemplateCost[];
  };
  pendingTemplateProposals: PendingTemplateProposal[];
  registeredNodes: RegisteredOracleNode[];
  nodeActivity: NodeActivity[];
  recentEvents: OracleEventItem[];
  warnings: string[];
};

export type TaskScheduleItem = {
  id: string;
  creator: string;
  status: number;
  statusLabel: string;
  templateId: string;
  runCount: string;
  nextRunMs: string;
  lastRunMs: string;
  startScheduleMs: string;
  endScheduleMs: string;
  intervalMs: string;
  balanceIota: string;
  lastSchedulerNode: string | null;
};

export type TaskSchedulesResponse = {
  ok: boolean;
  network: string;
  registryId: string | null;
  schedulerQueueId: string | null;
  queue: {
    head: string | null;
    nodes: string[];
    activeRoundStartedMs: string;
    lastRoundCompletedMs: string;
    roundCounter: string;
  } | null;
  items: TaskScheduleItem[];
  warnings: string[];
};

export type PreparedTaskScheduleWalletResponse = {
  ok: true;
  mode: "prepare-task-schedule-webview";
  executionMode: "direct" | "scheduled";
  sender: string;
  serializedTransaction: string;
  gasBudget: string;
  initialFunds: string;
  requiredPayment: string;
  requiredPerRun: string;
  estimatedRuns: string | null;
  targetFunction: string;
  template: {
    templateId: number;
    taskType: string;
  };
  schedule: {
    startScheduleMs: string;
    endScheduleMs: string;
    intervalMs: string;
  };
  prepared: {
    templateId: number;
    taskType: string;
    requestedNodes: number;
    quorumK: number;
    retentionDays: number;
    declaredDownloadBytes: string;
    mediationMode: number;
    varianceMax: number;
    createResultControllerCap: number;
    storageSourceUrl?: string;
    payloadJson: unknown;
  };
  cwd: string;
  command: string;
  taskFilePath: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
};

export type PreparedScheduledTaskActionWalletResponse = {
  ok: true;
  mode: "prepare-scheduled-task-action-webview";
  sender: string;
  action: "suspend" | "reactivate" | "delete" | "fund";
  taskId: string;
  serializedTransaction: string;
  gasBudget: string;
  amount: string | null;
  useSupervisor: boolean;
  controllerCapId: string | null;
  target: string;
  cwd: string;
  command: string;
  taskFilePath: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string;
};

export type PreparedNodeManagementWalletResponse = {
  ok: true;
  mode: "prepare-node-management-webview";
  sender: string;
  nodeAddress: string;
  serializedTransaction: string;
  gasBudget: string;
  acceptedTemplateIds: string[];
  target: string;
  registrationMode: "dev" | "prod";
  delegatedControllerCapId: string | null;
};

export type PreparedProposalApprovalWalletResponse = {
  ok: true;
  mode: "prepare-proposal-approval-webview";
  sender: string;
  proposalId: string;
  templateId: string;
  serializedTransaction: string;
  gasBudget: string;
  target: string;
};
