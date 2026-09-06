// Durable jobs (ADR-0001): rows in `jobs`, one claim at a time per worker
// with `SELECT ... FOR UPDATE SKIP LOCKED`, bounded retries with exponential
// backoff, and an observable failure state. Nothing here knows what a job
// does; handlers are registered by kind (handlers.ts, wired in worker.ts).
//
// States: queued -> running -> done | queued (retry, run_after pushed back)
// | failed (after `maxAttempts`). A worker that dies mid-job leaves the row
// `running`; `recoverStale` re-queues such rows once their lock is older
// than `staleLockMs`. `attempts` is counted at claim time, so a crash loop
// also lands in `failed` instead of running forever.
//
// `last_error` and the logs carry our own error text and identifiers only
// (job id, kind, attempt count); a job payload is never logged.
import type { Pool, Queryable } from '../../db.js';
import { ulid } from '../../ulid.js';

export type JobState = 'queued' | 'running' | 'done' | 'failed';
export const JOB_STATES: readonly JobState[] = ['queued', 'running', 'done', 'failed'];

export interface JobRow {
  job_id: string;
  kind: string;
  idempotency_key: string;
  state: JobState;
  attempts: number;
  run_after: Date;
  payload: Record<string, unknown>;
  last_error: string | null;
  locked_at: Date | null;
  locked_by: string | null;
}

export interface EnqueueInput {
  kind: string;
  /** Unique across the table: a second enqueue with the same key is a no-op. */
  idempotency_key: string;
  payload?: Record<string, unknown>;
  run_after?: Date;
}

/** Insert a job unless its idempotency key already exists; returns whether it was created. */
export async function enqueueJob(
  db: Queryable,
  input: EnqueueInput,
): Promise<{ job_id: string; created: boolean }> {
  const jobId = ulid();
  const res = await db.query<{ job_id: string }>(
    `INSERT INTO jobs (job_id, kind, idempotency_key, payload, run_after)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING job_id`,
    [
      jobId,
      input.kind,
      input.idempotency_key,
      JSON.stringify(input.payload ?? {}),
      input.run_after ?? new Date(),
    ],
  );
  const inserted = res.rows[0];
  if (inserted !== undefined) return { job_id: inserted.job_id, created: true };
  const existing = await db.query<{ job_id: string }>(
    `SELECT job_id FROM jobs WHERE idempotency_key = $1`,
    [input.idempotency_key],
  );
  return { job_id: existing.rows[0]?.job_id ?? jobId, created: false };
}

export async function getJob(db: Queryable, jobId: string): Promise<JobRow | undefined> {
  const res = await db.query<JobRow>(
    `SELECT job_id, kind, idempotency_key, state, attempts, run_after, payload,
            last_error, locked_at, locked_by
       FROM jobs WHERE job_id = $1`,
    [jobId],
  );
  return res.rows[0];
}

export async function countQueued(db: Queryable): Promise<number> {
  const res = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM jobs WHERE state = 'queued' AND run_after <= now()`,
  );
  return Number(res.rows[0]?.n ?? 0);
}

export interface JobLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface JobContext {
  pool: Pool;
  log: JobLogger;
}

/** A handler returns a small summary (counts, ids) that is logged on success. */
export type JobHandler = (job: JobRow, ctx: JobContext) => Promise<Record<string, unknown> | void>;

/** Thrown by a handler to fail a job at once, without further retries. */
export class NonRetryableJobError extends Error {
  override name = 'NonRetryableJobError';
}

export interface JobRunnerOptions {
  handlers: Record<string, JobHandler>;
  /** Identifies this worker in `locked_by`; defaults to host and pid. */
  workerId?: string;
  /** Attempts before a job is `failed` (default 5). */
  maxAttempts?: number;
  /** First retry delay; doubles per attempt (default 1000 ms). */
  backoffMs?: number;
  /** Upper bound on one retry delay (default 1 hour). */
  maxBackoffMs?: number;
  /** A `running` job locked longer than this is re-queued (default 10 minutes). */
  staleLockMs?: number;
  log?: JobLogger;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BACKOFF_MS = 1000;
export const DEFAULT_MAX_BACKOFF_MS = 60 * 60 * 1000;
export const DEFAULT_STALE_LOCK_MS = 10 * 60 * 1000;

const silent: JobLogger = { info() {}, warn() {}, error() {} };

/** Retry delay for the attempt that just failed (1-based): backoff * 2^(attempt-1), capped. */
export function retryDelayMs(attempt: number, backoffMs: number, maxBackoffMs: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(maxBackoffMs, backoffMs * 2 ** exponent);
}

function errorText(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : `Error: ${String(err)}`;
  return text.length > 1000 ? text.slice(0, 1000) : text;
}

export class JobRunner {
  readonly workerId: string;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly maxBackoffMs: number;
  readonly staleLockMs: number;
  private readonly handlers: Record<string, JobHandler>;
  private readonly log: JobLogger;

  constructor(
    private readonly pool: Pool,
    options: JobRunnerOptions,
  ) {
    this.handlers = options.handlers;
    this.workerId = options.workerId ?? `${process.env['HOSTNAME'] ?? 'worker'}:${process.pid}`;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.log = options.log ?? silent;
  }

  /** Re-queue `running` jobs whose worker went away; returns how many. */
  async recoverStale(): Promise<number> {
    const res = await this.pool.query(
      `UPDATE jobs SET state = 'queued', locked_at = NULL, locked_by = NULL, updated_at = now()
        WHERE state = 'running' AND locked_at IS NOT NULL
          AND locked_at < now() - ($1::text || ' milliseconds')::interval`,
      [String(this.staleLockMs)],
    );
    const n = res.rowCount ?? 0;
    if (n > 0) this.log.warn({ recovered: n }, 'stale running jobs re-queued');
    return n;
  }

  /**
   * Claim the next runnable job. One statement: the sub-select locks the row
   * with SKIP LOCKED so two workers never pick the same job, and the UPDATE
   * that marks it `running` commits with the lock, so once visible to anyone
   * else it is already out of the queue.
   */
  async claim(): Promise<JobRow | undefined> {
    const res = await this.pool.query<JobRow>(
      `WITH next AS (
         SELECT job_id FROM jobs
          WHERE state = 'queued' AND run_after <= now()
          ORDER BY run_after, created_at, job_id
          LIMIT 1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE jobs j
          SET state = 'running', attempts = j.attempts + 1, locked_at = now(), locked_by = $1,
              updated_at = now()
         FROM next
        WHERE j.job_id = next.job_id
       RETURNING j.job_id, j.kind, j.idempotency_key, j.state, j.attempts, j.run_after,
                 j.payload, j.last_error, j.locked_at, j.locked_by`,
      [this.workerId],
    );
    return res.rows[0];
  }

  private async settleDone(job: JobRow): Promise<void> {
    await this.pool.query(
      `UPDATE jobs SET state = 'done', locked_at = NULL, locked_by = NULL, last_error = NULL,
              updated_at = now()
        WHERE job_id = $1`,
      [job.job_id],
    );
  }

  private async settleFailure(job: JobRow, err: unknown): Promise<'retry' | 'failed'> {
    const text = errorText(err);
    const exhausted = job.attempts >= this.maxAttempts || err instanceof NonRetryableJobError;
    if (exhausted) {
      await this.pool.query(
        `UPDATE jobs SET state = 'failed', locked_at = NULL, locked_by = NULL, last_error = $2,
                updated_at = now()
          WHERE job_id = $1`,
        [job.job_id, text],
      );
      return 'failed';
    }
    const delay = retryDelayMs(job.attempts, this.backoffMs, this.maxBackoffMs);
    await this.pool.query(
      `UPDATE jobs SET state = 'queued', locked_at = NULL, locked_by = NULL, last_error = $2,
              run_after = now() + ($3::text || ' milliseconds')::interval, updated_at = now()
        WHERE job_id = $1`,
      [job.job_id, text, String(delay)],
    );
    return 'retry';
  }

  /** Claim and execute one job; `empty` when nothing is runnable now. */
  async runOne(): Promise<'ran' | 'empty'> {
    const job = await this.claim();
    if (job === undefined) return 'empty';
    const handler = this.handlers[job.kind];
    const base = { job_id: job.job_id, kind: job.kind, attempts: job.attempts };
    try {
      if (handler === undefined) {
        throw new NonRetryableJobError(`unknown job kind: ${job.kind}`);
      }
      const summary = await handler(job, { pool: this.pool, log: this.log });
      await this.settleDone(job);
      this.log.info({ ...base, ...(summary ?? {}) }, 'job done');
    } catch (err) {
      const outcome = await this.settleFailure(job, err);
      const detail = { ...base, err: errorText(err) };
      if (outcome === 'failed') this.log.error(detail, 'job failed');
      else this.log.warn(detail, 'job retry scheduled');
    }
    return 'ran';
  }

  /** Run jobs until nothing is runnable now (retries scheduled in the future are left). */
  async drain(signal?: AbortSignal): Promise<number> {
    let ran = 0;
    while (signal?.aborted !== true) {
      const outcome = await this.runOne();
      if (outcome === 'empty') break;
      ran += 1;
    }
    return ran;
  }
}
