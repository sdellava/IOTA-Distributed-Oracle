import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function journalPath(kind: string, identity: string): string {
  const scope = [process.env.IOTA_NETWORK, process.env.NODE_ID, process.env.ORACLE_TASKS_PACKAGE_ID,
    process.env.TESTNET_ORACLE_TASKS_PACKAGE_ID, process.env.MAINNET_ORACLE_TASKS_PACKAGE_ID, identity].join('|');
  return join(process.env.STORAGE_DIR || 'storage', 'daemon-state', `${kind}-${createHash('sha256').update(scope).digest('hex')}.json`);
}

export function readJournal<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw new Error('DAEMON_JOURNAL_UNREADABLE'); }
}

export function writeJournal(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flush: true });
  renameSync(temporary, path);
}

export function receiptPath(checkpointPath: string, eventKey: string): string {
  return join(`${checkpointPath}.receipts`, `${createHash('sha256').update(eventKey).digest('hex')}.json`);
}
