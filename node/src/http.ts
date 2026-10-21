// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { fetchTaskBytes } from "./taskHttp";

export const httpFetchBytes = fetchTaskBytes;

export async function httpFetchText(opts: Parameters<typeof fetchTaskBytes>[0]): Promise<string> {
  const result = await fetchTaskBytes(opts);
  return result.bytes.toString("utf8");
}
