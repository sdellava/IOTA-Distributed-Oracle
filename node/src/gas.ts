// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

// src/gas.ts
import type { IotaClient, IotaObjectResponse } from "@iota/iota-sdk/client";
import type { Transaction } from "@iota/iota-sdk/transactions";

function asBigInt(x: any): bigint {
  try {
    if (typeof x === "bigint") return x;
    if (typeof x === "number") return BigInt(x);
    if (typeof x === "string") return BigInt(x);
  } catch {
    /* ignore */
  }
  return 0n;
}

function getObjRef(resp: IotaObjectResponse): { objectId: string; version: string; digest: string } | null {
  const d: any = resp?.data;
  const objectId = String(d?.objectId ?? "").trim();
  const version = String(d?.version ?? "").trim();
  const digest = String(d?.digest ?? "").trim();
  if (!objectId || !version || !digest) return null;
  return { objectId, version, digest };
}

/**
 * Force a fresh gas payment objectRef into the tx.
 * This avoids "Object version ... is not available for consumption" when the SDK reuses a stale gas ref.
 */
export async function attachFreshGasPayment(opts: {
  client: IotaClient;
  tx: Transaction;
  owner: string;
}) {
  const { client, tx, owner } = opts;

  // Pick the largest coin (simple + robust for faucet-funded dev).
  const coins = await client.getCoins({ owner, limit: 50 } as any);
  const list: any[] = Array.isArray((coins as any)?.data) ? (coins as any).data : [];
  if (!list.length) return;

  list.sort((a, b) => {
    const ba = asBigInt(a?.balance);
    const bb = asBigInt(b?.balance);
    return bb > ba ? 1 : bb < ba ? -1 : 0;
  });

  // Preserve the SDK's multi-coin selection when one coin cannot cover the budget.
  const budget = asBigInt(opts.tx.getData().gasData.budget);
  if (asBigInt(list[0]?.balance) < budget) return;

  const coinId = String(list[0]?.coinObjectId ?? list[0]?.objectId ?? "").trim();
  if (!coinId) return;

  const obj = await client.getObject({ id: coinId, options: { showContent: false } } as any);
  const ref = getObjRef(obj);
  if (!ref) return;

  (tx as any).setGasPayment([ref]);
}
