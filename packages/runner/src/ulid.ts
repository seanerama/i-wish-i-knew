// ULID (26 chars of Crockford base32: 48-bit ms timestamp + 80 random bits).
// Identifiers in the envelope are ULIDs (contracts/evidence-envelope.md).
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now: number = Date.now()): string {
  let time = now;
  const chars: string[] = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    chars[i] = ALPHABET[time % 32] as string;
    time = Math.floor(time / 32);
  }
  const random = randomBytes(16);
  let out = chars.join('');
  for (let i = 0; i < 16; i++) {
    out += ALPHABET[(random[i] as number) % 32];
  }
  return out;
}

export const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
