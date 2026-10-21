// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import { httpFetchBytes } from "./http";

export async function fetchUrl(url: string, headers?: Record<string, string>) {
  const result = await httpFetchBytes({ url, headers });
  return { contentType: result.contentType ?? undefined, bodyText: result.bytes.toString("utf8"), bytes: result.bytes.length };
}
