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
//   index_backfill    (stage 8) project measurement_digest, node_id,
//                     index_context, is_fixture from the decrypted body for
//                     rows that predate the stage 8 migration (index_version
//                     NULL), then rebuild the contributions ledger; with
//                     IWIK_FEATURE_DEDUPE on it also marks same-organization
//                     duplicates and shared-source suspects
//
// Maintenance kinds are enqueued by the worker itself on every tick with an
// idempotency key per time bucket, so any number of workers (or cron runs
// with --once) schedule each of them once.
import type { Run } from '@iwik/contracts';
import type { Config } from '../../config.js';
import type { Pool, Queryable } from '../../db.js';
import { repairContributions } from '../cohort/contributions.js';
import type { Envelope } from '../crypto/index.js';
import {
  INDEX_VERSION,
  isFixtureRun,
  measurementDigest,
  projectIndexContext,
  redactProjection,
} from '../intake/projection.js';
import type { Registry } from '../registry/index.js';
import { enqueueJob } from './index.js';
import type { JobHandler } from './index.js';

export const REAP_PREVIEWS = 'reap_previews';
export const WITHDRAWAL_APPLY = 'withdrawal_apply';
export const SHARING_BACKFILL = 'sharing_backfill';
export const INDEX_BACKFILL = 'index_backfill';

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
export const INDEX_BACKFILL_KEY = `${INDEX_BACKFILL}:v${INDEX_VERSION}`;

/**
 * A stored body that does not parse is reported with this fixed text and
 * nothing else: `last_error` and the logs must never carry plaintext.
 */
export const BODY_NOT_JSON = 'stored run body is not valid JSON';

export function parseStoredRun(plaintext: Buffer): Run {
  try {
    return JSON.parse(plaintext.toString('utf8')) as Run;
  } catch {
    throw new Error(BODY_NOT_JSON);
  }
}

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
      const run = parseStoredRun(plaintext);
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

/** True while any run row still lacks its index projection (stage 8). */
export async function indexBackfillPending(db: Queryable): Promise<boolean> {
  const res = await db.query(`SELECT 1 FROM evidence.runs WHERE index_version IS NULL LIMIT 1`);
  return res.rows.length > 0;
}

export interface IndexBackfillSummary {
  projected: number;
  /** Projected values that failed the current secret rescan or length limit, stored as null/unknown. */
  redacted: number;
  /** Rows whose protocol the registry does not know: projected with an empty index_context. */
  unknown_protocol: number;
  /** Rows that could not be decrypted or parsed; left unprojected, the job fails at the end. */
  failed: number;
  duplicates_marked: number;
  suspects_marked: number;
  ledger_rows: number;
}

export interface IndexBackfillOptions {
  sanitize: { maxStringLength: number; extraPatterns: readonly string[] };
  /** IWIK_FEATURE_DEDUPE: mark duplicates and shared-source suspects among projected rows. */
  dedupe: boolean;
}

/**
 * Decrypt each row with `index_version IS NULL`, write its projection, then
 * rebuild the ledger. Keyset-paginated so a row that cannot be projected is
 * skipped rather than retried forever; the job fails at the end with a
 * fixed message (never the body) when any row was skipped, and the next run
 * picks the skipped rows up again. Every UPDATE is guarded by
 * `index_version IS NULL`, so a rerun after a crash continues where the
 * last committed row left off.
 */
export async function backfillIndex(
  pool: Pool,
  envelope: Envelope,
  registry: Registry,
  options: IndexBackfillOptions,
  log?: { warn(obj: Record<string, unknown>, msg: string): void },
): Promise<IndexBackfillSummary> {
  const summary: IndexBackfillSummary = {
    projected: 0,
    redacted: 0,
    unknown_protocol: 0,
    failed: 0,
    duplicates_marked: 0,
    suspects_marked: 0,
    ledger_rows: 0,
  };
  let after: { received_at: Date; run_id: string } | undefined;
  for (;;) {
    const batch = await pool.query<{
      run_id: string;
      org_ref: string;
      protocol_ref: string;
      key_id: string;
      body_ciphertext: Buffer;
      received_at: Date;
    }>(
      `SELECT run_id, org_ref, protocol_ref, key_id, body_ciphertext, received_at
         FROM evidence.runs
        WHERE index_version IS NULL
          AND ($1::timestamptz IS NULL OR (received_at, run_id) > ($1::timestamptz, $2::text))
        ORDER BY received_at, run_id LIMIT $3`,
      [after?.received_at ?? null, after?.run_id ?? '', BACKFILL_BATCH],
    );
    if (batch.rows.length === 0) break;
    for (const row of batch.rows) {
      after = { received_at: row.received_at, run_id: row.run_id };
      let run: Run;
      try {
        run = parseStoredRun(await envelope.open(row.org_ref, row.key_id, row.body_ciphertext));
      } catch (err) {
        summary.failed += 1;
        // The run id and our own error text only.
        log?.warn(
          { run_id: row.run_id, reason: err instanceof Error ? err.message : 'unknown' },
          'index_backfill: row skipped',
        );
        continue;
      }
      const entry = registry.get(row.protocol_ref);
      if (entry === undefined) summary.unknown_protocol += 1;
      const projection = projectIndexContext(
        run,
        entry?.protocol.required_context ?? [],
        options.sanitize,
      );
      summary.redacted += projection.issues.length;
      const res = await pool.query(
        `UPDATE evidence.runs
            SET measurement_digest = $2, node_id = $3, index_context = $4, is_fixture = $5,
                index_version = $6
          WHERE run_id = $1 AND index_version IS NULL`,
        [
          row.run_id,
          measurementDigest(run),
          run.node_id,
          JSON.stringify(redactProjection(projection)),
          isFixtureRun(run),
          INDEX_VERSION,
        ],
      );
      summary.projected += res.rowCount ?? 0;
    }
  }

  if (options.dedupe) {
    // Same organization, same measurement: the original is the earliest row
    // that is not withdrawn (intake never matches a withdrawn row), and every
    // row received after it, withdrawn since or not, is a duplicate of it.
    // Rows received before the original were fresh when accepted and stay so.
    const dups = await pool.query(
      `UPDATE evidence.runs r SET duplicate_of = f.run_id
         FROM (SELECT DISTINCT ON (protocol_ref, org_ref, measurement_digest)
                      protocol_ref, org_ref, measurement_digest, run_id, received_at
                 FROM evidence.runs
                WHERE index_version IS NOT NULL AND withdrawn_at IS NULL
                  AND duplicate_of IS NULL
                ORDER BY protocol_ref, org_ref, measurement_digest, received_at, run_id) f
        WHERE r.protocol_ref = f.protocol_ref AND r.org_ref = f.org_ref
          AND r.measurement_digest = f.measurement_digest
          AND (r.received_at, r.run_id) > (f.received_at, f.run_id)
          AND r.index_version IS NOT NULL AND r.duplicate_of IS NULL`,
    );
    summary.duplicates_marked = dups.rowCount ?? 0;
    const suspects = await pool.query(
      `UPDATE evidence.runs r SET shared_source_suspect = true
         FROM (SELECT protocol_ref, measurement_digest
                 FROM evidence.runs
                WHERE index_version IS NOT NULL AND withdrawn_at IS NULL
                GROUP BY protocol_ref, measurement_digest
               HAVING count(DISTINCT org_ref) > 1) s
        WHERE r.protocol_ref = s.protocol_ref AND r.measurement_digest = s.measurement_digest
          AND r.shared_source_suspect = false`,
    );
    summary.suspects_marked = suspects.rowCount ?? 0;
  }
  summary.ledger_rows = await repairContributions(pool);
  if (summary.failed > 0) {
    throw new Error(`index_backfill: ${summary.failed} row(s) could not be projected`);
  }
  return summary;
}

/**
 * Schedule the maintenance kinds for this tick: one reap per hour bucket and
 * each backfill once, only while rows still need it.
 */
export async function ensureMaintenanceJobs(
  db: Pool,
  now: number = Date.now(),
): Promise<{ reap: boolean; backfill: boolean; index_backfill: boolean }> {
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
  let indexBackfill = { created: false };
  if (await indexBackfillPending(db)) {
    indexBackfill = await enqueueJob(db, {
      kind: INDEX_BACKFILL,
      idempotency_key: INDEX_BACKFILL_KEY,
    });
  }
  return { reap: reap.created, backfill: backfill.created, index_backfill: indexBackfill.created };
}

export interface HandlerDeps {
  envelope: Envelope;
  /** Which context keys index_backfill may project, per protocol. */
  registry: Registry;
  config: Pick<Config, 'featureDedupe' | 'maxStringLength' | 'extraSecretPatterns'>;
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
    [INDEX_BACKFILL]: async (_job, ctx) => ({
      ...(await backfillIndex(
        ctx.pool,
        deps.envelope,
        deps.registry,
        {
          sanitize: {
            maxStringLength: deps.config.maxStringLength,
            extraPatterns: deps.config.extraSecretPatterns,
          },
          dedupe: deps.config.featureDedupe,
        },
        ctx.log,
      )),
    }),
  };
}
