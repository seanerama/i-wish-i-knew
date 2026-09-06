// Shared primitives of the evidence-envelope v1 contract
// (contracts/evidence-envelope.md, "Schema / wire" preamble).
//
// Identifiers are ULIDs, timestamps are RFC 3339 UTC, digests are
// `sha256:<hex>`. Enumerations are emitted as plain `enum` keywords so the
// committed JSON Schema stays readable for non-TypeScript implementers.
import { Type } from '@sinclair/typebox';
import type { TSchema, TUnsafe } from '@sinclair/typebox';

/** ULID: 26 characters of Crockford base32 (no I, L, O, U). */
export const Ulid = Type.String({
  pattern: '^[0-9A-HJKMNP-TV-Z]{26}$',
  description: 'ULID identifier',
});

/** `sha256:<64 lowercase hex>` */
export const Digest = Type.String({
  pattern: '^sha256:[0-9a-f]{64}$',
  description: 'SHA-256 digest, `sha256:<hex>`',
});

/** RFC 3339 timestamp, UTC. */
export const Timestamp = Type.String({
  format: 'date-time',
  description: 'RFC 3339 UTC timestamp',
});

/** `<pack>/<protocol>@<major>` */
export const ProtocolRef = Type.String({
  pattern: '^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9-]*@[1-9][0-9]*$',
  description: 'Protocol reference: <pack>/<protocol>@<major>',
});

/** Dotted context key, e.g. `model.reported`. */
export const ContextKey = Type.String({
  pattern: '^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$',
  description: 'Dotted lowercase context key',
});

/** Standard base64 (RFC 4648 §4). */
export const Base64 = Type.String({
  pattern: '^[A-Za-z0-9+/]+={0,2}$',
  description: 'Standard base64',
});

/** Non-negative integer counter. */
export const Count = Type.Integer({ minimum: 0 });

/**
 * A closed string enumeration. Enums only ever gain members (additive-only
 * rule); the literal union keeps the TypeScript type exact.
 */
export function StringEnum<const T extends readonly string[]>(
  values: T,
  description?: string,
): TUnsafe<T[number]> {
  const schema: Record<string, unknown> = { type: 'string', enum: [...values] };
  if (description !== undefined) schema['description'] = description;
  return Type.Unsafe<T[number]>(schema);
}

/**
 * An object whose shape is defined elsewhere (a pack schema referenced by
 * digest, or a free-form filter map). The envelope never embeds domain fields
 * inline (ADR-0005), so this is intentionally `type: object` and nothing more.
 */
export function OpaqueObject(description: string): TSchema {
  return Type.Object({}, { additionalProperties: true, description });
}
