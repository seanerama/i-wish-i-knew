// Minimal but valid schemas for the envelope entities that later phases
// complete. Each carries only its required identifiers; completing them is
// additive (new optional fields, then required ones as the owning stage lands).
// Claim, Relationship, Challenge, and Outcome were completed in stage 10
// (ledger.ts); Investigation is the one stub left.
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
