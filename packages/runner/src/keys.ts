// Node signing key (ADR-0006): Ed25519, stored as a PKCS#8 PEM in
// `<home>/key.ed25519` with mode 0600. The public key is presented for
// enrollment as base64 of the raw 32 bytes, the form the service's seed and
// enrollment accept. The private key never leaves this module.
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { RunnerError } from './errors.js';

export interface NodeKey {
  privateKey: KeyObject;
  /** base64 of the raw 32-byte public key. */
  pubkey: string;
  /** `ed25519:<first 16 hex of sha256(raw public key)>`, the Run.submission.key_id. */
  key_id: string;
}

/** A fresh Ed25519 private key as PKCS#8 PEM text. */
export function generateKey(): string {
  const { privateKey } = generateKeyPairSync('ed25519');
  return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** The raw 32-byte public key derived from a private key object. */
export function rawPublicKey(privateKey: KeyObject): Buffer {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return Buffer.from(spki.subarray(spki.length - 32));
}

export function keyIdOf(rawPub: Buffer): string {
  return 'ed25519:' + createHash('sha256').update(rawPub).digest('hex').slice(0, 16);
}

export function nodeKeyFrom(privateKey: KeyObject): NodeKey {
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new RunnerError('config_invalid', 'signing key is not Ed25519');
  }
  const raw = rawPublicKey(privateKey);
  return { privateKey, pubkey: raw.toString('base64'), key_id: keyIdOf(raw) };
}

export function loadKey(file: string): NodeKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(file, 'utf8'));
  } catch {
    throw new RunnerError('not_initialized', `signing key at ${file} is missing or unreadable`);
  }
  return nodeKeyFrom(privateKey);
}

/** Base64 Ed25519 signature over the UTF-8 bytes of `payload`. */
export function signPayload(key: NodeKey, payload: string): string {
  return sign(null, Buffer.from(payload, 'utf8'), key.privateKey).toString('base64');
}
