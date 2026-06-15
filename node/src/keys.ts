// Copyright (c) 2026 Stefano Della Valle
// SPDX-License-Identifier: LicenseRef-Proprietary

import fs from 'node:fs';
import path from 'node:path';
import { decodeIotaPrivateKey } from '@iota/iota-sdk/cryptography';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';

export type NodeIdentity = {
  nodeId: string;
  secretKeyBech32: string;
  keypair: Ed25519Keypair;
  address: string;
  publicKeyBytes: Uint8Array;
};

function keypairFromSecretKey(secretKeyBech32: string, source: string): Ed25519Keypair {
  const parsed = decodeIotaPrivateKey(secretKeyBech32);
  if (parsed.schema !== 'ED25519') {
    throw new Error(`Unsupported key schema in ${source}: ${parsed.schema}`);
  }
  return Ed25519Keypair.fromSecretKey(parsed.secretKey);
}

function envPrivateKeyForNode(nodeId: string): string | undefined {
  const nodeScoped = process.env[`NODE_${nodeId}_PRIVATEKEY`]?.trim();
  if (nodeScoped) return nodeScoped;
  const currentNode = process.env.PRIVATEKEY?.trim();
  if (currentNode) return currentNode;
  return undefined;
}

function envPrivateKeyFileForNode(nodeId: string): string | undefined {
  const fileScoped = process.env[`NODE_${nodeId}_PRIVATEKEY_FILE`]?.trim();
  if (fileScoped && fs.existsSync(fileScoped)) {
    return fileScoped;
  }
  
  const file1 = process.env.NODE_1_PRIVATEKEY_FILE?.trim();
  if (file1 && fs.existsSync(file1)) {
    return file1;
  }
  return undefined;
}

function readPrivateKeyFromFile(nodeId: string): string | undefined {
  const filePath = envPrivateKeyFileForNode(nodeId);
  if (!filePath) return undefined;

  try {
    let content = fs.readFileSync(filePath, 'utf8').trim();

    if (content.startsWith('0x')) {
      content = content.slice(2);
    }

    console.log(`[keys] Private key loaded from Docker Secret file: ${filePath}`);
    return content;
  } catch (e) {
    console.error(`[keys] Failed to read private key file ${filePath}:`, e);
    return undefined;
  }
}

export function loadOrCreateNodeIdentity(nodeId: string): NodeIdentity {
  const dir = path.resolve(process.cwd(), 'keys');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, `oracle_node_${nodeId}.iotaprivkey`);

  let secretKeyBech32: string;
  let keypair: Ed25519Keypair;

  if (fs.existsSync(fp)) {

    secretKeyBech32 = fs.readFileSync(fp, 'utf8').trim();
    keypair = keypairFromSecretKey(secretKeyBech32, fp);
  } else if ((secretKeyBech32 = readPrivateKeyFromFile(nodeId) ?? '')) {

    keypair = keypairFromSecretKey(secretKeyBech32, `NODE_${nodeId}_PRIVATEKEY_FILE`);
  } else if ((secretKeyBech32 = envPrivateKeyForNode(nodeId) ?? '')) {

    keypair = keypairFromSecretKey(secretKeyBech32, `NODE_${nodeId}_PRIVATEKEY / PRIVATEKEY`);
  } else {

    keypair = new Ed25519Keypair();
    secretKeyBech32 = keypair.getSecretKey();
    fs.writeFileSync(fp, secretKeyBech32, 'utf8');
    console.log(`[keys] Generated new keypair and saved to ${fp}`);
  }

  const publicKeyBytes = keypair.getPublicKey().toRawBytes();
  const address = keypair.getPublicKey().toIotaAddress();

  return {
    nodeId,
    secretKeyBech32,
    keypair,
    address,
    publicKeyBytes,
  };
}
