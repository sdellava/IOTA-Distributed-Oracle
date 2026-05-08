// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { runTask } from "./tasks/index";

export async function executeTask(opts: {
  taskType: string;
  payload: any;
  taskId?: string;
  nodeId?: string;
  templateId?: number;
  declaredDownloadBytes?: number;
  retentionDays?: number;
  taskCreatedAtMs?: number;
  previousResult?: string | null;
}): Promise<string> {
  return runTask(opts.taskType, opts.payload, {
    taskId: opts.taskId,
    nodeId: opts.nodeId,
    templateId: opts.templateId,
    declaredDownloadBytes: opts.declaredDownloadBytes,
    retentionDays: opts.retentionDays,
    taskCreatedAtMs: opts.taskCreatedAtMs,
    previousResult: opts.previousResult,
  });
}
