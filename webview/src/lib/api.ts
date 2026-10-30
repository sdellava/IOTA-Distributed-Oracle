import { walletPost } from "./walletSession";
// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import type {
  ExampleTask,
  NetworkConfigResponse,
  OracleNetwork,
  OracleStatus,
  PreparedWalletTaskResponse,
  PreparedTaskScheduleWalletResponse,
  PreparedScheduledTaskActionWalletResponse,
  IotaMarketPriceResponse,
  PreparedNodeManagementWalletResponse,
  PreparedProposalApprovalWalletResponse,
  ScheduledTaskActionRequest,
  TaskSchedulesResponse,
} from '../types';

async function ensureOk<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function fetchStatus(): Promise<OracleStatus> {
  return ensureOk<OracleStatus>(await fetch('/api/status'));
}

export async function fetchStatusForNetwork(network: OracleNetwork): Promise<OracleStatus> {
  return ensureOk<OracleStatus>(await fetch(`/api/status?network=${encodeURIComponent(network)}`));
}

export async function fetchNetworkConfig(): Promise<NetworkConfigResponse> {
  return ensureOk<NetworkConfigResponse>(await fetch('/api/network'));
}

// Network selection is per client; reading configuration never mutates server state.
export async function updateActiveNetwork(network: OracleNetwork): Promise<NetworkConfigResponse> {
  return ensureOk<NetworkConfigResponse>(await fetch(`/api/network?network=${encodeURIComponent(network)}`));
}

export async function fetchExamples(): Promise<ExampleTask[]> {
  return ensureOk<ExampleTask[]>(await fetch('/api/examples'));
}

export async function fetchExampleContent(name: string): Promise<unknown> {
  return ensureOk<unknown>(await fetch(`/api/examples/${encodeURIComponent(name)}`));
}


export async function prepareWalletTask(
  task: unknown,
  sender: string,
  network: OracleNetwork,
): Promise<PreparedWalletTaskResponse> {
  return ensureOk<PreparedWalletTaskResponse>(
    await walletPost('/api/tasks/prepare-wallet', { task, sender, network }),
  );
}

export async function prepareWalletTaskSchedule(
  task: unknown,
  schedule: unknown,
  sender: string,
  network: OracleNetwork,
): Promise<PreparedTaskScheduleWalletResponse> {
  return ensureOk<PreparedTaskScheduleWalletResponse>(
    await walletPost('/api/tasks/prepare-task-schedule-wallet', { task, schedule, sender, network }),
  );
}

export async function fetchIotaMarketPrice(): Promise<IotaMarketPriceResponse> {
  return ensureOk<IotaMarketPriceResponse>(await fetch('/api/market/iota-price'));
}

export async function fetchTaskSchedules(network: OracleNetwork): Promise<TaskSchedulesResponse> {
  return ensureOk<TaskSchedulesResponse>(
    await fetch(`/api/task-schedules?network=${encodeURIComponent(network)}`),
  );
}

export async function prepareScheduledTaskActionWallet(
  action: ScheduledTaskActionRequest,
  sender: string,
  network: OracleNetwork,
): Promise<PreparedScheduledTaskActionWalletResponse> {
  return ensureOk<PreparedScheduledTaskActionWalletResponse>(
    await walletPost('/api/task-schedules/prepare-action-wallet', { action, sender, network }),
  );
}

export async function prepareNodeManagementWallet(
  acceptedTemplateIds: number[],
  sender: string,
  network: OracleNetwork,
): Promise<PreparedNodeManagementWalletResponse> {
  return ensureOk<PreparedNodeManagementWalletResponse>(
    await walletPost('/api/node-management/prepare-wallet', { acceptedTemplateIds, sender, network }),
  );
}

export async function prepareProposalApprovalWallet(
  proposalId: number,
  templateId: number,
  sender: string,
  network: OracleNetwork,
): Promise<PreparedProposalApprovalWalletResponse> {
  return ensureOk<PreparedProposalApprovalWalletResponse>(
    await walletPost('/api/node-management/prepare-approve-wallet', { proposalId, templateId, sender, network }),
  );
}
