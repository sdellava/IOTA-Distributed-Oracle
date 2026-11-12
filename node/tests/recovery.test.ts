import assert from 'node:assert/strict';
import test from 'node:test';
import { Transaction } from '@iota/iota-sdk/transactions';
import { pollEvents, eventPollHealth, eventListenersDegraded } from '../src/events';
import { signAndExecuteWithLockRetry } from '../src/txRetry';

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
  assert.equal(eventListenersDegraded(1200, 60_002), true);
  eventPollHealth.clear();
});

test('wallet transactions serialize and refresh gas from direct object reads', async () => {
  let active = 0, peak = 0, version = 10;
  const observed: string[] = [];
  const client = {
    getCoins: async () => ({ data: [{ coinObjectId: '0x1', balance: '100', version: '1' }] }),
    getObject: async () => ({ data: { objectId: '0x1', version: String(version), digest: 'fresh' } }),
    signAndExecuteTransaction: async ({ transaction }: any) => {
      active++; peak = Math.max(peak, active);
      observed.push(transaction.getData().gasData.payment[0].version);
      await new Promise(r => setTimeout(r, 5));
      version++; active--; return { digest: 'done' };
    },
  } as any;
  const signer = { getPublicKey: () => ({ toIotaAddress: () => 'wallet' }) };
  const run = () => signAndExecuteWithLockRetry({ client, signer, maxAttempts: 1,
    transactionFactory: () => { const tx = new Transaction(); tx.setGasBudget(50); return tx; } });
  await Promise.all([run(), run()]);
  assert.equal(peak, 1);
  assert.deepEqual(observed, ['10', '11']);
});
