// Evidence-envelope v1 — every entity of contracts/evidence-envelope.md.
// `entities` is the ordered map the schema builder and validator both use, so
// the committed JSON under contracts/schema/v1/ and the Ajv instance can never
// disagree about which entities exist.
import type { TSchema } from '@sinclair/typebox';
import { AnswerReceipt } from './answer-receipt.js';
import { ArtifactCommitment } from './artifact-commitment.js';
import { ContextField, ContextProfile } from './context.js';
import { ProtocolVersion } from './protocol-version.js';
import { Run } from './run.js';
import { Challenge, Claim, Outcome, Prediction, Relationship } from './ledger.js';
import { Investigation } from './stubs.js';

export * from './common.js';
export * from './context.js';
export * from './protocol-version.js';
export * from './artifact-commitment.js';
export * from './run.js';
export * from './answer-receipt.js';
export * from './stubs.js';
export * from './ledger.js';

export const entities = {
  ProtocolVersion,
  Run,
  ContextProfile,
  ContextField,
  ArtifactCommitment,
  Investigation,
  Claim,
  Relationship,
  AnswerReceipt,
  Challenge,
  Outcome,
  // Stage 10 (additive): the registered half of an Outcome, on its own.
  Prediction,
} as const satisfies Record<string, TSchema>;

export type EntityName = keyof typeof entities;
export const entityNames = Object.keys(entities) as EntityName[];
