// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { IotaClient } from '@iota/iota-sdk/client';
import type { Transaction } from '@iota/iota-sdk/transactions';
import { attachFreshGasPayment } from './gas.js';

function envInt(name: string, def: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.floor(n);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(): number {
  const minMs = envInt('TX_LOCK_RETRY_MIN_MS', 1_000);
  const maxMs = envInt('TX_LOCK_RETRY_MAX_MS', 3_000);
  const lo = Math.max(0, Math.min(minMs, maxMs));
  const hi = Math.max(lo, Math.max(minMs, maxMs));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function isLockConflictError(error: unknown): boolean {
  const msg = String((error as any)?.message ?? error ?? '').toLowerCase();
  if (!msg) return false;

  return [
    'reserved for another transaction',
    'objects is reserved for another transaction',
    'one or more of its objects is reserved',
    'failed to sign transaction by a quorum of validators because one or more of its objects is reserved',
    'object is reserved for another transaction',
    'shared object is reserved',
    'object lock',
    'objects lock',
    'object locked',
    'objects locked',
    'input object',
    'equivocated until the next epoch',
    'is not available for consumption, current version',
    'transaction execution failed due to issues with transaction inputs',
    'current version:',
  ].some((needle) => msg.includes(needle));
}

async function executeWithLockRetry(opts: {
  client: IotaClient;
  signer: any;
  transactionFactory?: () => Transaction;
  transaction?: any;
  options?: Record<string, any>;
  label?: string;
  maxAttempts?: number;
}): Promise<any> {
  const { client, signer, transactionFactory, transaction, options, label } = opts;
  const maxAttempts =
    opts.maxAttempts == null ? envInt('TX_LOCK_RETRY_MAX_ATTEMPTS', 0) : Math.max(1, Math.floor(opts.maxAttempts));

  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const tx = transactionFactory ? transactionFactory() : transaction;
      if (transactionFactory) {
        await attachFreshGasPayment({ client, tx, owner: signer.getPublicKey().toIotaAddress() });
      }
      return (await client.signAndExecuteTransaction({
        signer,
        transaction: tx,
        options,
      } as any)) as any;
    } catch (error) {
      if (!isLockConflictError(error)) throw error;
      if (maxAttempts > 0 && attempt >= maxAttempts) throw error;

      const waitMs = randomDelayMs();
      const prefix = label ? `[tx-retry:${label}]` : '[tx-retry]';
      console.warn(`${prefix} retryable shared-object/version conflict, retry ${attempt} in ${waitMs} ms: ${String((error as any)?.message ?? error)}`);
      await sleep(waitMs);
    }
  }
}

// All callers in this process sharing a gas owner must finish before the next build.
const walletQueues = new Map<string, Promise<unknown>>();
export async function signAndExecuteWithLockRetry(opts: Parameters<typeof executeWithLockRetry>[0]): Promise<any> {
  const owner = opts.signer.getPublicKey().toIotaAddress();
  const previous = walletQueues.get(owner) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(() => executeWithLockRetry(opts));
  walletQueues.set(owner, pending);
  try { return await pending; }
  finally { if (walletQueues.get(owner) === pending) walletQueues.delete(owner); }
}
