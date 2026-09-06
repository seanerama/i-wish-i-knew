// Withdrawal (ADR-0002 §6, contracts/member-api.md `POST /v1/withdrawals`),
// behind IWIK_FEATURE_WITHDRAWAL (default off: the endpoint and the console
// form answer 404 with code feature_disabled before any authentication).
//
// A member withdraws its own runs. The request is serialized on the same
// `evidence.revision` FOR UPDATE lock intake uses, so a withdrawal is one
// revision increment ordered with every accepted run; the runs are marked
// `withdrawn_at` / `withdrawn_revision` in that transaction (so the effect
// is immediate) and a `withdrawal_apply` job is queued for the derived
// state (cache eviction, and whatever later stages derive). Every run id
// must belong to the caller's organization: a set with any foreign or
// unknown id is 404 not_found as a whole, and the response never says which
// id was the problem. The same set (any order, duplicates ignored) is the
// same withdrawal: the original id and revision come back with 200.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { Pool, Queryable } from '../../db.js';
import { withTransaction } from '../../db.js';
import { ApiError } from '../../errors.js';
import type { ErrorDetail } from '../../errors.js';
import { ULID_PATTERN, ulid } from '../../ulid.js';
import { requireCsrf, resolveSession } from '../console/session.js';
import { nodeIsRevoked, requireScope } from '../identity/index.js';
import { enqueueJob } from '../jobs/index.js';
import { WITHDRAWAL_APPLY, withdrawalIdempotencyKey } from '../jobs/handlers.js';

export const REASON_CODES = ['member_request', 'data_error', 'policy_change'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);
}

/** At most this many run ids per request (the console form and the tool share it). */
export const MAX_RUN_IDS = 100;

export interface WithdrawalDeps {
  pool: Pool;
  config: Config;
}

export interface WithdrawalRequest {
  org_ref: string;
  run_ids: readonly string[];
  reason_code: ReasonCode;
  /** When set (API path), the node must still be unrevoked inside the transaction. */
  node_id?: string;
}

export interface WithdrawalResult {
  withdrawal_id: string;
  effective_revision: number;
  /** False when the same set was already withdrawn by this organization. */
  created: boolean;
}

/** Sorted, de-duplicated: the stored form of a set and the idempotency key. */
export function normalizeRunIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Pre-handler: 404 feature_disabled unless the flag is on; runs before auth. */
export function requireWithdrawal(
  config: Config,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async () => {
    if (!config.featureWithdrawal) throw new ApiError(404, 'feature_disabled');
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate the JSON body; issues carry paths and rules only. */
export function parseWithdrawalBody(body: unknown): { run_ids: string[]; reason_code: ReasonCode } {
  const issues: ErrorDetail[] = [];
  if (!isObject(body)) {
    throw new ApiError(422, 'validation_failed', { details: [{ path: '', rule: 'type' }] });
  }
  for (const key of Object.keys(body)) {
    if (key !== 'run_ids' && key !== 'reason_code') {
      issues.push({ path: '', rule: 'additionalProperties' });
    }
  }
  const ids = body['run_ids'];
  if (!Array.isArray(ids)) {
    issues.push({ path: '/run_ids', rule: ids === undefined ? 'required' : 'type' });
  } else {
    if (ids.length === 0) issues.push({ path: '/run_ids', rule: 'minItems' });
    if (ids.length > MAX_RUN_IDS) issues.push({ path: '/run_ids', rule: 'maxItems' });
    ids.forEach((id, i) => {
      if (typeof id !== 'string' || !ULID_PATTERN.test(id)) {
        issues.push({ path: `/run_ids/${i}`, rule: 'pattern' });
      }
    });
  }
  const reason = body['reason_code'];
  if (reason === undefined) issues.push({ path: '/reason_code', rule: 'required' });
  else if (!isReasonCode(reason)) issues.push({ path: '/reason_code', rule: 'enum' });
  if (issues.length > 0) throw new ApiError(422, 'validation_failed', { details: issues });
  return { run_ids: normalizeRunIds(ids as string[]), reason_code: reason as ReasonCode };
}

/**
 * The withdrawal itself, shared by the API and the console. Throws
 * 404 not_found when any id is not one of the organization's runs and
 * 401 node_revoked when the requesting node was revoked meanwhile.
 */
export async function withdrawRuns(
  pool: Pool,
  request: WithdrawalRequest,
): Promise<WithdrawalResult> {
  const runIds = normalizeRunIds(request.run_ids);
  if (runIds.length === 0 || runIds.length > MAX_RUN_IDS) {
    throw new ApiError(422, 'validation_failed', {
      details: [{ path: '/run_ids', rule: runIds.length === 0 ? 'minItems' : 'maxItems' }],
    });
  }
  return withTransaction(pool, async (client) => {
    // The same singleton lock intake takes: withdrawals and accepted runs
    // form one ordered sequence of revisions.
    await client.query(`SELECT revision FROM evidence.revision WHERE singleton FOR UPDATE`);
    if (request.node_id !== undefined && (await nodeIsRevoked(client, request.node_id))) {
      throw new ApiError(401, 'node_revoked');
    }
    const owned = await client.query<{ run_id: string; protocol_ref: string }>(
      `SELECT run_id, protocol_ref FROM evidence.runs
        WHERE org_ref = $1 AND run_id = ANY($2::text[])`,
      [request.org_ref, runIds],
    );
    if (owned.rows.length !== runIds.length) throw new ApiError(404, 'not_found');

    const prior = await client.query<{
      withdrawal_id: string;
      effective_revision: string | number;
    }>(
      `SELECT withdrawal_id, effective_revision FROM evidence.withdrawals
        WHERE org_ref = $1 AND run_ids = $2::text[]`,
      [request.org_ref, runIds],
    );
    const existing = prior.rows[0];
    if (existing !== undefined) {
      return {
        withdrawal_id: existing.withdrawal_id,
        effective_revision: Number(existing.effective_revision),
        created: false,
      };
    }

    const bumped = await client.query<{ revision: string | number }>(
      `UPDATE evidence.revision SET revision = revision + 1, updated_at = now()
        WHERE singleton RETURNING revision`,
    );
    const revision = Number(bumped.rows[0]?.revision ?? 0);
    const withdrawalId = ulid();
    await client.query(
      `INSERT INTO evidence.withdrawals
         (withdrawal_id, org_ref, run_ids, reason_code, effective_revision)
       VALUES ($1, $2, $3::text[], $4, $5)`,
      [withdrawalId, request.org_ref, runIds, request.reason_code, revision],
    );
    // Runs withdrawn by an earlier request keep their earlier marks.
    await client.query(
      `UPDATE evidence.runs SET withdrawn_at = now(), withdrawn_revision = $3
        WHERE org_ref = $1 AND run_id = ANY($2::text[]) AND withdrawn_at IS NULL`,
      [request.org_ref, runIds, revision],
    );
    const protocols = [...new Set(owned.rows.map((r) => r.protocol_ref))];
    await client.query(
      `INSERT INTO evidence.revision_log (revision, protocol_ref, kind)
       SELECT $1, unnest($2::text[]), 'withdrawal'`,
      [revision, protocols],
    );
    await enqueueJob(client, {
      kind: WITHDRAWAL_APPLY,
      idempotency_key: withdrawalIdempotencyKey(withdrawalId),
      payload: { withdrawal_id: withdrawalId },
    });
    return { withdrawal_id: withdrawalId, effective_revision: revision, created: true };
  });
}

export interface OwnRun {
  run_id: string;
  protocol_ref: string;
  execution_status: string;
  received_at: Date;
  evidence_revision: number;
  /** Null until the backfill has confirmed the column (never trust it before). */
  sharing_policy: 'private' | 'cooperative' | null;
  withdrawn_at: Date | null;
  withdrawn_revision: number | null;
}

/** The organization's own runs, newest first, for the console. */
export async function listOwnRuns(db: Queryable, orgRef: string, limit = 200): Promise<OwnRun[]> {
  const res = await db.query<{
    run_id: string;
    protocol_ref: string;
    execution_status: string;
    received_at: Date;
    evidence_revision: string | number;
    sharing_policy: string;
    backfill_version: number | null;
    withdrawn_at: Date | null;
    withdrawn_revision: string | number | null;
  }>(
    `SELECT run_id, protocol_ref, execution_status, received_at, evidence_revision,
            sharing_policy, backfill_version, withdrawn_at, withdrawn_revision
       FROM evidence.runs WHERE org_ref = $1
      ORDER BY received_at DESC, run_id DESC LIMIT $2`,
    [orgRef, limit],
  );
  return res.rows.map((r) => ({
    run_id: r.run_id,
    protocol_ref: r.protocol_ref,
    execution_status: r.execution_status,
    received_at: r.received_at,
    evidence_revision: Number(r.evidence_revision),
    sharing_policy:
      r.backfill_version === null
        ? null
        : r.sharing_policy === 'cooperative'
          ? 'cooperative'
          : 'private',
    withdrawn_at: r.withdrawn_at,
    withdrawn_revision: r.withdrawn_revision === null ? null : Number(r.withdrawn_revision),
  }));
}

export async function orgRefOf(db: Queryable, orgId: string): Promise<string | undefined> {
  const res = await db.query<{ org_ref: string }>(
    `SELECT org_ref FROM identity.org_refs WHERE org_id = $1`,
    [orgId],
  );
  return res.rows[0]?.org_ref;
}

/** Run ids from the console form: repeated `run_ids` fields or `run_<id>=on` checkboxes. */
export function formRunIds(body: unknown): string[] {
  if (!isObject(body)) return [];
  const out: string[] = [];
  const listed = body['run_ids'];
  for (const value of Array.isArray(listed) ? listed : [listed]) {
    if (typeof value === 'string' && ULID_PATTERN.test(value)) out.push(value);
  }
  for (const [key, value] of Object.entries(body)) {
    if (!key.startsWith('run_') || key === 'run_ids') continue;
    const id = key.slice(4);
    if (ULID_PATTERN.test(id) && (value === 'on' || value === 'true' || value === '1')) {
      out.push(id);
    }
  }
  return normalizeRunIds(out);
}

export function registerWithdrawalRoutes(app: FastifyInstance, deps: WithdrawalDeps): void {
  const { pool, config } = deps;
  const gate = requireWithdrawal(config);

  app.post(
    '/v1/withdrawals',
    { preHandler: [gate, requireScope('publish')] },
    async (request, reply) => {
      const auth = request.auth;
      if (auth === undefined) throw new ApiError(401, 'unauthorized');
      const body = parseWithdrawalBody(request.body);
      const result = await withdrawRuns(pool, {
        org_ref: auth.org_ref,
        run_ids: body.run_ids,
        reason_code: body.reason_code,
        node_id: auth.node_id,
      });
      request.log.info(
        {
          withdrawal_id: result.withdrawal_id,
          effective_revision: result.effective_revision,
          runs: body.run_ids.length,
          reason_code: body.reason_code,
        },
        result.created ? 'withdrawal recorded' : 'withdrawal already recorded',
      );
      reply.status(result.created ? 201 : 200);
      return {
        withdrawal_id: result.withdrawal_id,
        effective_revision: result.effective_revision,
      };
    },
  );

  // Console form (enrollment console, /org). Both flags must be on: the
  // enrollment gate owns /org, this one owns withdrawal.
  app.post(
    '/org/withdrawals',
    {
      preHandler: [
        async () => {
          if (!config.featureEnrollment) throw new ApiError(404, 'not_found');
        },
        gate,
      ],
    },
    async (request, reply) => {
      requireCsrf(request, config);
      const session = await resolveSession(request, config, pool);
      if (session?.kind !== 'org') return reply.redirect('/console/login', 303);
      const body = request.body;
      const confirmed = isObject(body) && body['confirm'] === 'on';
      const runIds = formRunIds(body);
      const reason = isObject(body) ? body['reason_code'] : undefined;
      if (runIds.length === 0) return reply.redirect('/org?error=withdraw_runs', 303);
      if (runIds.length > MAX_RUN_IDS) return reply.redirect('/org?error=withdraw_runs', 303);
      if (!isReasonCode(reason)) return reply.redirect('/org?error=withdraw_reason', 303);
      if (!confirmed) return reply.redirect('/org?error=withdraw_confirm', 303);
      const orgRef = await orgRefOf(pool, session.org_id);
      if (orgRef === undefined) return reply.redirect('/org?error=withdraw_runs', 303);
      let result: WithdrawalResult;
      try {
        result = await withdrawRuns(pool, {
          org_ref: orgRef,
          run_ids: runIds,
          reason_code: reason,
        });
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          request.log.info('console withdrawal refused: run not owned');
          return reply.redirect('/org?error=withdraw_runs', 303);
        }
        throw err;
      }
      request.log.info(
        {
          withdrawal_id: result.withdrawal_id,
          effective_revision: result.effective_revision,
          runs: runIds.length,
          reason_code: reason,
        },
        result.created ? 'withdrawal recorded' : 'withdrawal already recorded',
      );
      return reply.redirect(
        result.created ? '/org?notice=withdrawn' : '/org?notice=already_withdrawn',
        303,
      );
    },
  );
}
