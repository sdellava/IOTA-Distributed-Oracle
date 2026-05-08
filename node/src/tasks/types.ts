// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

export type TaskHandlerContext = {
  taskType: string;
  payload: any;
  taskId?: string;
  nodeId?: string;
  templateId?: number;
  declaredDownloadBytes?: number;
  retentionDays?: number;
  taskCreatedAtMs?: number;
  previousResult?: string | null;
};

export type TaskHandler = (ctx: TaskHandlerContext) => Promise<string>;
