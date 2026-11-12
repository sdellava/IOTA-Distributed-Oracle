import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transaction } from '@iota/iota-sdk/transactions';
import { coherentClient, RECORD_EFFECTS, PIN_RPC, ROTATE_RPC } from '../src/rpcConsistency';
import { signAndExecuteWithLockRetry } from '../src/txRetry';
import { pollEvents, eventPollHealth, eventListenerDiagnostics } from '../src/events';
import { readJournal } from '../src/daemonJournal';

const storage = mkdtempSync(join(tmpdir(), 'oracle-consistency-'));
const before = process.env.STORAGE_DIR;
process.env.STORAGE_DIR = storage;
after(() => {
  if (before == null) delete process.env.STORAGE_DIR; else process.env.STORAGE_DIR = before;
  rmSync(storage, { recursive: true, force: true });
});

test('post-transaction object reads reject stale versions until the confirmed version is visible', async () => {
  let reads = 0;
  const client = coherentClient({ getObject: async () => ({ data: { objectId: '0x1', version: ++reads === 1 ? '9' : '10' } }) } as any);
  (client as any)[RECORD_EFFECTS]({ mutated: [{ reference: { objectId: '0x1', version: '10' } }] });
  assert.equal((await client.getObject({ id: '0x1' })).data!.version, '10');
  assert.equal(reads, 2);
});

test('a permanently stale backend fails closed instead of returning its queue snapshot', async () => {
  const client = coherentClient({ getObject: async () => ({ data: { objectId: '0x1', version: '9' } }) } as any);
  (client as any)[RECORD_EFFECTS]({ mutated: [{ reference: { objectId: '0x1', version: '10' } }] });
  await assert.rejects(client.getObject({ id: '0x1' }), /RPC_STATE_BEHIND_CONFIRMED_TRANSACTION/);
});

function txFixture(address: string) {
  let sends = 0, found: any = null, indexed = 0;
  const effects = { status: { status: 'success' } };
  const signer = { getPublicKey: () => ({ toIotaAddress: () => address }),
    signTransaction: async (bytes: Uint8Array) => ({ bytes, signature: 'test' }) };
  const pinned: any = {
    getCoins: async () => ({ data: [{ coinObjectId: address, balance: '100' }] }),
    getObject: async () => ({ data: { objectId: address, version: '1', digest: '11111111111111111111111111111111', content: { fields: { balance: '100' } } } }),
    executeTransactionBlock: async () => { sends++; throw new Error('response timeout after submit'); },
    getTransactionBlock: async () => { if (!found) throw new Error('not indexed'); return found; },
    waitForTransaction: async () => { indexed++; return { digest: 'confirmed', checkpoint: '1', effects }; },
  };
  const client = new Proxy({} as any, { get: (_, key) => key === PIN_RPC || key === ROTATE_RPC ? () => pinned : () => { throw new Error('unpinned RPC used'); } });
  const factory = () => { const tx = new Transaction(); tx.setGasBudget(50); tx.setGasPrice(1); return tx; };
  const run = () => signAndExecuteWithLockRetry({ client, signer, transactionFactory: factory, label: 'test', maxAttempts: 1 });
  return { run, pinned, signer, factory, sends: () => sends, indexed: () => indexed,
    resolve: () => { found = { digest: 'confirmed', effects }; } };
}

test('uncertain submissions survive new calls, pin the endpoint and recover without duplicate submission', async () => {
  const f = txFixture('0x2');
  await assert.rejects(f.run(), /response timeout/);
  await assert.rejects(f.run(), /TRANSACTION_OUTCOME_UNKNOWN/);
  assert.equal(f.sends(), 1);
  f.resolve();
  const recovered = await f.run();
  assert.equal(recovered.checkpoint, '1');
  assert.equal(f.indexed(), 1);
  assert.equal(f.sends(), 1);
});

test('confirmed Move failures are never logged as successful execution', async () => {
  const f = txFixture('0x3');
  f.pinned.executeTransactionBlock = async () => ({ digest: 'failed', effects: { status: { status: 'failure', error: 'MoveAbort' } } });
  await assert.rejects(signAndExecuteWithLockRetry({ client: f.pinned, signer: f.signer, transactionFactory: f.factory, maxAttempts: 1 }), /TRANSACTION_FAILED_ON_CHAIN/);
});

test('persistent listener cursor resumes after restart and does not replace its original replay boundary', async () => {
  const path = join(storage, 'restart.json');
  const first = { id: { txDigest: 'first', eventSeq: '0' }, timestampMs: 100 };
  const second = { id: { txDigest: 'second', eventSeq: '0' }, timestampMs: 200 };
  const delivered: string[] = [];
  const stop1 = new AbortController();
  await pollEvents({ client: { queryEvents: async () => { stop1.abort(); return { data: [first], nextCursor: first.id }; } } as any,
    moveEventType: 'restart', pollMs: 1, minTimestampMs: 50, checkpointPath: path, signal: stop1.signal, onEvent: e => { delivered.push(e.id.txDigest); } });
  const stop2 = new AbortController();
  await pollEvents({ client: { queryEvents: async (args: any) => {
    assert.deepEqual(args.cursor, first.id); stop2.abort(); return { data: [first, second], nextCursor: second.id };
  } } as any, moveEventType: 'restart', pollMs: 1, minTimestampMs: 300, checkpointPath: path, signal: stop2.signal,
    onEvent: e => { delivered.push(e.id.txDigest); } });
  assert.deepEqual(delivered, ['first', 'second']);
  assert.equal(readJournal<any>(path).since, 50);
  eventPollHealth.clear();
});

test('handler failures do not advance the persistent cursor past the failed event', async () => {
  const stop = new AbortController(); let attempts = 0;
  const path = join(storage, 'handler.json');
  const event = { id: { txDigest: 'retry', eventSeq: '0' }, timestampMs: 100 };
  await pollEvents({ client: { queryEvents: async () => ({ data: [event], nextCursor: event.id }) } as any,
    moveEventType: 'handler', pollMs: 1, checkpointPath: path, signal: stop.signal,
    onEvent: () => { if (++attempts === 1) throw new Error('handler unavailable'); stop.abort(); } });
  assert.equal(attempts, 2);
  assert.deepEqual(readJournal<any>(path).cursor, event.id);
  eventPollHealth.clear();
});

test('a recovery scan processes late-indexed older events and deduplicates durable receipts', async () => {
  const path = join(storage, 'late.json'); const firstStop = new AbortController();
  const first = { id: { txDigest: 'newer', eventSeq: '0' }, timestampMs: 200 };
  const late = { id: { txDigest: 'late', eventSeq: '0' }, timestampMs: 100 };
  const delivered: string[] = [];
  await pollEvents({ client: { queryEvents: async () => { firstStop.abort(); return { data: [first], nextCursor: first.id }; } } as any,
    moveEventType: 'late', pollMs: 1, checkpointPath: path, signal: firstStop.signal, onEvent: e => { delivered.push(e.id.txDigest); } });
  let reads = 0; const stop = new AbortController();
  await pollEvents({ client: { queryEvents: async () => {
    if (++reads === 1) throw new Error('Could not find the referenced transaction');
    stop.abort(); return { data: [late, first], nextCursor: first.id };
  } } as any, moveEventType: 'late', pollMs: 1, checkpointPath: path, signal: stop.signal,
    onEvent: e => { delivered.push(e.id.txDigest); } });
  assert.deepEqual(delivered, ['newer', 'late']);
  eventPollHealth.clear();
});

test('explicitly pruned history remains degraded across restart even after successful polling', async () => {
  const path = join(storage, 'gap.json'); const stop = new AbortController();
  await pollEvents({ client: { queryEvents: async () => { stop.abort(); throw new Error('DATA_PRUNED'); } } as any,
    moveEventType: 'gap', pollMs: 1, checkpointPath: path, signal: stop.signal, onEvent: () => {} });
  const again = new AbortController();
  await pollEvents({ client: { queryEvents: async () => { again.abort(); return { data: [] }; } } as any,
    moveEventType: 'gap', pollMs: 1, checkpointPath: path, signal: again.signal, onEvent: () => {} });
  assert.equal(eventListenerDiagnostics(1200)[0].historyGap, true);
  assert.equal(eventListenerDiagnostics(1200)[0].degraded, true);
  eventPollHealth.clear();
});
