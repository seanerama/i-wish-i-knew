// Minimal but valid schemas for the envelope entities that later phases
// complete. Each carries only its required identifiers; completing them is
// additive (new optional fields, then required ones as the owning stage lands).
import { Type } from '@sinclair/typebox';
import type { Static } from '@sinclair/typebox';
import { Ulid } from './common.js';

// TODO(stage): complete in phase 2 (local investigation): question, requested
// context, priorities, registered thresholds, planned measurements.
export const Investigation = Type.Object(
  { investigation_id: Ulid },
  { description: 'Investigation: question, requested context, priorities, thresholds (stub)' },
);
export type Investigation = Static<typeof Investigation>;

// TODO(stage): complete in phase 4 (evidence-backed answers): derivation,
// supporting runs, status, uncertainty, limitations.
export const Claim = Type.Object(
  { claim_id: Ulid },
  { description: 'Claim: assertion with derivation and supporting runs (stub)' },
);
export type Claim = Static<typeof Claim>;

// TODO(stage): complete in phase 4 (evidence-backed answers): kind
// (supports / contradicts / reproduces / narrows / supersedes) and rationale.
export const Relationship = Type.Object(
  { relationship_id: Ulid, source_claim_id: Ulid, target_claim_id: Ulid },
  { description: 'Relationship between two claims (stub)' },
);
export type Relationship = Static<typeof Relationship>;

// TODO(stage): complete in phase 4 (challenge and outcome ledger): target,
// structured grounds, evaluation method, resolution.
export const Challenge = Type.Object(
  { challenge_id: Ulid },
  { description: 'Challenge against a finding (stub)' },
);
export type Challenge = Static<typeof Challenge>;

// TODO(stage): complete in phase 4 (challenge and outcome ledger): prediction
// target, horizon, evaluation rule recorded before the outcome, observation.
export const Outcome = Type.Object(
  { outcome_id: Ulid },
  { description: 'Observed outcome against a prior prediction (stub)' },
);
export type Outcome = Static<typeof Outcome>;
