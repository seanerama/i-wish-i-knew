// AnswerReceipt — query, cohort description, calculation and policy versions,
// released result, evidence revision (contracts/evidence-envelope.md
// §AnswerReceipt). A receipt never contains a run_id, node_id, or org_ref that
// belongs to another organization.
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Count, Digest, ProtocolRef, StringEnum, Timestamp, Ulid } from './common.js';
import { ContextValue } from './context.js';

export const ReceiptStatus = StringEnum([
  'released',
  'suppressed',
  'insufficient_evidence',
  'stale',
] as const);
export type ReceiptStatus = Static<typeof ReceiptStatus>;

/** A band such as `3-5`, or `<3` / `10+`; never an exact count below the threshold. */
export const CountBand = Type.String({
  pattern: '^(<[0-9]+|[0-9]+-[0-9]+|[0-9]+\\+)$',
  description: 'Count band, e.g. `3-5`, `<3`, `10+`',
});

export const ReceiptCohort = Type.Object(
  {
    protocol_ref: ProtocolRef,
    filters: Type.Record(Type.String(), ContextValue, {
      description: 'Context filters applied, keyed by context key',
    }),
    orgs: CountBand,
    runs: CountBand,
  },
  { additionalProperties: false },
);
export type ReceiptCohort = Static<typeof ReceiptCohort>;

// `no_cooperative_evidence` (added in stage 5, additive): the cohort is empty,
// so the honest answer is `insufficient_evidence`, not a suppressed release.
export const SuppressionReason = StringEnum([
  'min_orgs',
  'concentration',
  'differencing',
  'no_cooperative_evidence',
] as const);
export type SuppressionReason = Static<typeof SuppressionReason>;

/** The released result. Sections are optional; the calculation version says which are present. */
export const ReceiptResult = Type.Object(
  {
    findings: Type.Optional(Type.Array(Type.Unknown())),
    applicability: Type.Optional(Type.Unknown()),
    distributions: Type.Optional(Type.Unknown()),
    missingness: Type.Optional(Type.Unknown()),
    contradictions: Type.Optional(Type.Array(Type.Unknown())),
    uncertainty: Type.Optional(Type.Unknown()),
    freshness: Type.Optional(Type.Unknown()),
    limitations: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false },
);
export type ReceiptResult = Static<typeof ReceiptResult>;

export const AnswerReceipt = Type.Object(
  {
    receipt_id: Ulid,
    query_digest: Digest,
    status: ReceiptStatus,
    cohort: ReceiptCohort,
    calculation_version: Type.String({ minLength: 1 }),
    policy_version: Type.String({ minLength: 1 }),
    evidence_revision: Count,
    result: Type.Optional(ReceiptResult),
    suppression_reasons: Type.Optional(Type.Array(SuppressionReason)),
    issued_at: Timestamp,
  },
  {
    additionalProperties: false,
    description: 'Receipt for an evidence query: cohort, versions, released result, revision',
  },
);
export type AnswerReceipt = Static<typeof AnswerReceipt>;
