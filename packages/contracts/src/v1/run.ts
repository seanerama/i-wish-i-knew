// Run — one execution of one protocol from one node, with honest accounting
// (contracts/evidence-envelope.md §Run).
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { ArtifactCommitment } from './artifact-commitment.js';
import {
  Base64,
  Count,
  Digest,
  OpaqueObject,
  ProtocolRef,
  StringEnum,
  Timestamp,
  Ulid,
} from './common.js';
import { ContextProfile } from './context.js';

export const TargetKind = StringEnum(['service', 'fixture', 'device'] as const);
export type TargetKind = Static<typeof TargetKind>;

export const RunTarget = Type.Object(
  {
    kind: TargetKind,
    label_digest: Digest,
  },
  { additionalProperties: false },
);
export type RunTarget = Static<typeof RunTarget>;

export const ExecutionStatus = StringEnum(
  ['attempted', 'succeeded', 'failed', 'excluded', 'unobserved'] as const,
  '`unobserved` means the collector or target was unreachable; it is never a product failure',
);
export type ExecutionStatus = Static<typeof ExecutionStatus>;

/**
 * Accounting for planned attempts. Beyond the schema, `validate()` enforces
 * that the sums reconcile: `attempted = succeeded + failed` and
 * `planned = attempted + excluded + unobserved` (rule `accounting_reconciles`).
 */
export const RunAccounting = Type.Object(
  {
    planned: Count,
    attempted: Count,
    succeeded: Count,
    failed: Count,
    excluded: Count,
    unobserved: Count,
  },
  { additionalProperties: false },
);
export type RunAccounting = Static<typeof RunAccounting>;

export const EvidenceOrigin = StringEnum([
  'measured',
  'reported',
  'inferred',
  'published',
] as const);
export type EvidenceOrigin = Static<typeof EvidenceOrigin>;

export const Corroboration = StringEnum([
  'unreplicated',
  'independently_replicated',
  'disputed',
] as const);
export type Corroboration = Static<typeof Corroboration>;

export const SharingPolicy = StringEnum(['private', 'cooperative'] as const);
export type SharingPolicy = Static<typeof SharingPolicy>;

export const RunSubmission = Type.Object(
  {
    signed_at: Timestamp,
    key_id: Type.String({ minLength: 1 }),
    signature: Base64,
    sharing_policy: SharingPolicy,
  },
  { additionalProperties: false },
);
export type RunSubmission = Static<typeof RunSubmission>;

export const Run = Type.Object(
  {
    run_id: Ulid,
    attempt_id: Ulid,
    org_ref: Type.Optional(
      Type.String({ minLength: 1, description: 'Set by intake; absent on the wire from the node' }),
    ),
    node_id: Ulid,
    protocol_ref: ProtocolRef,
    protocol_digest: Digest,
    harness_digest: Digest,
    investigation_id: Type.Optional(Ulid),
    started_at: Timestamp,
    ended_at: Timestamp,
    target: RunTarget,
    execution_status: ExecutionStatus,
    exclusion_reason: Type.Optional(Type.String({ minLength: 1 })),
    accounting: RunAccounting,
    context: ContextProfile,
    result: OpaqueObject("Validated separately against the pack's result schema"),
    result_schema_digest: Digest,
    artifacts: Type.Array(ArtifactCommitment),
    origin: EvidenceOrigin,
    corroboration: Corroboration,
    submission: RunSubmission,
  },
  {
    additionalProperties: false,
    description: 'One execution of one protocol from one node, with honest accounting',
    // `exclusion_reason` is REQUIRED when `execution_status = excluded`.
    if: { properties: { execution_status: { const: 'excluded' } }, required: ['execution_status'] },
    then: { required: ['exclusion_reason'] },
  },
);
export type Run = Static<typeof Run>;
