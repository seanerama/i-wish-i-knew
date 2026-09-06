// Console password hashing with node:crypto scrypt (no native dependency;
// the stage spec names bcrypt, scrypt is the boring built-in equivalent).
// Stored form: scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>. Verification is
// constant time over the derived key and always does the work, so a missing
// login costs the same as a wrong password.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 256;

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Buffer {
  return scryptSync(Buffer.from(password.normalize('NFKC'), 'utf8'), salt, KEY_BYTES, {
    N: n,
    r,
    p,
    maxmem: 128 * n * r * 2,
  });
}

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const key = derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/** A hash of a random password, used to equalize timing when no login row exists. */
export const DUMMY_HASH = hashPassword(randomBytes(24).toString('base64url'));

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![n, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
  const salt = Buffer.from(parts[4] as string, 'base64');
  const expected = Buffer.from(parts[5] as string, 'base64');
  if (expected.length !== KEY_BYTES) return false;
  const actual = derive(password, salt, n, r, p);
  return timingSafeEqual(actual, expected);
}
