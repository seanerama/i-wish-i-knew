// AnswerReceipt — query, cohort description, calculation and policy versions,
// released result, evidence revision (contracts/evidence-envelope.md
// §AnswerReceipt). A receipt never contains a run_id, node_id, or org_ref that
// belongs to another organization.
//
// Stage 9 (additive): the `result` sections are typed. Every section stays
// optional, and the six sections that were `unknown` in the first frozen
// release (findings items, applicability, distributions, missingness,
// uncertainty, freshness) keep `additionalProperties: true`, because a receipt
// that validated before this typing must still validate (the conformance
// fixture `receipt.valid.json` predates it). The sections introduced here
// (`contradictions` items, `own_evidence`) are closed objects: nothing but
// the named members may appear in them, so an identifier cannot be smuggled
// into a released receipt through them.
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { ContextKey, Count, Digest, ProtocolRef, StringEnum, Timestamp, Ulid } from './common.js';
import { ContextValue } from './context.js';
import { ExecutionStatus, SharingPolicy } from './run.js';

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
export type CountBand = Static<typeof CountBand>;

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
// `min_runs` and `cohort_too_large` (added in stage 9, additive): fewer than
// the policy's minimum runs; more candidate runs than the service decrypts
// for one answer (narrow the filters).
export const SuppressionReason = StringEnum([
  'min_orgs',
  'concentration',
  'differencing',
  'no_cooperative_evidence',
  'min_runs',
  'cohort_too_large',
] as const);
export type SuppressionReason = Static<typeof SuppressionReason>;

/**
 * A count that is exact only at 11 or more (ADR-0002: "never exact below
 * 11"); below that it is a band such as `<11`.
 */
export const ReleasedCount = Type.Union([Type.Integer({ minimum: 11 }), CountBand], {
  description: 'Exact at 11 or more, otherwise a count band',
});
export type ReleasedCount = Static<typeof ReleasedCount>;

/**
 * The spread of one per-run statistic across the contributing runs:
 * nearest-rank percentiles over the per-run values, never a pooled number
 * (claims.json "across_runs"). `n` is the number of runs, as a band.
 */
export const Spread = Type.Object(
  {
    n: CountBand,
    min: Type.Number(),
    p50: Type.Number(),
    p90: Type.Number(),
    p95: Type.Number(),
    p99: Type.Number(),
    max: Type.Number(),
  },
  {
    additionalProperties: false,
    description: 'Nearest-rank spread of a per-run value across runs',
  },
);
export type Spread = Static<typeof Spread>;

export const MetricKind = StringEnum(['distribution', 'rate'] as const);
export type MetricKind = Static<typeof MetricKind>;

/** One claim metric across the cohort: per-run statistic -> spread across runs. */
export const MetricSpread = Type.Object(
  {
    kind: MetricKind,
    unit: Type.Optional(Type.String()),
    runs: CountBand,
    /** `distribution`: one spread per per-run statistic (p50, p90, p95, p99). */
    statistics: Type.Optional(Type.Record(Type.String(), Spread)),
    /** `rate`: the spread of the per-run rate. */
    values: Type.Optional(Spread),
  },
  { additionalProperties: false },
);
export type MetricSpread = Static<typeof MetricSpread>;

export const FindingStatus = StringEnum(['released', 'withheld'] as const);
export type FindingStatus = Static<typeof FindingStatus>;

/**
 * One finding per permitted claim. `statement` is a fixed template filled
 * with bands only; it never proposes a cause. Open (see the file comment).
 */
export const ReceiptFinding = Type.Object(
  {
    claim: Type.String({ minLength: 1 }),
    status: Type.Optional(FindingStatus),
    statement: Type.Optional(Type.String()),
    metrics: Type.Optional(Type.Array(Type.String())),
    reasons: Type.Optional(Type.Array(SuppressionReason)),
  },
  { additionalProperties: true },
);
export type ReceiptFinding = Static<typeof ReceiptFinding>;

export const ReceiptApplicability = Type.Object(
  {
    /** The context keys the caller filtered on: every cohort run matches them exactly. */
    filters_applied: Type.Optional(Type.Array(ContextKey)),
    /** Required keys the caller did not filter on; the cohort varies across them. */
    unfiltered_required_context: Type.Optional(Type.Array(ContextKey)),
    /** Per unfiltered key: how many cohort runs know its value (a band). */
    context_known: Type.Optional(Type.Record(Type.String(), CountBand)),
    ranking: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);
export type ReceiptApplicability = Static<typeof ReceiptApplicability>;

export const ContributorConcentration = Type.Object(
  {
    orgs: CountBand,
    max_org_share: StringEnum(['<=50%', '>50%'] as const),
  },
  { additionalProperties: false },
);
export type ContributorConcentration = Static<typeof ContributorConcentration>;

export const ReceiptDistributions = Type.Object(
  {
    /** claim -> metric -> spread. */
    claims: Type.Optional(Type.Record(Type.String(), Type.Record(Type.String(), MetricSpread))),
    contributors: Type.Optional(ContributorConcentration),
  },
  { additionalProperties: true },
);
export type ReceiptDistributions = Static<typeof ReceiptDistributions>;

export const AttemptSums = Type.Object(
  {
    planned: ReleasedCount,
    attempted: ReleasedCount,
    succeeded: ReleasedCount,
    failed: ReleasedCount,
    excluded: ReleasedCount,
    unobserved: ReleasedCount,
  },
  { additionalProperties: false, description: 'Sums of Run.accounting across the cohort' },
);
export type AttemptSums = Static<typeof AttemptSums>;

export const ReceiptMissingness = Type.Object(
  {
    attempts: Type.Optional(AttemptSums),
    runs_with_unknown_context: Type.Optional(CountBand),
    /** claim -> runs that did not meet the claim's per-run minimum (a band). */
    runs_below_claim_minimum: Type.Optional(Type.Record(Type.String(), CountBand)),
  },
  { additionalProperties: true },
);
export type ReceiptMissingness = Static<typeof ReceiptMissingness>;

export const ContradictionKind = StringEnum(['org_level_iqr_disjoint'] as const);
export type ContradictionKind = Static<typeof ContradictionKind>;

/**
 * Two contributing organizations disagree: their interquartile ranges of a
 * per-run statistic do not overlap. Closed object; `text` is a fixed
 * template that names no organization and proposes no cause.
 */
export const ReceiptContradiction = Type.Object(
  {
    kind: ContradictionKind,
    claim: Type.String({ minLength: 1 }),
    metric: Type.String({ minLength: 1 }),
    statistic: Type.String({ minLength: 1 }),
    text: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export type ReceiptContradiction = Static<typeof ReceiptContradiction>;

export const ReceiptUncertaintyKind = StringEnum(['descriptive', 'range'] as const);
export type ReceiptUncertaintyKind = Static<typeof ReceiptUncertaintyKind>;

export const TailClaims = Type.Object(
  {
    minimum_runs: Type.Integer({ minimum: 0 }),
    supported: Type.Boolean(),
    statement: Type.String(),
  },
  { additionalProperties: false },
);
export type TailClaims = Static<typeof TailClaims>;

export const ReceiptUncertainty = Type.Object(
  {
    kind: Type.Optional(ReceiptUncertaintyKind),
    detail: Type.Optional(Type.String()),
    runs: Type.Optional(CountBand),
    tail_claims: Type.Optional(TailClaims),
  },
  { additionalProperties: true },
);
export type ReceiptUncertainty = Static<typeof ReceiptUncertainty>;

/** `YYYY-MM-DD`: freshness is released as dates only, never as timestamps. */
export const IsoDate = Type.String({ pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' });

export const ReceiptFreshness = Type.Object(
  {
    newest_run_at: Type.Optional(Timestamp),
    oldest_received_on: Type.Optional(IsoDate),
    newest_received_on: Type.Optional(IsoDate),
  },
  { additionalProperties: true },
);
export type ReceiptFreshness = Static<typeof ReceiptFreshness>;

/** Why one of the caller's own runs is not in the cooperative cohort. */
export const OwnRunReason = StringEnum([
  'fixture',
  'private',
  'withdrawn',
  'duplicate',
  'harness_incompatible',
  'filter_mismatch',
  'after_as_of',
  'status_not_countable',
  'not_indexed',
] as const);
export type OwnRunReason = Static<typeof OwnRunReason>;

/** One of the caller's own runs. Ids are allowed here because they are the caller's. */
export const OwnRun = Type.Object(
  {
    run_id: Ulid,
    received_at: Timestamp,
    execution_status: ExecutionStatus,
    sharing_policy: SharingPolicy,
    compatible: Type.Boolean(),
    in_cohort: Type.Boolean(),
    reasons: Type.Array(OwnRunReason),
  },
  { additionalProperties: false },
);
export type OwnRun = Static<typeof OwnRun>;

/**
 * The requester's own evidence for the queried protocol (ADR-0002 "Members
 * can inspect their own evidence"): shown even when the cooperative cohort
 * is suppressed. Exact counts are fine: they are the caller's own.
 */
export const OwnEvidence = Type.Object(
  {
    runs: Type.Array(OwnRun),
    compatible: Count,
    in_cohort: Count,
    note: Type.String(),
  },
  { additionalProperties: false },
);
export type OwnEvidence = Static<typeof OwnEvidence>;

/** The released result. Sections are optional; the calculation version says which are present. */
export const ReceiptResult = Type.Object(
  {
    findings: Type.Optional(Type.Array(ReceiptFinding)),
    applicability: Type.Optional(ReceiptApplicability),
    distributions: Type.Optional(ReceiptDistributions),
    missingness: Type.Optional(ReceiptMissingness),
    contradictions: Type.Optional(Type.Array(ReceiptContradiction)),
    uncertainty: Type.Optional(ReceiptUncertainty),
    freshness: Type.Optional(ReceiptFreshness),
    limitations: Type.Optional(Type.Array(Type.String())),
    own_evidence: Type.Optional(OwnEvidence),
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
