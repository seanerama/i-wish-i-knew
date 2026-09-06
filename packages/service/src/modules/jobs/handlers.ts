// The first real job kinds (stage 7):
//
//   reap_previews     delete expired evidence.previews rows
//   withdrawal_apply  re-assert the withdrawn marks of one withdrawal and
//                     evict revision-keyed cache rows the withdrawal made
//                     stale (the API marks runs synchronously; this job is
//                     the durable place for derived state)
//   sharing_backfill  set evidence.runs.sharing_policy from the decrypted
//                     body for rows that predate the stage 7 migration
//                     (backfill_version NULL); intake fills new rows itself
//
// Maintenance kinds are enqueued by the worker itself on every tick with an
// idempotency key per time bucket, so any number of workers (or cron runs
// with --once) schedule each of them once.
import type { Run } from '@iwik/contracts';
import type { Pool, Queryable } from '../../db.js';
import type { Envelope } from '../crypto/index.js';
import { enqueueJob } from './index.js';
import type { JobHandler } from './index.js';

export const REAP_PREVIEWS = 'reap_previews';
export const WITHDRAWAL_APPLY = 'withdrawal_apply';
export const SHARING_BACKFILL = 'sharing_backfill';

/** Rows that carry a trustworthy `sharing_policy` column have this version. */
export const SHARING_BACKFILL_VERSION = 1;

/** One reap per hour is plenty: previews live one hour and expire on read anyway. */
export const REAP_BUCKET_MS = 60 * 60 * 1000;
const BACKFILL_BATCH = 100;

export function reapIdempotencyKey(now: number = Date.now()): string {
  return `${REAP_PREVIEWS}:${Math.floor(now / REAP_BUCKET_MS)}`;
}

export function withdrawalIdempotencyKey(withdrawalId: string): string {
  return `${WITHDRAWAL_APPLY}:${withdrawalId}`;
}

export const SHARING_BACKFILL_KEY = `${SHARING_BACKFILL}:v${SHARING_BACKFILL_VERSION}`;

export async function reapPreviews(db: Queryable): Promise<number> {
  const res = await db.query(`DELETE FROM evidence.previews WHERE expires_at < now()`);
  return res.rowCount ?? 0;
}

export interface WithdrawalApplied {
  withdrawal_id: string;
  marked: number;
  evicted: number;
}

/** Idempotent: marks are COALESCEd, and the eviction is bounded by the effective revision. */
export async function applyWithdrawal(
  db: Queryable,
  withdrawalId: string,
): Promise<WithdrawalApplied | undefined> {
  const found = await db.query<{
    org_ref: string;
    run_ids: string[];
    requested_at: Date;
    effective_revision: string | number;
  }>(
    `SELECT org_ref, run_ids, requested_at, effective_revision
       FROM evidence.withdrawals WHERE withdrawal_id = $1`,
    [withdrawalId],
  );
  const w = found.rows[0];
  if (w === undefined) return undefined;
  const revision = Number(w.effective_revision);
  const marked = await db.query(
    `UPDATE evidence.runs
        SET withdrawn_at = COALESCE(withdrawn_at, $3),
            withdrawn_revision = COALESCE(withdrawn_revision, $4)
      WHERE org_ref = $1 AND run_id = ANY($2::text[])
        AND (withdrawn_at IS NULL OR withdrawn_revision IS NULL)`,
    [w.org_ref, w.run_ids, w.requested_at, revision],
  );
  const evicted = await db.query(
    `DELETE FROM evidence.cache
      WHERE revision < $2
        AND protocol_ref IN (
          SELECT DISTINCT protocol_ref FROM evidence.runs
           WHERE org_ref = $1 AND run_id = ANY($3::text[]))`,
    [w.org_ref, revision, w.run_ids],
  );
  return {
    withdrawal_id: withdrawalId,
    marked: marked.rowCount ?? 0,
    evicted: evicted.rowCount ?? 0,
  };
}

/** True while any run row still has an untrusted `sharing_policy`. */
export async function backfillPending(db: Queryable): Promise<boolean> {
  const res = await db.query(`SELECT 1 FROM evidence.runs WHERE backfill_version IS NULL LIMIT 1`);
  return res.rows.length > 0;
}

/**
 * Decrypt each pending row and set its column. Batches of BATCH rows, each
 * batch in its own statement pair; rerunning after a crash continues where
 * the last committed batch left off.
 */
export async function backfillSharingPolicy(
  pool: Pool,
  envelope: Envelope,
): Promise<{ updated: number }> {
  let updated = 0;
  for (;;) {
    const batch = await pool.query<{
      run_id: string;
      org_ref: string;
      key_id: string;
      body_ciphertext: Buffer;
    }>(
      `SELECT run_id, org_ref, key_id, body_ciphertext FROM evidence.runs
        WHERE backfill_version IS NULL ORDER BY received_at, run_id LIMIT $1`,
      [BACKFILL_BATCH],
    );
    if (batch.rows.length === 0) return { updated };
    for (const row of batch.rows) {
      const plaintext = await envelope.open(row.org_ref, row.key_id, row.body_ciphertext);
      const run = JSON.parse(plaintext.toString('utf8')) as Run;
      const policy = run.submission.sharing_policy === 'cooperative' ? 'cooperative' : 'private';
      const res = await pool.query(
        `UPDATE evidence.runs SET sharing_policy = $2, backfill_version = $3
          WHERE run_id = $1 AND backfill_version IS NULL`,
        [row.run_id, policy, SHARING_BACKFILL_VERSION],
      );
      updated += res.rowCount ?? 0;
    }
  }
}

/**
 * Schedule the maintenance kinds for this tick: one reap per hour bucket and
 * the backfill once, only while rows still need it.
 */
export async function ensureMaintenanceJobs(
  db: Pool,
  now: number = Date.now(),
): Promise<{ reap: boolean; backfill: boolean }> {
  const reap = await enqueueJob(db, {
    kind: REAP_PREVIEWS,
    idempotency_key: reapIdempotencyKey(now),
  });
  let backfill = { created: false };
  if (await backfillPending(db)) {
    backfill = await enqueueJob(db, {
      kind: SHARING_BACKFILL,
      idempotency_key: SHARING_BACKFILL_KEY,
    });
  }
  return { reap: reap.created, backfill: backfill.created };
}

export interface HandlerDeps {
  envelope: Envelope;
}

export function buildHandlers(deps: HandlerDeps): Record<string, JobHandler> {
  return {
    [REAP_PREVIEWS]: async (_job, ctx) => ({ reaped: await reapPreviews(ctx.pool) }),
    [WITHDRAWAL_APPLY]: async (job, ctx) => {
      const id = job.payload['withdrawal_id'];
      if (typeof id !== 'string') throw new Error('withdrawal_apply payload lacks withdrawal_id');
      const applied = await applyWithdrawal(ctx.pool, id);
      if (applied === undefined) throw new Error('withdrawal row not found');
      return { ...applied };
    },
    [SHARING_BACKFILL]: async (_job, ctx) => backfillSharingPolicy(ctx.pool, deps.envelope),
  };
}
