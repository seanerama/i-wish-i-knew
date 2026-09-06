// The ledger's fixed vocabularies (contracts/evidence-envelope.md, stage 10),
// shared by the JSON endpoints, the operator console, and the tests. Enums
// only ever grow.
import type { ChallengeResolution, RelationshipKind } from '@iwik/contracts';

export const CHALLENGE_GROUNDS = [
  'method',
  'context_mismatch',
  'data_error',
  'replication_failed',
  'affiliation',
] as const;
export const CHALLENGE_RESOLUTIONS = ['upheld', 'rejected', 'superseded'] as const;
export const RELATIONSHIP_KINDS = [
  'supports',
  'contradicts',
  'reproduces',
  'narrows',
  'supersedes',
] as const;
export const RELATIONSHIP_RATIONALES = [
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
] as const;
export const EVALUATION_RULES = [
  'own_measurement',
  'cooperative_requery',
  'operational_observation',
] as const;
export const OUTCOME_RESULTS = ['met', 'not_met', 'indeterminate'] as const;
export const DIRECTIONS = ['higher', 'lower', 'different'] as const;
export const COMPARATORS = ['below', 'above', 'within'] as const;

/** Which relationship each resolution records (one fixed mapping). */
export const RESOLUTION_RELATIONSHIP: Record<ChallengeResolution, RelationshipKind> = {
  upheld: 'contradicts',
  rejected: 'narrows',
  superseded: 'supersedes',
};

/** Filing many objections must not suppress evidence: 5 per organization per rolling day. */
export const CHALLENGE_RATE_LIMIT = { max: 5, windowMs: 24 * 60 * 60 * 1000 } as const;
