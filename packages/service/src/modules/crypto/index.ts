// Per-organization envelope encryption (ADR-0002 control 2).
//
// Each organization gets a random 256-bit data key on first use. The data
// key is stored in identity.org_keys wrapped with the service KEK
// (AES-256-GCM, AAD = org_ref); plaintext keys exist only in this process.
// Evidence bodies are sealed with the data key (AES-256-GCM, AAD =
// org_ref + key_id). Moving to confidential compute later changes who can
// unwrap, not the stored bytes.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Pool, Queryable } from '../../db.js';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class CryptoError extends Error {
  override name = 'CryptoError';
}

export interface Sealed {
  key_id: string;
  ciphertext: Buffer;
}

function encrypt(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

function decrypt(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < 1 + IV_BYTES + TAG_BYTES || blob[0] !== VERSION) {
    throw new CryptoError('unrecognized ciphertext envelope');
  }
  const iv = blob.subarray(1, 1 + IV_BYTES);
  const tag = blob.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = blob.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new CryptoError('decryption failed (wrong key or corrupted ciphertext)');
  }
}

interface DataKey {
  key_id: string;
  key: Buffer;
}

export class Envelope {
  private readonly cache = new Map<string, DataKey>();

  constructor(
    private readonly pool: Pool,
    private readonly kek: Buffer,
  ) {
    if (kek.length !== KEY_BYTES) throw new CryptoError('KEK must be 32 bytes');
  }

  private wrap(orgRef: string, key: Buffer): Buffer {
    return encrypt(this.kek, key, Buffer.from(orgRef, 'utf8'));
  }

  private unwrap(orgRef: string, wrapped: Buffer): Buffer {
    const key = decrypt(this.kek, wrapped, Buffer.from(orgRef, 'utf8'));
    if (key.length !== KEY_BYTES) throw new CryptoError('unwrapped key has the wrong length');
    return key;
  }

  private async load(db: Queryable, orgRef: string): Promise<DataKey | undefined> {
    const res = await db.query<{ key_id: string; wrapped_key: Buffer }>(
      `SELECT key_id, wrapped_key FROM identity.org_keys WHERE org_ref = $1`,
      [orgRef],
    );
    const row = res.rows[0];
    if (row === undefined) return undefined;
    return { key_id: row.key_id, key: this.unwrap(orgRef, row.wrapped_key) };
  }

  /** The organization's data key, created and stored wrapped on first use. */
  async dataKey(orgRef: string): Promise<DataKey> {
    const cached = this.cache.get(orgRef);
    if (cached !== undefined) return cached;
    let found = await this.load(this.pool, orgRef);
    if (found === undefined) {
      const fresh = randomBytes(KEY_BYTES);
      const keyId = 'k1-' + randomBytes(8).toString('hex');
      await this.pool.query(
        `INSERT INTO identity.org_keys (org_ref, key_id, wrapped_key) VALUES ($1, $2, $3)
         ON CONFLICT (org_ref) DO NOTHING`,
        [orgRef, keyId, this.wrap(orgRef, fresh)],
      );
      // Re-read: a concurrent first use may have won the insert.
      found = await this.load(this.pool, orgRef);
      if (found === undefined) throw new CryptoError('data key not persisted');
    }
    this.cache.set(orgRef, found);
    return found;
  }

  async seal(orgRef: string, plaintext: Buffer): Promise<Sealed> {
    const dk = await this.dataKey(orgRef);
    return {
      key_id: dk.key_id,
      ciphertext: encrypt(dk.key, plaintext, Buffer.from(`${orgRef}|${dk.key_id}`, 'utf8')),
    };
  }

  async open(orgRef: string, keyId: string, ciphertext: Buffer): Promise<Buffer> {
    const dk = await this.dataKey(orgRef);
    if (dk.key_id !== keyId) throw new CryptoError('key_id does not match the organization key');
    return decrypt(dk.key, ciphertext, Buffer.from(`${orgRef}|${keyId}`, 'utf8'));
  }
}
