// ProtocolVersion — immutable procedure identity
// (contracts/evidence-envelope.md §ProtocolVersion).
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { ContextKey, Digest, ProtocolRef, StringEnum } from './common.js';

export const ProtocolStatus = StringEnum(
  ['draft', 'reviewed', 'accepted', 'superseded', 'deprecated'] as const,
  'Registry lifecycle state',
);
export type ProtocolStatus = Static<typeof ProtocolStatus>;

export const ProtocolKind = StringEnum(
  ['controlled', 'observational'] as const,
  'Sampling method; survives ingestion',
);
export type ProtocolKind = Static<typeof ProtocolKind>;

export const ClaimName = Type.String({ pattern: '^[a-z][a-z0-9_]*$' });

export const ProtocolCompatibility = Type.Object(
  {
    harness_digests: Type.Array(Digest, {
      description: 'Harness digests the runner may execute for this version',
    }),
    notes: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
export type ProtocolCompatibility = Static<typeof ProtocolCompatibility>;

export const ProtocolVersion = Type.Object(
  {
    ref: ProtocolRef,
    protocol_digest: Digest,
    harness_digest: Digest,
    status: ProtocolStatus,
    kind: ProtocolKind,
    required_context: Type.Array(ContextKey),
    permitted_claims: Type.Array(ClaimName),
    compatibility: ProtocolCompatibility,
    context_schema_digest: Digest,
    result_schema_digest: Digest,
  },
  {
    additionalProperties: false,
    description:
      'Immutable procedure identity: ref, digests, required context, permitted claims, compatibility rules',
  },
);
export type ProtocolVersion = Static<typeof ProtocolVersion>;
