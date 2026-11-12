import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from '@iota/iota-sdk/transactions';
import { pollEvents, eventPollHealth, eventListenersDegraded, eventListenerDiagnostics } from '../src/events';
import { signAndExecuteWithLockRetry } from '../src/txRetry';

const storage = mkdtempSync(join(tmpdir(), 'oracle-recovery-'));
const previousStorage = process.env.STORAGE_DIR;
process.env.STORAGE_DIR = storage;
after(() => {
  if (previousStorage == null) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = previousStorage;
  rmSync(storage, { recursive: true, force: true });
});

test('lost cursor rescans retained events without repeating delivered events', async () => {
  const stop = new AbortController();
  const calls: any[] = [], delivered: string[] = [];
  const event = (n: number) => ({ id: { txDigest: `tx${n}`, eventSeq: '0' }, timestampMs: n });
  const client = { queryEvents: async (args: any) => {
    calls.push(args.cursor);
    if (calls.length === 1) return { data: [event(1)], hasNextPage: true, nextCursor: event(1).id };
    if (calls.length === 2) throw new Error('Could not find the referenced transaction [tx1]');
    stop.abort();
    return { data: [event(1), event(2)], hasNextPage: false, nextCursor: event(2).id };
  } } as any;
  await pollEvents({ client, moveEventType: 'recovery', pollMs: 1, signal: stop.signal,
    onEvent: e => { delivered.push(e.id.txDigest); } });
  assert.deepEqual(calls, [null, event(1).id, null]);
  assert.deepEqual(delivered, ['tx1', 'tx2']);
  eventPollHealth.clear();
});

test('listener health detects failures and stalled RPC calls, including before first success', () => {
  eventPollHealth.set('x', { startedMs: 1, lastSuccessMs: null, failing: false });
  assert.equal(eventListenersDegraded(1200, 60_002), true);
  eventPollHealth.set('x', { startedMs: 1, lastSuccessMs: 60_001, failing: false });
  assert.equal(eventListenersDegraded(1200, 60_002), false);
  eventPollHealth.get('x')!.failing = true;
  eventPollHealth.get('x')!.failureSinceMs = 45_002;
  assert.equal(eventListenersDegraded(1200, 60_002), true);
  eventPollHealth.clear();
});

test('failures are exposed immediately and recovery rescans cannot hide a persistent failure', () => {
  eventPollHealth.set('0xpackage::oracle_tasks::TaskRunSubmitted', {
    startedMs: 100, lastSuccessMs: 1000, failing: true, failureSinceMs: 1000, consecutiveFailures: 1,
  });
  try {
    assert.equal(eventListenersDegraded(1200, 1000), true);
    assert.equal(eventListenersDegraded(1200, 16_000), true);
    const h = eventPollHealth.values().next().value!;
    h.lastSuccessMs = 16_000;
    h.recovering = true;
    assert.equal(eventListenersDegraded(1200, 16_001), true);
    assert.deepEqual(eventListenerDiagnostics(1200, 16_001)[0], {
      listener: 'oracle_tasks::TaskRunSubmitted', status: 'recovering', degraded: true,
      lastSuccessMs: 16_000, lastSuccessAgeMs: 1, failureDurationMs: 15_001, consecutiveFailures: 1, historyGap: false,
    });
    h.failing = false; h.recovering = false; h.failureSinceMs = null;
    assert.equal(eventListenersDegraded(1200, 16_002), false);
  } finally { eventPollHealth.clear(); }
});

test('wallet transactions serialize and refresh gas from direct object reads', async () => {
  let active = 0, peak = 0, version = 10;
  const observed: string[] = [];
  const client = {
    getCoins: async () => ({ data: [{ coinObjectId: '0x1', balance: '100', version: '1' }] }),
    getObject: async () => ({ data: { objectId: '0x1', version: String(version), digest: '11111111111111111111111111111111', content: { fields: { balance: '100' } } } }),
    executeTransactionBlock: async ({ transactionBlock }: any) => {
      active++; peak = Math.max(peak, active);
      observed.push(Transaction.from(transactionBlock).getData().gasData.payment![0].version);
      await new Promise(r => setTimeout(r, 5));
      version++; active--; return { digest: 'done', checkpoint: '1', effects: { status: { status: 'success' } } };
    },
  } as any;
  const signer = { getPublicKey: () => ({ toIotaAddress: () => '0x1' }), signTransaction: async (bytes: Uint8Array) => ({ bytes, signature: 'test' }) };
  const run = () => signAndExecuteWithLockRetry({ client, signer, maxAttempts: 1,
    transactionFactory: () => { const tx = new Transaction(); tx.setGasBudget(50); tx.setGasPrice(1); return tx; } });
  await Promise.all([run(), run()]);
  assert.equal(peak, 1);
  assert.deepEqual(observed, ['10', '11']);
});
