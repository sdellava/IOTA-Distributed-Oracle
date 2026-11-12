// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import type { IotaClient } from '@iota/iota-sdk/client';
import type { Transaction } from '@iota/iota-sdk/transactions';
import { attachFreshGasPayment } from './gas.js';
import { pinRpc, RECORD_EFFECTS, ROTATE_RPC } from './rpcConsistency';
import { journalPath, readJournal, writeJournal } from './daemonJournal';
import { createHash } from 'node:crypto';

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
  const { signer, transactionFactory, transaction, options, label } = opts;
  const client = pinRpc(opts.client);
  const path = journalPath('transaction', signer.getPublicKey().toIotaAddress());
  // An unknown previous submission blocks all new wallet writes until its effects are known.
  const intentData = transactionFactory ? transactionFactory().getData() : transaction?.getData();
  const intent = createHash('sha256').update(JSON.stringify(intentData)).digest('hex');
  const pending = readJournal<{ digest?: string; label?: string; intent?: string; effects?: any }>(path);
  if (pending?.effects) (client as any)[RECORD_EFFECTS]?.(pending.effects);
  if (pending?.digest) {
    let resolved: any;
    try { resolved = await client.getTransactionBlock({ digest: pending.digest, options: { ...options, showEffects: true } }); }
    catch { throw new Error(`TRANSACTION_OUTCOME_UNKNOWN digest=${pending.digest}`); }
    if (!resolved.effects?.status) throw new Error(`TRANSACTION_OUTCOME_UNKNOWN digest=${pending.digest}`);
    (client as any)[RECORD_EFFECTS]?.(resolved.effects);
    if (resolved.effects.status.status === 'success' && !resolved.checkpoint) {
      resolved = await client.waitForTransaction({ digest: pending.digest, options: { ...options, showEffects: true }, timeout: 15_000, pollInterval: 500 });
    }
    writeJournal(path, { effects: resolved.effects });
    // Return a recovered result only to the same workflow. A different caller must retry its own work.
    if (resolved.effects.status.status !== 'success') throw new Error('PREVIOUS_TRANSACTION_FAILED_ON_CHAIN');
    if (pending.label === label && pending.intent === intent) return resolved;
    throw new Error('PREVIOUS_TRANSACTION_RESOLVED_RETRY_CURRENT_OPERATION');
  }
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
      tx.setSenderIfNotSet(signer.getPublicKey().toIotaAddress());
      const bytes = await tx.build({ client });
      const digest = await tx.getDigest({ client });
      const signed = await signer.signTransaction(bytes);
      writeJournal(path, { digest, label, intent, effects: pending?.effects });
      let result = await client.executeTransactionBlock({
        transactionBlock: signed.bytes,
        signature: signed.signature,
        options: { ...options, showEffects: true },
      } as any);
      if (!result.effects?.status) throw new Error(`TRANSACTION_OUTCOME_UNKNOWN digest=${digest}`);
      (client as any)[RECORD_EFFECTS]?.(result.effects);
      if (result.effects.status.status !== 'success') {
        writeJournal(path, { effects: result.effects });
        throw new Error(`TRANSACTION_FAILED_ON_CHAIN: ${result.effects.status.error ?? 'unknown'}`);
      }
      if (!result.checkpoint) result = await client.waitForTransaction({ digest, options: { ...options, showEffects: true }, timeout: 15_000, pollInterval: 500 });
      writeJournal(path, { effects: result.effects });
      return result;
    } catch (error) {
      // Only explicit pre-execution version/lock rejection permits rebuilding.
      if (String((error as any)?.message ?? error).startsWith('TRANSACTION_FAILED_ON_CHAIN')) throw error;
      const rejected = /is not available for consumption, current version|reserved for another transaction/i.test(String((error as any)?.message ?? error));
      if (!rejected) throw error;
      writeJournal(path, { effects: pending?.effects });
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
  catch (error) {
    if (/RPC_STATE_BEHIND|TRANSACTION_OUTCOME_UNKNOWN|timeout|fetch failed|502|503|504/i.test(String((error as any)?.message ?? error))) {
      (opts.client as any)[ROTATE_RPC]?.();
    }
    throw error;
  }
  finally { if (walletQueues.get(owner) === pending) walletQueues.delete(owner); }
}
