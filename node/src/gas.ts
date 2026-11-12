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
  if (!list.length) throw new Error('NO_GAS_COINS_AVAILABLE');

  list.sort((a, b) => {
    const ba = asBigInt(a?.balance);
    const bb = asBigInt(b?.balance);
    return bb > ba ? 1 : bb < ba ? -1 : 0;
  });

  const budget = asBigInt(opts.tx.getData().gasData.budget);
  const usedInputs = new Set(tx.getData().inputs.map((input: any) =>
    input.Object?.ImmOrOwnedObject?.objectId ?? input.UnresolvedObject?.objectId));
  const refs: NonNullable<ReturnType<typeof getObjRef>>[] = [];
  let balance = 0n;
  for (const coin of list) {
    const coinId = String(coin.coinObjectId ?? coin.objectId ?? '').trim();
    if (!coinId || usedInputs.has(coinId)) continue;
    const obj = await client.getObject({ id: coinId, options: { showContent: true } });
    const ref = getObjRef(obj);
    const content: any = obj.data?.content;
    if (!ref || content?.fields?.balance == null) throw new Error('GAS_COIN_STATE_UNAVAILABLE');
    refs.push(ref);
    balance += asBigInt(content.fields.balance);
    if (balance >= budget) break;
  }
  if (balance < budget) throw new Error('INSUFFICIENT_FRESH_GAS_BALANCE');
  tx.setGasPayment(refs);
}
