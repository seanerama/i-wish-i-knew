// JSON Canonicalization Scheme, RFC 8785. Used for every digest and signature
// over envelope documents (contracts/evidence-envelope.md: "Canonicalization
// for signing is JCS").
//
// RFC 8785 defines primitive serialization as exactly ECMAScript's
// `JSON.stringify` (§3.2.2), so this implementation delegates strings,
// numbers, and literals to it and adds the one thing it lacks: recursive
// property sorting by UTF-16 code units (§3.2.3), which is what the default
// `Array.prototype.sort` comparison does for strings.
import { createHash } from 'node:crypto';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/**
 * Return the RFC 8785 canonical serialization of a JSON value.
 *
 * Accepts any value `JSON.stringify` accepts (objects with `toJSON`,
 * `undefined` properties, and so on are normalized exactly as it does).
 * Throws on values that have no JSON form: `undefined`, functions, symbols,
 * BigInt, and non-finite numbers (I-JSON, RFC 7493, forbids NaN/Infinity).
 */
export function canonicalize(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new TypeError('canonicalize: value has no JSON representation');
  }
  assertFinite(value);
  return serialize(JSON.parse(text) as Json);
}

/** `sha256:<hex>` over the canonical form (UTF-8), the envelope's digest format. */
export function digest(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

function serialize(value: Json): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(serialize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const item = value[key];
    if (item === undefined) continue;
    parts.push(JSON.stringify(key) + ':' + serialize(item));
  }
  return '{' + parts.join(',') + '}';
}

function assertFinite(value: unknown): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonicalize: non-finite numbers are not valid JSON');
    }
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) assertFinite(item);
    return;
  }
  for (const item of Object.values(value as Record<string, unknown>)) assertFinite(item);
}
