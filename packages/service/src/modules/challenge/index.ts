// The challenge and outcome ledger (stage 10; brief R9 "Challenge and
// correction", R10 "Learning from outcomes", §7 "Challenge handling" and
// "Outcome learning"; contracts/member-api.md `POST /v1/challenges`,
// `POST /v1/outcomes`), behind IWIK_FEATURE_CHALLENGE (default off: every
// route here answers 404 feature_disabled before authentication).
//
//   POST /v1/challenges                      scope publish: file a structured
//                                            challenge against a receipt the
//                                            caller holds or a claim released
//                                            on one; 5 per organization per
//                                            rolling 24 h, then 429
//   GET  /v1/challenges/:id                  scope query: the filer's own
//                                            challenge; anyone else's is 404
//   POST /v1/admin/challenges/:id/resolve    operator token: resolve as
//                                            upheld | rejected | superseded,
//                                            recording a Relationship per
//                                            claim of the targeted receipt
//                                            and bumping the evidence
//                                            revision, so query receipts of
//                                            that protocol read stale
//   POST /v1/outcomes                        scope publish, two steps:
//                                            { prediction } registers it and
//                                            returns prediction_id;
//                                            { prediction_id, observed }
//                                            records the observation once
//
// Resolution -> relationship -> claim status, one fixed mapping:
//
//   resolution   relationship   target claim               counter-claim
//   upheld       contradicts    contradicted, disputed     supported
//   rejected     narrows        unchanged                  rejected
//   superseded   supersedes     rejected, disputed         supported
//
// The counter-claim is the challenge's own assertion as a Claim row (origin
// `reported`: it is the filer's report, not a measurement). Every resolution
// bumps the revision (a recorded process, R9), whichever way it went.
//
// Privacy (ADR-0002; brief §5 "privacy rules also cover ... challenge
// threads"): a challenge is visible to the filing organization and the
// operator only; a challenge, claim, prediction, or outcome never carries a
// run_id, node_id, or org_ref of another organization; the one free-text
// member (`statement.note`, at most 500 characters) is rescanned for secret
// patterns like a submitted run and is shown to nobody but the operator.
// Error bodies carry codes, paths, and rules only. Logs carry ids only.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type {
  Challenge,
  ChallengeGrounds,
  ChallengeResolution,
  ChallengeStatement,
  ChallengeTarget,
  Claim,
  EvaluationRule,
  Observed,
  Outcome,
  Prediction,
  PredictionTarget,
  Relationship,
  RelationshipKind,
  RelationshipRationale,
} from '@iwik/contracts';
import { CHALLENGE_NOTE_MAX_LENGTH, canonicalize, validate } from '@iwik/contracts';
import type { Config } from '../../config.js';
import type { Pool, Queryable } from '../../db.js';
import { withTransaction } from '../../db.js';
import { ApiError } from '../../errors.js';
import type { ErrorDetail } from '../../errors.js';
import { ULID_PATTERN, ulid } from '../../ulid.js';
import { operatorAuthorized } from '../enrollment/index.js';
import { audit, nodeIsRevoked, requireScope } from '../identity/index.js';
import type { AuthContext } from '../identity/index.js';
import { findReceipt } from '../intake/index.js';
import type { Receipt } from '../intake/index.js';
import { sanitizeValue } from '../intake/sanitize.js';
import type { Registry } from '../registry/index.js';
import { claimsOfReceipt, ensureClaimsForReceipt, findClaim, receiptForClaims } from './claims.js';
import type { ClaimRow } from './claims.js';
import { registerOperatorConsole } from './operator.js';
import {
  CHALLENGE_GROUNDS,
  CHALLENGE_RATE_LIMIT,
  CHALLENGE_RESOLUTIONS,
  COMPARATORS,
  DIRECTIONS,
  EVALUATION_RULES,
  OUTCOME_RESULTS,
  RELATIONSHIP_KINDS,
  RELATIONSHIP_RATIONALES,
  RESOLUTION_RELATIONSHIP,
} from './vocab.js';

export {
  ensureClaimsForReceipt,
  stampClaimIds,
  receiptForClaims,
  toClaim,
  findClaim,
  claimsOfReceipt,
} from './claims.js';

export * from './vocab.js';

const VOCAB_RE = /^[a-z][a-z0-9_]*$/;
const CONTEXT_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ISO_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

export interface ChallengeDeps {
  pool: Pool;
  config: Config;
  registry: Registry;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function validationFailed(details: ErrorDetail[]): ApiError {
  return new ApiError(422, 'validation_failed', { details });
}

/** Pre-handler: 404 feature_disabled unless the flag is on; runs before auth. */
export function requireChallenge(
  config: Config,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async () => {
    if (!config.featureChallenge) throw new ApiError(404, 'feature_disabled');
  };
}

// ---------------------------------------------------------------------------
// Challenges: rows and the entity.

export interface ChallengeRow {
  challenge_id: string;
  org_ref: string;
  node_id: string | null;
  protocol_ref: string;
  target_kind: ChallengeTarget['kind'];
  target_id: string;
  receipt_id: string;
  grounds: ChallengeGrounds;
  statement: ChallengeStatement;
  evaluation_method: Challenge['evaluation_method'];
  status: Challenge['status'];
  resolution: ChallengeResolution | null;
  relationship_id: string | null;
  resolved_revision: string | number | null;
  filed_at: Date;
  acknowledged_at: Date | null;
  resolved_at: Date | null;
}

export function toChallenge(row: ChallengeRow): Challenge {
  const challenge: Challenge = {
    challenge_id: row.challenge_id,
    target: { kind: row.target_kind, id: row.target_id },
    protocol_ref: row.protocol_ref,
    grounds: row.grounds,
    statement: row.statement,
    evaluation_method: row.evaluation_method,
    status: row.status,
    ...(row.resolution !== null ? { resolution: row.resolution } : {}),
    ...(row.relationship_id !== null ? { relationship_id: row.relationship_id } : {}),
    ...(row.resolved_revision !== null ? { resolved_revision: Number(row.resolved_revision) } : {}),
    filed_at: row.filed_at.toISOString(),
    ...(row.acknowledged_at !== null ? { acknowledged_at: row.acknowledged_at.toISOString() } : {}),
    ...(row.resolved_at !== null ? { resolved_at: row.resolved_at.toISOString() } : {}),
  };
  const check = validate('Challenge', challenge);
  if (!check.ok) throw new Error('stored challenge is not a valid Challenge');
  return challenge;
}

/** The filer's own challenge, or undefined; never another organization's. */
export async function findChallenge(
  db: Queryable,
  challengeId: string,
  orgRef?: string,
): Promise<ChallengeRow | undefined> {
  const res =
    orgRef === undefined
      ? await db.query<ChallengeRow>(`SELECT * FROM evidence.challenges WHERE challenge_id = $1`, [
          challengeId,
        ])
      : await db.query<ChallengeRow>(
          `SELECT * FROM evidence.challenges WHERE challenge_id = $1 AND org_ref = $2`,
          [challengeId, orgRef],
        );
  return res.rows[0];
}

export interface ChallengeListing {
  challenge_id: string;
  protocol_ref: string;
  target_kind: ChallengeTarget['kind'];
  grounds: ChallengeGrounds;
  status: Challenge['status'];
  filed_at: Date;
}

/** Open and acknowledged challenges for the operator: grounds and target kind, nothing else. */
export async function listOpenChallenges(db: Queryable, limit = 200): Promise<ChallengeListing[]> {
  const res = await db.query<ChallengeListing>(
    `SELECT challenge_id, protocol_ref, target_kind, grounds, status, filed_at
       FROM evidence.challenges WHERE status <> 'resolved'
      ORDER BY filed_at, challenge_id LIMIT $1`,
    [limit],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// POST /v1/challenges

export interface ChallengeBody {
  target: ChallengeTarget;
  grounds: ChallengeGrounds;
  statement: ChallengeStatement;
}

/** Validate the JSON body; issues carry paths and rules only. */
export function parseChallengeBody(body: unknown, config: Config): ChallengeBody {
  const issues: ErrorDetail[] = [];
  if (!isObject(body)) throw validationFailed([{ path: '', rule: 'type' }]);
  for (const key of Object.keys(body)) {
    if (!['target', 'grounds', 'statement'].includes(key)) {
      issues.push({ path: '', rule: 'additionalProperties' });
    }
  }
  const target = body['target'];
  let parsedTarget: ChallengeTarget | undefined;
  if (target === undefined) issues.push({ path: '/target', rule: 'required' });
  else if (!isObject(target)) issues.push({ path: '/target', rule: 'type' });
  else {
    for (const key of Object.keys(target)) {
      if (key !== 'kind' && key !== 'id')
        issues.push({ path: '/target', rule: 'additionalProperties' });
    }
    const kind = target['kind'];
    const id = target['id'];
    if (kind === undefined) issues.push({ path: '/target/kind', rule: 'required' });
    else if (!oneOf(['receipt', 'claim'] as const, kind))
      issues.push({ path: '/target/kind', rule: 'enum' });
    if (id === undefined) issues.push({ path: '/target/id', rule: 'required' });
    else if (typeof id !== 'string' || !ULID_PATTERN.test(id))
      issues.push({ path: '/target/id', rule: 'pattern' });
    if (
      oneOf(['receipt', 'claim'] as const, kind) &&
      typeof id === 'string' &&
      ULID_PATTERN.test(id)
    ) {
      parsedTarget = { kind, id };
    }
  }
  const grounds = body['grounds'];
  if (grounds === undefined) issues.push({ path: '/grounds', rule: 'required' });
  else if (!oneOf(CHALLENGE_GROUNDS, grounds)) issues.push({ path: '/grounds', rule: 'enum' });
  const statement: ChallengeStatement = {};
  const raw = body['statement'];
  if (raw !== undefined) {
    if (!isObject(raw)) issues.push({ path: '/statement', rule: 'type' });
    else {
      for (const [key, value] of Object.entries(raw)) {
        const path = `/statement/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;
        switch (key) {
          case 'claim':
          case 'metric':
          case 'statistic':
            if (typeof value !== 'string' || !VOCAB_RE.test(value) || value.length > 64) {
              issues.push({ path, rule: 'pattern' });
            } else statement[key] = value;
            break;
          case 'context_key':
            if (typeof value !== 'string' || !CONTEXT_KEY_RE.test(value)) {
              issues.push({ path, rule: 'pattern' });
            } else statement.context_key = value;
            break;
          case 'direction':
            if (!oneOf(DIRECTIONS, value)) issues.push({ path, rule: 'enum' });
            else statement.direction = value;
            break;
          case 'replication_run_id':
            if (typeof value !== 'string' || !ULID_PATTERN.test(value)) {
              issues.push({ path, rule: 'pattern' });
            } else statement.replication_run_id = value;
            break;
          case 'note':
            if (typeof value !== 'string') issues.push({ path, rule: 'type' });
            else if (value.length > CHALLENGE_NOTE_MAX_LENGTH) {
              issues.push({ path, rule: 'maxLength' });
            } else statement.note = value;
            break;
          default:
            issues.push({ path: '/statement', rule: 'additionalProperties' });
        }
      }
      // The one free-text member is rescanned exactly like a submitted run
      // (ADR-0002 control 3): a hit rejects the whole challenge with the
      // path only; the value is never surfaced, logged, or stored.
      if (statement.note !== undefined) {
        const scan = sanitizeValue(
          { note: statement.note },
          { maxStringLength: CHALLENGE_NOTE_MAX_LENGTH, extraPatterns: config.extraSecretPatterns },
        );
        for (const issue of scan.issues)
          issues.push({ path: `/statement${issue.path}`, rule: issue.rule });
      }
    }
  }
  if (issues.length > 0 || parsedTarget === undefined) throw validationFailed(issues);
  return { target: parsedTarget, grounds: grounds as ChallengeGrounds, statement };
}

export interface FileChallengeRequest extends ChallengeBody {
  org_ref: string;
  node_id: string;
}

/**
 * Resolve the target to a receipt the filer holds. A receipt target must be
 * one of the organization's own query receipts with a released answer; a
 * claim target must have been released on one of them. Unknown and foreign
 * ids are both 404, so nothing is confirmed about anyone else's records.
 */
async function resolveTarget(
  db: Queryable,
  target: ChallengeTarget,
  orgRef: string,
): Promise<{ receipt: Receipt; claim?: ClaimRow }> {
  if (target.kind === 'claim') {
    const claim = await findClaim(db, target.id);
    if (claim === undefined || claim.org_ref !== orgRef || claim.receipt_id === null) {
      throw new ApiError(404, 'not_found');
    }
    const receipt = await findReceipt(db, claim.receipt_id, orgRef);
    if (receipt === undefined) throw new ApiError(404, 'not_found');
    return { receipt, claim };
  }
  const receipt = await findReceipt(db, target.id, orgRef);
  if (receipt === undefined || receipt.kind !== 'query') throw new ApiError(404, 'not_found');
  if (receipt.status !== 'released') {
    throw validationFailed([{ path: '/target/id', rule: 'not_released' }]);
  }
  return { receipt };
}

function protocolOf(receipt: Receipt): string {
  const cohort = receipt['cohort'];
  const ref = isObject(cohort) ? cohort['protocol_ref'] : undefined;
  if (typeof ref !== 'string') throw new Error('query receipt without a protocol_ref');
  return ref;
}

/** Seconds until the oldest challenge inside the window leaves it. */
function retryAfterSeconds(oldestInWindow: Date, now: number): number {
  return Math.max(
    1,
    Math.ceil((oldestInWindow.getTime() + CHALLENGE_RATE_LIMIT.windowMs - now) / 1000),
  );
}

export async function fileChallenge(
  pool: Pool,
  request: FileChallengeRequest,
): Promise<ChallengeRow> {
  return withTransaction(pool, async (client) => {
    // One filing per organization at a time, so the rolling count is exact.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `challenge:${request.org_ref}`,
    ]);
    if (await nodeIsRevoked(client, request.node_id)) throw new ApiError(401, 'node_revoked');
    const now = Date.now();
    const window = await client.query<{ filed_at: Date }>(
      `SELECT filed_at FROM evidence.challenges
        WHERE org_ref = $1 AND filed_at > $2::timestamptz
        ORDER BY filed_at ASC`,
      [request.org_ref, new Date(now - CHALLENGE_RATE_LIMIT.windowMs)],
    );
    if (window.rows.length >= CHALLENGE_RATE_LIMIT.max) {
      const oldest = window.rows[0] as { filed_at: Date };
      throw new ApiError(429, 'rate_limited', {
        headers: { 'retry-after': String(retryAfterSeconds(oldest.filed_at, now)) },
      });
    }
    const { receipt, claim } = await resolveTarget(client, request.target, request.org_ref);
    if (request.statement.replication_run_id !== undefined) {
      const own = await client.query(
        `SELECT 1 FROM evidence.runs WHERE run_id = $1 AND org_ref = $2`,
        [request.statement.replication_run_id, request.org_ref],
      );
      if (own.rows.length === 0) throw new ApiError(404, 'not_found');
    }
    const challengeId = ulid();
    const inserted = await client.query<ChallengeRow>(
      `INSERT INTO evidence.challenges
         (challenge_id, org_ref, node_id, protocol_ref, target_kind, target_id, receipt_id,
          grounds, statement)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        challengeId,
        request.org_ref,
        request.node_id,
        claim?.protocol_ref ?? protocolOf(receipt),
        request.target.kind,
        request.target.id,
        receipt.receipt_id,
        request.grounds,
        JSON.stringify(request.statement),
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('challenge insert returned no row');
    await audit(client, 'challenge.filed', `node:${request.node_id}`, `challenge:${challengeId}`);
    return row;
  });
}

// ---------------------------------------------------------------------------
// POST /v1/admin/challenges/:id/resolve

export interface ResolveBody {
  resolution: ChallengeResolution;
  relationship: { kind: RelationshipKind; rationale: RelationshipRationale };
}

export function parseResolveBody(body: unknown): ResolveBody {
  const issues: ErrorDetail[] = [];
  if (!isObject(body)) throw validationFailed([{ path: '', rule: 'type' }]);
  for (const key of Object.keys(body)) {
    if (key !== 'resolution' && key !== 'relationship') {
      issues.push({ path: '', rule: 'additionalProperties' });
    }
  }
  const resolution = body['resolution'];
  if (resolution === undefined) issues.push({ path: '/resolution', rule: 'required' });
  else if (!oneOf(CHALLENGE_RESOLUTIONS, resolution))
    issues.push({ path: '/resolution', rule: 'enum' });
  const relationship = body['relationship'];
  let kind: RelationshipKind | undefined;
  let rationale: RelationshipRationale | undefined;
  if (relationship === undefined) issues.push({ path: '/relationship', rule: 'required' });
  else if (!isObject(relationship)) issues.push({ path: '/relationship', rule: 'type' });
  else {
    for (const key of Object.keys(relationship)) {
      if (key !== 'kind' && key !== 'rationale') {
        issues.push({ path: '/relationship', rule: 'additionalProperties' });
      }
    }
    if (relationship['kind'] === undefined)
      issues.push({ path: '/relationship/kind', rule: 'required' });
    else if (!oneOf(RELATIONSHIP_KINDS, relationship['kind'])) {
      issues.push({ path: '/relationship/kind', rule: 'enum' });
    } else kind = relationship['kind'];
    if (relationship['rationale'] === undefined) {
      issues.push({ path: '/relationship/rationale', rule: 'required' });
    } else if (!oneOf(RELATIONSHIP_RATIONALES, relationship['rationale'])) {
      issues.push({ path: '/relationship/rationale', rule: 'enum' });
    } else rationale = relationship['rationale'];
  }
  // The relationship kind follows from the resolution; anything else is a
  // contradiction in the request, not a choice.
  if (
    oneOf(CHALLENGE_RESOLUTIONS, resolution) &&
    kind !== undefined &&
    RESOLUTION_RELATIONSHIP[resolution] !== kind
  ) {
    issues.push({ path: '/relationship/kind', rule: 'resolution_kind' });
  }
  if (issues.length > 0 || kind === undefined || rationale === undefined) {
    throw validationFailed(issues);
  }
  return { resolution: resolution as ChallengeResolution, relationship: { kind, rationale } };
}

export interface ResolveResult {
  challenge_id: string;
  status: 'resolved';
  resolution: ChallengeResolution;
  relationship_id?: string;
  relationships: number;
  resolved_revision: number;
}

/** The target claim's new (status, corroboration) per resolution, or undefined for no change. */
function targetClaimUpdate(
  resolution: ChallengeResolution,
): { status: Claim['status']; corroboration: Claim['corroboration'] } | undefined {
  if (resolution === 'upheld') return { status: 'contradicted', corroboration: 'disputed' };
  if (resolution === 'superseded') return { status: 'rejected', corroboration: 'disputed' };
  return undefined;
}

/**
 * Resolve a challenge (operator). Serialized on the same `evidence.revision`
 * lock intake and withdrawal take, so the bump is one revision ordered with
 * every accepted run; the relationship rows, the claim updates, the
 * revision_log row (kind `challenge`), the cache eviction, and the audit
 * row commit together. 404 unknown, 409 challenge_resolved when already done.
 */
export async function resolveChallenge(
  pool: Pool,
  challengeId: string,
  body: ResolveBody,
  actor = 'operator',
): Promise<ResolveResult> {
  return withTransaction(pool, async (client) => {
    await client.query(`SELECT revision FROM evidence.revision WHERE singleton FOR UPDATE`);
    const found = await client.query<ChallengeRow>(
      `SELECT * FROM evidence.challenges WHERE challenge_id = $1 FOR UPDATE`,
      [challengeId],
    );
    const challenge = found.rows[0];
    if (challenge === undefined) throw new ApiError(404, 'not_found');
    if (challenge.status === 'resolved') throw new ApiError(409, 'challenge_resolved');

    // The claims the challenge bears on: the one it names, or every claim
    // released on the receipt (created now if the receipt predates them).
    let targets: ClaimRow[];
    if (challenge.target_kind === 'claim') {
      const one = await findClaim(client, challenge.target_id);
      targets = one === undefined ? [] : [one];
    } else {
      const receipt = await findReceipt(client, challenge.receipt_id, challenge.org_ref);
      const view = receipt === undefined ? undefined : receiptForClaims(receipt, challenge.org_ref);
      if (view !== undefined) await ensureClaimsForReceipt(client, view);
      targets = await claimsOfReceipt(client, challenge.receipt_id);
    }

    const bumped = await client.query<{ revision: string | number }>(
      `UPDATE evidence.revision SET revision = revision + 1, updated_at = now()
        WHERE singleton RETURNING revision`,
    );
    const revision = Number(bumped.rows[0]?.revision ?? 0);
    await client.query(
      `INSERT INTO evidence.revision_log (revision, protocol_ref, kind) VALUES ($1, $2, 'challenge')`,
      [revision, challenge.protocol_ref],
    );
    // Derived answers computed before this revision are no longer current
    // (the read path would notice; this keeps the table honest).
    await client.query(`DELETE FROM evidence.cache WHERE protocol_ref = $1 AND revision < $2`, [
      challenge.protocol_ref,
      revision,
    ]);

    // The challenge's own assertion, as a claim: reported, not measured.
    const counterId = ulid();
    const counterStatus: Claim['status'] =
      body.resolution === 'rejected' ? 'rejected' : 'supported';
    const counterKey = challenge.statement.claim ?? targets[0]?.claim_key ?? 'challenge';
    await client.query(
      `INSERT INTO evidence.claims
         (claim_id, receipt_id, org_ref, protocol_ref, claim_key, status, origin, corroboration,
          payload, evidence_revision)
       VALUES ($1, NULL, $2, $3, $4, $5, 'reported', 'unreplicated', $6, $7)`,
      [
        counterId,
        challenge.org_ref,
        challenge.protocol_ref,
        counterKey,
        counterStatus,
        JSON.stringify({
          derivation: {
            method: 'challenge',
            challenge_id: challengeId,
            grounds: challenge.grounds,
          },
        }),
        revision,
      ],
    );

    const update = targetClaimUpdate(body.resolution);
    let firstRelationship: string | undefined;
    for (const target of targets) {
      const relationshipId = ulid();
      firstRelationship ??= relationshipId;
      await client.query(
        `INSERT INTO evidence.relationships
           (relationship_id, source_claim_id, target_claim_id, kind, rationale, revision, challenge_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          relationshipId,
          counterId,
          target.claim_id,
          body.relationship.kind,
          body.relationship.rationale,
          revision,
          challengeId,
        ],
      );
      if (update !== undefined) {
        await client.query(
          `UPDATE evidence.claims SET status = $2, corroboration = $3, updated_at = now()
            WHERE claim_id = $1`,
          [target.claim_id, update.status, update.corroboration],
        );
      }
    }
    await client.query(
      `UPDATE evidence.challenges
          SET status = 'resolved', resolution = $2, relationship_id = $3, resolved_revision = $4,
              resolved_at = now(), acknowledged_at = COALESCE(acknowledged_at, now())
        WHERE challenge_id = $1`,
      [challengeId, body.resolution, firstRelationship ?? null, revision],
    );
    await audit(client, 'challenge.resolved', actor, `challenge:${challengeId}`);
    return {
      challenge_id: challengeId,
      status: 'resolved',
      resolution: body.resolution,
      ...(firstRelationship !== undefined ? { relationship_id: firstRelationship } : {}),
      relationships: targets.length,
      resolved_revision: revision,
    };
  });
}

/** Operator: mark an open challenge acknowledged (console). False when not open. */
export async function acknowledgeChallenge(
  db: Queryable,
  challengeId: string,
  actor = 'operator',
): Promise<boolean> {
  const res = await db.query(
    `UPDATE evidence.challenges SET status = 'acknowledged', acknowledged_at = now()
      WHERE challenge_id = $1 AND status = 'open'`,
    [challengeId],
  );
  const done = (res.rowCount ?? 0) > 0;
  if (done) await audit(db, 'challenge.acknowledged', actor, `challenge:${challengeId}`);
  return done;
}

export interface RelationshipRow {
  relationship_id: string;
  source_claim_id: string;
  target_claim_id: string;
  kind: RelationshipKind;
  rationale: RelationshipRationale;
  revision: string | number;
  challenge_id: string | null;
  created_at: Date;
}

export function toRelationship(row: RelationshipRow): Relationship {
  const relationship: Relationship = {
    relationship_id: row.relationship_id,
    source_claim_id: row.source_claim_id,
    target_claim_id: row.target_claim_id,
    kind: row.kind,
    rationale: row.rationale,
    revision: Number(row.revision),
    ...(row.challenge_id !== null ? { challenge_id: row.challenge_id } : {}),
    created_at: row.created_at.toISOString(),
  };
  const check = validate('Relationship', relationship);
  if (!check.ok) throw new Error('stored relationship is not a valid Relationship');
  return relationship;
}

export async function relationshipsOfChallenge(
  db: Queryable,
  challengeId: string,
): Promise<RelationshipRow[]> {
  const res = await db.query<RelationshipRow>(
    `SELECT * FROM evidence.relationships WHERE challenge_id = $1 ORDER BY relationship_id`,
    [challengeId],
  );
  return res.rows;
}

// ---------------------------------------------------------------------------
// POST /v1/outcomes

export interface PredictionRow {
  prediction_id: string;
  org_ref: string;
  node_id: string | null;
  based_on_receipt_id: string;
  protocol_ref: string;
  target: PredictionTarget;
  horizon: Date | string;
  probability: number | null;
  evaluation_rule: EvaluationRule;
  registered_at: Date;
}

function isoDate(value: Date | string): string {
  if (typeof value === 'string') return value.slice(0, 10);
  // node-postgres parses `date` in local time; render the calendar date it named.
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function toPrediction(row: PredictionRow): Prediction {
  const prediction: Prediction = {
    prediction_id: row.prediction_id,
    based_on_receipt_id: row.based_on_receipt_id,
    protocol_ref: row.protocol_ref,
    target: row.target,
    horizon: isoDate(row.horizon),
    ...(row.probability !== null ? { probability: row.probability } : {}),
    evaluation_rule: row.evaluation_rule,
    registered_at: row.registered_at.toISOString(),
  };
  const check = validate('Prediction', prediction);
  if (!check.ok) throw new Error('stored prediction is not a valid Prediction');
  return prediction;
}

export interface OutcomeRow {
  outcome_id: string;
  prediction_id: string;
  org_ref: string;
  observed_at: Date;
  result: Observed['result'];
  environment_changed: boolean;
  evaluation_run_id: string | null;
  recorded_at: Date;
}

export function toOutcome(prediction: PredictionRow, row: OutcomeRow): Outcome {
  const outcome: Outcome = {
    outcome_id: row.outcome_id,
    prediction: toPrediction(prediction),
    observed: {
      observed_at: row.observed_at.toISOString(),
      result: row.result,
      environment_changed: row.environment_changed,
      ...(row.evaluation_run_id !== null ? { evaluation_run_id: row.evaluation_run_id } : {}),
    },
    recorded_at: row.recorded_at.toISOString(),
  };
  const check = validate('Outcome', outcome);
  if (!check.ok) throw new Error('assembled outcome is not a valid Outcome');
  return outcome;
}

export interface PredictionInput {
  based_on_receipt_id: string;
  target: PredictionTarget;
  horizon: string;
  probability?: number;
  evaluation_rule: EvaluationRule;
}

export interface ObservedInput {
  observed_at: string;
  result: Observed['result'];
  environment_changed: boolean;
  evaluation_run_id?: string;
}

export type OutcomeBody =
  | { step: 'register'; prediction: PredictionInput }
  | {
      step: 'observe';
      prediction_id: string;
      observed: ObservedInput;
      target?: PredictionTarget;
      based_on_receipt_id?: string;
    };

function parsePredictionTarget(
  raw: unknown,
  path: string,
  issues: ErrorDetail[],
): PredictionTarget | undefined {
  if (!isObject(raw)) {
    issues.push({ path, rule: raw === undefined ? 'required' : 'type' });
    return undefined;
  }
  const target: PredictionTarget = { claim: '' };
  let ok = true;
  for (const [key, value] of Object.entries(raw)) {
    const here = `${path}/${key}`;
    switch (key) {
      case 'claim':
      case 'metric':
      case 'statistic':
        if (typeof value !== 'string' || !VOCAB_RE.test(value) || value.length > 64) {
          issues.push({ path: here, rule: 'pattern' });
          ok = false;
        } else target[key] = value;
        break;
      case 'comparator':
        if (!oneOf(COMPARATORS, value)) {
          issues.push({ path: here, rule: 'enum' });
          ok = false;
        } else target.comparator = value;
        break;
      case 'value':
        if (typeof value !== 'number' || !Number.isFinite(value)) {
          issues.push({ path: here, rule: 'type' });
          ok = false;
        } else target.value = value;
        break;
      case 'unit':
        if (typeof value !== 'string' || !/^[a-z%/0-9_]{1,16}$/.test(value)) {
          issues.push({ path: here, rule: 'pattern' });
          ok = false;
        } else target.unit = value;
        break;
      default:
        issues.push({ path, rule: 'additionalProperties' });
        ok = false;
    }
  }
  if (target.claim === '') {
    issues.push({ path: `${path}/claim`, rule: 'required' });
    ok = false;
  }
  return ok ? target : undefined;
}

function parseTimestamp(value: unknown, path: string, issues: ErrorDetail[]): string | undefined {
  if (typeof value !== 'string') {
    issues.push({ path, rule: value === undefined ? 'required' : 'type' });
    return undefined;
  }
  const t = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) ||
    Number.isNaN(t)
  ) {
    issues.push({ path, rule: 'format' });
    return undefined;
  }
  return new Date(t).toISOString();
}

/** Validate the JSON body of either step; issues carry paths and rules only. */
export function parseOutcomeBody(body: unknown): OutcomeBody {
  const issues: ErrorDetail[] = [];
  if (!isObject(body)) throw validationFailed([{ path: '', rule: 'type' }]);
  const known = ['prediction', 'prediction_id', 'observed', 'target', 'based_on_receipt_id'];
  for (const key of Object.keys(body)) {
    if (!known.includes(key)) issues.push({ path: '', rule: 'additionalProperties' });
  }
  const predictionId = body['prediction_id'];
  const prediction = body['prediction'];
  const observed = body['observed'];
  if (
    predictionId !== undefined &&
    (typeof predictionId !== 'string' || !ULID_PATTERN.test(predictionId))
  ) {
    issues.push({ path: '/prediction_id', rule: 'pattern' });
  }
  // A body that names an existing prediction and also carries a prediction:
  // the stored one can never be altered, so this is refused outright.
  if (typeof predictionId === 'string' && prediction !== undefined) {
    if (issues.length > 0) throw validationFailed(issues);
    throw new ApiError(409, 'prediction_immutable');
  }
  if (prediction !== undefined) {
    if (observed !== undefined) issues.push({ path: '/observed', rule: 'prediction_first' });
    if (!isObject(prediction)) {
      issues.push({ path: '/prediction', rule: 'type' });
      throw validationFailed(issues);
    }
    const p = prediction;
    for (const key of Object.keys(p)) {
      if (
        !['based_on_receipt_id', 'target', 'horizon', 'probability', 'evaluation_rule'].includes(
          key,
        )
      ) {
        issues.push({ path: '/prediction', rule: 'additionalProperties' });
      }
    }
    const receiptId = p['based_on_receipt_id'];
    if (receiptId === undefined)
      issues.push({ path: '/prediction/based_on_receipt_id', rule: 'required' });
    else if (typeof receiptId !== 'string' || !ULID_PATTERN.test(receiptId)) {
      issues.push({ path: '/prediction/based_on_receipt_id', rule: 'pattern' });
    }
    const target = parsePredictionTarget(p['target'], '/prediction/target', issues);
    const horizon = p['horizon'];
    if (horizon === undefined) issues.push({ path: '/prediction/horizon', rule: 'required' });
    else if (
      typeof horizon !== 'string' ||
      !ISO_DATE_RE.test(horizon) ||
      Number.isNaN(Date.parse(horizon))
    ) {
      issues.push({ path: '/prediction/horizon', rule: 'pattern' });
    } else if (horizon < new Date().toISOString().slice(0, 10)) {
      // A horizon already behind us is not a prediction.
      issues.push({ path: '/prediction/horizon', rule: 'minimum' });
    }
    const probability = p['probability'];
    if (
      probability !== undefined &&
      (typeof probability !== 'number' || probability < 0 || probability > 1)
    ) {
      issues.push({ path: '/prediction/probability', rule: 'range' });
    }
    const rule = p['evaluation_rule'];
    if (rule === undefined) issues.push({ path: '/prediction/evaluation_rule', rule: 'required' });
    else if (!oneOf(EVALUATION_RULES, rule))
      issues.push({ path: '/prediction/evaluation_rule', rule: 'enum' });
    if (issues.length > 0 || target === undefined) throw validationFailed(issues);
    return {
      step: 'register',
      prediction: {
        based_on_receipt_id: receiptId as string,
        target,
        horizon: horizon as string,
        ...(typeof probability === 'number' ? { probability } : {}),
        evaluation_rule: rule as EvaluationRule,
      },
    };
  }
  if (predictionId === undefined) issues.push({ path: '/prediction_id', rule: 'required' });
  if (observed === undefined) issues.push({ path: '/observed', rule: 'required' });
  else if (!isObject(observed)) issues.push({ path: '/observed', rule: 'type' });
  let parsedObserved: ObservedInput | undefined;
  if (isObject(observed)) {
    for (const key of Object.keys(observed)) {
      if (!['observed_at', 'result', 'environment_changed', 'evaluation_run_id'].includes(key)) {
        issues.push({ path: '/observed', rule: 'additionalProperties' });
      }
    }
    const observedAt = parseTimestamp(observed['observed_at'], '/observed/observed_at', issues);
    const result = observed['result'];
    if (result === undefined) issues.push({ path: '/observed/result', rule: 'required' });
    else if (!oneOf(OUTCOME_RESULTS, result))
      issues.push({ path: '/observed/result', rule: 'enum' });
    const env = observed['environment_changed'];
    if (env === undefined) issues.push({ path: '/observed/environment_changed', rule: 'required' });
    else if (typeof env !== 'boolean')
      issues.push({ path: '/observed/environment_changed', rule: 'type' });
    const evalRun = observed['evaluation_run_id'];
    if (evalRun !== undefined && (typeof evalRun !== 'string' || !ULID_PATTERN.test(evalRun))) {
      issues.push({ path: '/observed/evaluation_run_id', rule: 'pattern' });
    }
    if (observedAt !== undefined && oneOf(OUTCOME_RESULTS, result) && typeof env === 'boolean') {
      parsedObserved = {
        observed_at: observedAt,
        result,
        environment_changed: env,
        ...(typeof evalRun === 'string' ? { evaluation_run_id: evalRun } : {}),
      };
    }
  }
  let target: PredictionTarget | undefined;
  if (body['target'] !== undefined)
    target = parsePredictionTarget(body['target'], '/target', issues);
  const basedOn = body['based_on_receipt_id'];
  if (basedOn !== undefined && (typeof basedOn !== 'string' || !ULID_PATTERN.test(basedOn))) {
    issues.push({ path: '/based_on_receipt_id', rule: 'pattern' });
  }
  if (issues.length > 0 || parsedObserved === undefined) throw validationFailed(issues);
  return {
    step: 'observe',
    prediction_id: predictionId as string,
    observed: parsedObserved,
    ...(target !== undefined ? { target } : {}),
    ...(typeof basedOn === 'string' ? { based_on_receipt_id: basedOn } : {}),
  };
}

export async function registerPrediction(
  pool: Pool,
  registry: Registry,
  auth: AuthContext,
  input: PredictionInput,
): Promise<PredictionRow> {
  return withTransaction(pool, async (client) => {
    if (await nodeIsRevoked(client, auth.node_id)) throw new ApiError(401, 'node_revoked');
    const receipt = await findReceipt(client, input.based_on_receipt_id, auth.org_ref);
    if (receipt === undefined || receipt.kind !== 'query') throw new ApiError(404, 'not_found');
    const protocolRef = protocolOf(receipt);
    const entry = registry.get(protocolRef);
    if (entry !== undefined && !entry.protocol.permitted_claims.includes(input.target.claim)) {
      throw validationFailed([{ path: '/prediction/target/claim', rule: 'claim_unknown' }]);
    }
    const predictionId = ulid();
    const inserted = await client.query<PredictionRow>(
      `INSERT INTO evidence.predictions
         (prediction_id, org_ref, node_id, based_on_receipt_id, protocol_ref, target, horizon,
          probability, evaluation_rule)
       VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8, $9)
       RETURNING *`,
      [
        predictionId,
        auth.org_ref,
        auth.node_id,
        input.based_on_receipt_id,
        protocolRef,
        JSON.stringify(input.target),
        input.horizon,
        input.probability ?? null,
        input.evaluation_rule,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('prediction insert returned no row');
    await audit(
      client,
      'prediction.registered',
      `node:${auth.node_id}`,
      `prediction:${predictionId}`,
    );
    return row;
  });
}

export async function findPrediction(
  db: Queryable,
  predictionId: string,
  orgRef: string,
): Promise<PredictionRow | undefined> {
  const res = await db.query<PredictionRow>(
    `SELECT * FROM evidence.predictions WHERE prediction_id = $1 AND org_ref = $2`,
    [predictionId, orgRef],
  );
  return res.rows[0];
}

export async function findOutcome(
  db: Queryable,
  predictionId: string,
): Promise<OutcomeRow | undefined> {
  const res = await db.query<OutcomeRow>(
    `SELECT * FROM evidence.outcomes WHERE prediction_id = $1`,
    [predictionId],
  );
  return res.rows[0];
}

export interface ObserveRequest {
  prediction_id: string;
  observed: ObservedInput;
  target?: PredictionTarget;
  based_on_receipt_id?: string;
}

/**
 * Record the observation for a prediction exactly once. The prediction row
 * is never touched (the database refuses updates to it besides); a body that
 * restates the target or the receipt differently from what was registered is
 * 409 target_mismatch, and a second observation is 409 outcome_exists.
 */
export async function recordOutcome(
  pool: Pool,
  auth: AuthContext,
  request: ObserveRequest,
): Promise<{ prediction: PredictionRow; outcome: OutcomeRow }> {
  return withTransaction(pool, async (client) => {
    if (await nodeIsRevoked(client, auth.node_id)) throw new ApiError(401, 'node_revoked');
    const prediction = await findPrediction(client, request.prediction_id, auth.org_ref);
    if (prediction === undefined) throw new ApiError(404, 'not_found');
    if (
      request.target !== undefined &&
      canonicalize(request.target) !== canonicalize(prediction.target)
    ) {
      throw new ApiError(409, 'target_mismatch');
    }
    if (
      request.based_on_receipt_id !== undefined &&
      request.based_on_receipt_id !== prediction.based_on_receipt_id
    ) {
      throw new ApiError(409, 'target_mismatch');
    }
    if (Date.parse(request.observed.observed_at) < prediction.registered_at.getTime()) {
      throw validationFailed([{ path: '/observed/observed_at', rule: 'minimum' }]);
    }
    if (request.observed.evaluation_run_id !== undefined) {
      const own = await client.query(
        `SELECT 1 FROM evidence.runs WHERE run_id = $1 AND org_ref = $2`,
        [request.observed.evaluation_run_id, auth.org_ref],
      );
      if (own.rows.length === 0) throw new ApiError(404, 'not_found');
    }
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
      `outcome:${request.prediction_id}`,
    ]);
    if ((await findOutcome(client, request.prediction_id)) !== undefined) {
      throw new ApiError(409, 'outcome_exists');
    }
    const outcomeId = ulid();
    const inserted = await client.query<OutcomeRow>(
      `INSERT INTO evidence.outcomes
         (outcome_id, prediction_id, org_ref, observed_at, result, environment_changed,
          evaluation_run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        outcomeId,
        request.prediction_id,
        auth.org_ref,
        request.observed.observed_at,
        request.observed.result,
        request.observed.environment_changed,
        request.observed.evaluation_run_id ?? null,
      ],
    );
    const outcome = inserted.rows[0];
    if (outcome === undefined) throw new Error('outcome insert returned no row');
    await audit(client, 'outcome.recorded', `node:${auth.node_id}`, `outcome:${outcomeId}`);
    return { prediction, outcome };
  });
}

// ---------------------------------------------------------------------------

export function registerChallengeRoutes(app: FastifyInstance, deps: ChallengeDeps): void {
  const { pool, config, registry } = deps;
  const gate = requireChallenge(config);

  app.post(
    '/v1/challenges',
    { preHandler: [gate, requireScope('publish')] },
    async (request, reply) => {
      const auth = request.auth;
      if (auth === undefined) throw new ApiError(401, 'unauthorized');
      const body = parseChallengeBody(request.body, config);
      const row = await fileChallenge(pool, {
        ...body,
        org_ref: auth.org_ref,
        node_id: auth.node_id,
      });
      request.log.info(
        {
          challenge_id: row.challenge_id,
          protocol_ref: row.protocol_ref,
          target_kind: row.target_kind,
          grounds: row.grounds,
        },
        'challenge filed',
      );
      reply.status(201);
      return toChallenge(row);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/challenges/:id',
    { preHandler: [gate, requireScope('query')] },
    async (request) => {
      const auth = request.auth;
      if (auth === undefined) throw new ApiError(401, 'unauthorized');
      const id = request.params.id;
      const row = ULID_PATTERN.test(id) ? await findChallenge(pool, id, auth.org_ref) : undefined;
      if (row === undefined) throw new ApiError(404, 'not_found');
      return toChallenge(row);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/admin/challenges/:id/resolve',
    { preHandler: gate },
    async (request) => {
      if (!operatorAuthorized(request, config)) throw new ApiError(401, 'unauthorized');
      const id = request.params.id;
      if (!ULID_PATTERN.test(id)) throw new ApiError(404, 'not_found');
      const body = parseResolveBody(request.body);
      const result = await resolveChallenge(pool, id, body);
      request.log.info(
        {
          challenge_id: result.challenge_id,
          resolution: result.resolution,
          relationships: result.relationships,
          resolved_revision: result.resolved_revision,
        },
        'challenge resolved',
      );
      return result;
    },
  );

  app.post(
    '/v1/outcomes',
    { preHandler: [gate, requireScope('publish')] },
    async (request, reply) => {
      const auth = request.auth;
      if (auth === undefined) throw new ApiError(401, 'unauthorized');
      const body = parseOutcomeBody(request.body);
      if (body.step === 'register') {
        const row = await registerPrediction(pool, registry, auth, body.prediction);
        request.log.info(
          {
            prediction_id: row.prediction_id,
            protocol_ref: row.protocol_ref,
            horizon: isoDate(row.horizon),
          },
          'prediction registered',
        );
        reply.status(201);
        return toPrediction(row);
      }
      const { prediction, outcome } = await recordOutcome(pool, auth, body);
      request.log.info(
        {
          outcome_id: outcome.outcome_id,
          prediction_id: prediction.prediction_id,
          result: outcome.result,
          environment_changed: outcome.environment_changed,
        },
        'outcome recorded',
      );
      reply.status(201);
      return toOutcome(prediction, outcome);
    },
  );

  registerOperatorConsole(app, deps);
}
