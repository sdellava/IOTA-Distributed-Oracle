// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import 'dotenv/config';
import { IotaClient } from '@iota/iota-sdk/client';
import { envByNetwork } from './config/env';
import { coherentClient, PIN_RPC, ROTATE_RPC } from './rpcConsistency';

const NON_RETRYABLE_METHODS = new Set<string>([
  'executeTransactionBlock',
  'signAndExecuteTransaction',
  'signAndExecuteTransactionBlock',
  'publish',
  'upgrade',
]);

function parseRpcUrls(raw?: string): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[\n,;\s]+/g)
    .map((p) => p.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

function shouldRetryMethod(methodName: PropertyKey): boolean {
  if (typeof methodName !== 'string') return false;
  if (NON_RETRYABLE_METHODS.has(methodName)) return false;
  return methodName.startsWith('get') || methodName.startsWith('query') || methodName.startsWith('wait');
}

function shouldFailover(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error ?? '').toLowerCase();

  return (
    message.includes('fetch failed') ||
    message.includes('failed to fetch') ||
    message.includes('network') ||
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('econnreset') ||
    message.includes('econnrefused') ||
    message.includes('socket hang up') ||
    message.includes('503') ||
    message.includes('502') ||
    message.includes('504')
    || message.includes('rpc_state_behind_confirmed_transaction')
  );
}

function makeFailoverClient(urls: string[]): IotaClient {
  const floors = new Map<string, bigint>();
  let currentIndex = 0;
  let activeClient = coherentClient(new IotaClient({ url: urls[currentIndex] }), floors);

  const switchEndpoint = () => {
    const from = urls[currentIndex];
    currentIndex = (currentIndex + 1) % urls.length;
    const to = urls[currentIndex];
    activeClient = coherentClient(new IotaClient({ url: to }), floors);
    console.warn(`[iota] RPC failover: ${from} -> ${to}`);
  };

  return new Proxy({} as IotaClient, {
    get(_target, prop, _receiver) {
      if (prop === PIN_RPC) return () => activeClient;
      if (prop === ROTATE_RPC) return () => { if (urls.length > 1) switchEndpoint(); return activeClient; };
      const value = Reflect.get(activeClient as object, prop);
      if (typeof value !== 'function') return value;

      return (...args: unknown[]) => {
        if (!shouldRetryMethod(prop) || urls.length <= 1) {
          const direct = Reflect.get(activeClient as object, prop);
          return (direct as (...params: unknown[]) => unknown).apply(activeClient, args);
        }

        const runWithFailover = async () => {
          let lastError: unknown;
          for (let attempt = 0; attempt < urls.length; attempt += 1) {
            try {
              const fn = Reflect.get(activeClient as object, prop) as (...params: unknown[]) => unknown;
              return await Promise.resolve(fn.apply(activeClient, args));
            } catch (err) {
              lastError = err;
              const canRetry = attempt < urls.length - 1 && shouldFailover(err);
              if (!canRetry) throw err;
              switchEndpoint();
            }
          }
          throw lastError;
        };

        return runWithFailover();
      };
    },
  });
}

export function iotaClient(): IotaClient {
  const urls = [...new Set([
    ...parseRpcUrls(envByNetwork('IOTA_RPC_URLS')),
    ...parseRpcUrls(envByNetwork('IOTA_RPC_URL')),
  ])];

  if (urls.length === 0) throw new Error('Missing env IOTA_RPC_URL or IOTA_RPC_URLS');
  return makeFailoverClient(urls);
}
