import type { IotaClient } from '@iota/iota-sdk/client';
import { normalizeIotaObjectId } from '@iota/iota-sdk/utils';

export const PIN_RPC = Symbol('pin-rpc');
export const RECORD_EFFECTS = Symbol('record-effects');
export const ROTATE_RPC = Symbol('rotate-rpc');

export function pinRpc(client: IotaClient): IotaClient {
  return (client as any)[PIN_RPC]?.() ?? client;
}

export function coherentClient(client: IotaClient, floors = new Map<string, bigint>()): IotaClient {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === RECORD_EFFECTS) return (effects: any) => {
        for (const entry of [...(effects?.mutated ?? []), ...(effects?.created ?? [])]) {
          const ref = entry.reference;
          if (ref?.objectId && ref.version != null) {
            const next = BigInt(ref.version);
            const id = normalizeIotaObjectId(ref.objectId);
            if (next > (floors.get(id) ?? 0n)) floors.set(id, next);
          }
        }
      };
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      if (prop !== 'getObject' && prop !== 'multiGetObjects') return value.bind(target);
      return async (...args: any[]) => {
        for (let attempt = 0; attempt < 8; attempt++) {
          const result = await value.apply(target, args);
          const items = prop === 'getObject' ? [result] : result;
          const ids = prop === 'getObject' ? [args[0].id] : args[0].ids;
          const valid = ids.every((id: string, i: number) => {
            const floor = floors.get(normalizeIotaObjectId(id));
            return floor == null || (items[i]?.data?.version != null && BigInt(items[i].data.version) >= floor);
          });
          if (valid) {
            for (const item of items) {
              if (item?.data?.objectId && item.data.version != null) {
                const id = normalizeIotaObjectId(item.data.objectId);
                const version = BigInt(item.data.version);
                if (version > (floors.get(id) ?? 0n)) floors.set(id, version);
              }
            }
            return result;
          }
          if (attempt < 7) await new Promise(r => setTimeout(r, 250));
        }
        throw new Error('RPC_STATE_BEHIND_CONFIRMED_TRANSACTION');
      };
    },
  });
}
