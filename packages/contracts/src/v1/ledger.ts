// The challenge and outcome ledger (stage 10, brief R9 and R10; brief §5
// entity table rows Claim, Relationship, Challenge, Outcome; §7 "Outcome
// learning" and "Challenge handling"). Completes the stage 1 stubs
// additively: the identifiers those stubs required are still required, every
// enumeration is closed and only ever grows, and the single free-text member
// in this file (`ChallengeStatement.note`) is bounded, rescanned by the
// service for secret patterns, and never released to another member.
//
// Privacy (ADR-0002, brief §5 "privacy rules also cover ... challenge
// threads"): nothing here carries a run_id, node_id, or org_ref of another
// organization. A Claim names its supporting evidence as count bands, never
// as run ids; a Relationship joins claim ids; a Challenge is visible to the
// filing organization and the operator only.
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { CountBand, IsoDate } from './answer-receipt.js';
import { ContextKey, Count, ProtocolRef, StringEnum, Timestamp, Ulid } from './common.js';
import { Corroboration, EvidenceOrigin } from './run.js';

/** A claim key (`latency_distribution`), a metric name, or a statistic name. */
export const VocabularyKey = Type.String({
  pattern: '^[a-z][a-z0-9_]*$',
  maxLength: 64,
  description: 'Fixed-vocabulary key from a pack (claim, metric, or statistic name)',
});
export type VocabularyKey = Static<typeof VocabularyKey>;

// ----------------------------------------------------------------------- Claim

/** Brief §5 hypothesis states. */
export const ClaimStatus = StringEnum(
  [
    'proposed',
    'supported',
    'experimentally_tested',
    'independently_reproduced',
    'contradicted',
    'rejected',
  ] as const,
  'Hypothesis state (brief §5)',
);
export type ClaimStatus = Static<typeof ClaimStatus>;

export const ClaimDerivationMethod = StringEnum(
  ['cooperative_release', 'challenge'] as const,
  'How the claim came to exist: released from a cohort, or asserted by a challenge',
);
export type ClaimDerivationMethod = Static<typeof ClaimDerivationMethod>;

/**
 * Where a claim came from. A cooperative release names the calculation,
 * policy, and revision it was computed under and its cohort as bands; a
 * challenge-derived claim names the challenge and its grounds. Never a run.
 */
export const ClaimDerivation = Type.Object(
  {
    method: ClaimDerivationMethod,
    calculation_version: Type.Optional(Type.String({ minLength: 1 })),
    policy_version: Type.Optional(Type.String({ minLength: 1 })),
    evidence_revision: Type.Optional(Count),
    orgs: Type.Optional(CountBand),
    runs: Type.Optional(CountBand),
    challenge_id: Type.Optional(Ulid),
    grounds: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);
export type ClaimDerivation = Static<typeof ClaimDerivation>;

export const Claim = Type.Object(
  {
    claim_id: Ulid,
    /** The receipt this claim was released on (absent for a challenge's counter-claim). */
    receipt_id: Type.Optional(Ulid),
    protocol_ref: ProtocolRef,
    /** The pack's claim key (`latency_distribution`, `error_rate`). */
    claim: VocabularyKey,
    /** The fixed-template finding statement (bands only, no cause). */
    statement: Type.Optional(Type.String()),
    status: ClaimStatus,
    origin: EvidenceOrigin,
    corroboration: Corroboration,
    derivation: ClaimDerivation,
    /** Supporting runs as a band; never as ids. */
    supporting_runs: Type.Optional(CountBand),
    uncertainty: Type.Optional(Type.String()),
    limitations: Type.Optional(Type.Array(Type.String())),
    created_at: Timestamp,
    updated_at: Type.Optional(Timestamp),
  },
  {
    additionalProperties: false,
    description:
      'Claim: an assertion with derivation, supporting evidence as bands, hypothesis status, uncertainty, limitations',
  },
);
export type Claim = Static<typeof Claim>;

// ---------------------------------------------------------------- Relationship

export const RelationshipKind = StringEnum(
  ['supports', 'contradicts', 'reproduces', 'narrows', 'supersedes'] as const,
  'How the source claim relates to the target claim',
);
export type RelationshipKind = Static<typeof RelationshipKind>;

/** Why a relationship was recorded; fixed vocabulary, never free text. */
export const RelationshipRationale = StringEnum(
  [
    'method_error',
    'context_mismatch',
    'data_error',
    'replication_failed',
    'affiliation',
    'insufficient_grounds',
    'newer_evidence',
    'protocol_superseded',
    'independent_replication',
    'recalculation',
  ] as const,
  'Rationale for the relationship (fixed vocabulary)',
);
export type RelationshipRationale = Static<typeof RelationshipRationale>;

export const Relationship = Type.Object(
  {
    relationship_id: Ulid,
    source_claim_id: Ulid,
    target_claim_id: Ulid,
    kind: RelationshipKind,
    rationale: RelationshipRationale,
    /** The evidence revision at which the relationship took effect. */
    revision: Count,
    /** The challenge whose resolution recorded it, when one did. */
    challenge_id: Type.Optional(Ulid),
    created_at: Timestamp,
  },
  {
    additionalProperties: false,
    description: 'Relationship between two claims, with a fixed-vocabulary rationale and revision',
  },
);
export type Relationship = Static<typeof Relationship>;

// ------------------------------------------------------------------- Challenge

export const ChallengeGrounds = StringEnum(
  ['method', 'context_mismatch', 'data_error', 'replication_failed', 'affiliation'] as const,
  'Structured grounds of a challenge (brief §7 "Challenge handling")',
);
export type ChallengeGrounds = Static<typeof ChallengeGrounds>;

export const ChallengeTargetKind = StringEnum(['receipt', 'claim'] as const);
export type ChallengeTargetKind = Static<typeof ChallengeTargetKind>;

export const ChallengeTarget = Type.Object(
  { kind: ChallengeTargetKind, id: Ulid },
  {
    additionalProperties: false,
    description: 'A receipt the filer holds, or a claim released on one',
  },
);
export type ChallengeTarget = Static<typeof ChallengeTarget>;

export const ChallengeStatus = StringEnum(['open', 'acknowledged', 'resolved'] as const);
export type ChallengeStatus = Static<typeof ChallengeStatus>;

export const ChallengeResolution = StringEnum(['upheld', 'rejected', 'superseded'] as const);
export type ChallengeResolution = Static<typeof ChallengeResolution>;

export const ChallengeEvaluationMethod = StringEnum(
  ['operator_review', 'replication', 'recalculation'] as const,
  'How the challenge is evaluated',
);
export type ChallengeEvaluationMethod = Static<typeof ChallengeEvaluationMethod>;

export const ChallengeDirection = StringEnum(['higher', 'lower', 'different'] as const);
export type ChallengeDirection = Static<typeof ChallengeDirection>;

/** Bound on the one free-text member of the ledger. */
export const CHALLENGE_NOTE_MAX_LENGTH = 500;

/**
 * What is being objected to, in fixed vocabulary: which claim, metric,
 * statistic, or context key, in which direction, and (for a failed
 * replication) which of the filer's OWN runs disagreed. `note` is the only
 * free text in the ledger: at most 500 characters, rescanned for secrets by
 * the service, shown to the operator only, never to another member.
 */
export const ChallengeStatement = Type.Object(
  {
    claim: Type.Optional(VocabularyKey),
    metric: Type.Optional(VocabularyKey),
    statistic: Type.Optional(VocabularyKey),
    context_key: Type.Optional(ContextKey),
    direction: Type.Optional(ChallengeDirection),
    /** One of the filer's own runs (the service refuses any other). */
    replication_run_id: Type.Optional(Ulid),
    note: Type.Optional(Type.String({ maxLength: CHALLENGE_NOTE_MAX_LENGTH })),
  },
  { additionalProperties: false },
);
export type ChallengeStatement = Static<typeof ChallengeStatement>;

export const Challenge = Type.Object(
  {
    challenge_id: Ulid,
    target: ChallengeTarget,
    protocol_ref: ProtocolRef,
    grounds: ChallengeGrounds,
    statement: ChallengeStatement,
    evaluation_method: ChallengeEvaluationMethod,
    status: ChallengeStatus,
    /** Present only when `status` is `resolved`. */
    resolution: Type.Optional(ChallengeResolution),
    /** The relationship the resolution recorded (resolved challenges only). */
    relationship_id: Type.Optional(Ulid),
    /** The evidence revision the resolution bumped to (resolved challenges only). */
    resolved_revision: Type.Optional(Count),
    filed_at: Timestamp,
    acknowledged_at: Type.Optional(Timestamp),
    resolved_at: Type.Optional(Timestamp),
  },
  {
    additionalProperties: false,
    description:
      'Challenge against a released finding: target, structured grounds, evaluation method, resolution',
  },
);
export type Challenge = Static<typeof Challenge>;

// --------------------------------------------------------------------- Outcome

export const PredictionComparator = StringEnum(['below', 'above', 'within'] as const);
export type PredictionComparator = Static<typeof PredictionComparator>;

/**
 * What is predicted: a claim (and optionally a metric and statistic) from
 * the receipt the prediction is based on, optionally against a threshold.
 * The threshold is the requester's own decision value and stays with the
 * requester's record; it is never released.
 */
export const PredictionTarget = Type.Object(
  {
    claim: VocabularyKey,
    metric: Type.Optional(VocabularyKey),
    statistic: Type.Optional(VocabularyKey),
    comparator: Type.Optional(PredictionComparator),
    value: Type.Optional(Type.Number()),
    unit: Type.Optional(Type.String({ maxLength: 16, pattern: '^[a-z%/0-9_]+$' })),
  },
  { additionalProperties: false },
);
export type PredictionTarget = Static<typeof PredictionTarget>;

export const EvaluationRule = StringEnum(
  ['own_measurement', 'cooperative_requery', 'operational_observation'] as const,
  'How the outcome will be judged, fixed before it is known',
);
export type EvaluationRule = Static<typeof EvaluationRule>;

export const Prediction = Type.Object(
  {
    prediction_id: Ulid,
    based_on_receipt_id: Ulid,
    protocol_ref: ProtocolRef,
    target: PredictionTarget,
    /** The date by which the outcome is expected to be observable. */
    horizon: IsoDate,
    probability: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
    evaluation_rule: EvaluationRule,
    registered_at: Timestamp,
  },
  {
    additionalProperties: false,
    description:
      'A prediction registered before its outcome is known: target, horizon, probability, evaluation rule',
  },
);
export type Prediction = Static<typeof Prediction>;

export const OutcomeResult = StringEnum(['met', 'not_met', 'indeterminate'] as const);
export type OutcomeResult = Static<typeof OutcomeResult>;

/**
 * The observation, recorded later. `environment_changed` is separate from
 * `result` (brief §3 step 7): a changed environment is recorded as such
 * instead of being mistaken for a wrong prediction or a bad measurement.
 */
export const Observed = Type.Object(
  {
    observed_at: Timestamp,
    result: OutcomeResult,
    environment_changed: Type.Boolean(),
    /** One of the observer's own runs that evaluated the prediction, when one did. */
    evaluation_run_id: Type.Optional(Ulid),
  },
  { additionalProperties: false },
);
export type Observed = Static<typeof Observed>;

export const Outcome = Type.Object(
  {
    outcome_id: Ulid,
    prediction: Prediction,
    observed: Observed,
    recorded_at: Timestamp,
  },
  {
    additionalProperties: false,
    description: 'Observed outcome against a prior prediction (the prediction as registered)',
  },
);
export type Outcome = Static<typeof Outcome>;
