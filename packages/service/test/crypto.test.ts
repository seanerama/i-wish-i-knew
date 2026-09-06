// Envelope encryption: a sealed body is unreadable without the KEK, a wrong
// KEK cannot unwrap the organization key, and the wrapped key at rest is not
// the data key.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createPool } from '../src/db.js';
import type { Pool } from '../src/db.js';
import { CryptoError, Envelope } from '../src/modules/crypto/index.js';
import { parseKek } from '../src/config.js';
import { DATABASE_URL, resetDatabase } from './helpers.js';

let pool: Pool;
const kekA = randomBytes(32);
const kekB = randomBytes(32);

before(async () => {
  await resetDatabase();
  pool = createPool(DATABASE_URL as string);
});

after(async () => {
  await pool.end();
});

test('seal/open round-trips under the same KEK; ciphertext hides the plaintext', async () => {
  const envelope = new Envelope(pool, kekA);
  const plaintext = Buffer.from(
    JSON.stringify({ run_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', secret: 'body' }),
  );
  const sealed = await envelope.seal('org-a', plaintext);
  assert.match(sealed.key_id, /^k1-[0-9a-f]{16}$/);
  assert.ok(!sealed.ciphertext.toString('latin1').includes('01ARZ3NDEKTSV4RRFFQ69G5FAV'));
  assert.ok(!sealed.ciphertext.toString('latin1').includes('body'));
  const opened = await envelope.open('org-a', sealed.key_id, sealed.ciphertext);
  assert.deepEqual(opened, plaintext);

  // A second process with the same KEK opens it too (key unwrapped from the table).
  const again = new Envelope(pool, Buffer.from(kekA));
  assert.deepEqual(await again.open('org-a', sealed.key_id, sealed.ciphertext), plaintext);

  // Same organization keeps one key; another organization gets a different one.
  const second = await envelope.seal('org-a', Buffer.from('x'));
  assert.equal(second.key_id, sealed.key_id);
  const otherOrg = await envelope.seal('org-b', Buffer.from('x'));
  assert.notEqual(otherOrg.key_id, sealed.key_id);
  const rows = await pool.query<{ org_ref: string; wrapped_key: Buffer }>(
    `SELECT org_ref, wrapped_key FROM identity.org_keys ORDER BY org_ref`,
  );
  assert.deepEqual(
    rows.rows.map((r) => r.org_ref),
    ['org-a', 'org-b'],
  );
  // wrapped key = version + iv + tag + 32 bytes: never the raw data key length
  for (const row of rows.rows) assert.equal(row.wrapped_key.length, 1 + 12 + 16 + 32);
});

test('a wrong KEK fails to open: it cannot unwrap the organization key', async () => {
  const good = new Envelope(pool, kekA);
  const sealed = await good.seal('org-c', Buffer.from('confidential'));
  const wrong = new Envelope(pool, kekB);
  await assert.rejects(() => wrong.open('org-c', sealed.key_id, sealed.ciphertext), CryptoError);
  await assert.rejects(() => wrong.dataKey('org-c'), CryptoError);
  // tampered ciphertext fails authentication under the right KEK
  const tampered = Buffer.from(sealed.ciphertext);
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] as number) ^ 0x01;
  await assert.rejects(() => good.open('org-c', sealed.key_id, tampered), CryptoError);
  // wrong org_ref (AAD) fails too
  await assert.rejects(() => good.open('org-d', sealed.key_id, sealed.ciphertext), CryptoError);
});

test('IWIK_KEK parsing: hex and base64 are raw; passphrases derive outside production only', () => {
  const hex = kekA.toString('hex');
  assert.deepEqual(parseKek(hex, true), { kek: kekA, source: 'raw' });
  assert.deepEqual(parseKek(kekA.toString('base64'), true), { kek: kekA, source: 'raw' });
  const derived = parseKek('ci-only-not-a-secret-0000000000000000', false);
  assert.equal(derived.source, 'derived');
  assert.equal(derived.kek.length, 32);
  assert.deepEqual(parseKek('ci-only-not-a-secret-0000000000000000', false).kek, derived.kek);
  assert.throws(() => parseKek('ci-only-not-a-secret-0000000000000000', true), /32 bytes/);
  assert.throws(() => parseKek('', false), /required/);
  assert.throws(() => new Envelope(pool, Buffer.alloc(16)), CryptoError);
});
