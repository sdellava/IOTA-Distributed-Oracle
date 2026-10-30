import fs from 'node:fs';
import path from 'node:path';
import { decodeIotaPrivateKey } from '@iota/iota-sdk/cryptography';
import { Ed25519Keypair } from '@iota/iota-sdk/keypairs/ed25519';

export type ClientIdentity = {
  secretKeyBech32: string;
  keypair: Ed25519Keypair;
  address: string;
  publicKeyBytes: Uint8Array;
};

export function loadOrCreateClientIdentity(): ClientIdentity {
  if (process.env.ORACLE_PREPARE_ONLY === "1") throw new Error("Signing is disabled in Webview preparation mode.");
  const fp = (process.env.CLIENT_KEY_FILE?.trim() || './keys/oracle_client.iotaprivkey');
  const abs = path.resolve(process.cwd(), fp);
  fs.mkdirSync(path.dirname(abs), { recursive: true });

  let secretKeyBech32: string;
  let keypair: Ed25519Keypair;

  if (fs.existsSync(abs)) {
    secretKeyBech32 = fs.readFileSync(abs, 'utf8').trim();
    const parsed = decodeIotaPrivateKey(secretKeyBech32);
    if (parsed.schema !== 'ED25519') {
      throw new Error(`Unsupported key schema in ${abs}: ${parsed.schema}`);
    }
    keypair = Ed25519Keypair.fromSecretKey(parsed.secretKey);
  } else {
    keypair = new Ed25519Keypair();
    secretKeyBech32 = keypair.getSecretKey();
    fs.writeFileSync(abs, secretKeyBech32, 'utf8');
  }

  const publicKeyBytes = keypair.getPublicKey().toRawBytes();
  const address = keypair.getPublicKey().toIotaAddress();

  return { secretKeyBech32, keypair, address, publicKeyBytes };
}
