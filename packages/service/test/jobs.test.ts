// Stage 7 worker: the job loop in process. Idempotent enqueue, reaping of
// expired previews, bounded retries with backoff ending in `failed` with
// `last_error`, SKIP LOCKED between two workers on one queue, stale-lock
// recovery, and the sharing_policy backfill from decrypted bodies.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  REAP_PREVIEWS,
  SHARING_BACKFILL,
  SHARING_BACKFILL_KEY,
  backfillPending,
  buildHandlers,
  ensureMaintenanceJobs,
  reapIdempotencyKey,
} from '../src/modules/jobs/handlers.js';
import {
  JobRunner,
  NonRetryableJobError,
  countQueued,
  enqueueJob,
  getJob,
  retryDelayMs,
} from '../src/modules/jobs/index.js';
import type { JobRow } from '../src/modules/jobs/index.js';
import { ulid } from '../src/ulid.js';
import { bootApp, prepareRun, submitRun } from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;

before(async () => {
  t = await bootApp();
});

after(async () => {
  await t.app.close();
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function stateOf(jobId: string) {
  const job = await getJob(t.app.iwik.pool, jobId);
  assert.ok(job);
  return job;
}

test('enqueue is idempotent on idempotency_key; the retry curve is exponential and capped', async () => {
  const key = `test:${ulid()}`;
  const first = await enqueueJob(t.app.iwik.pool, { kind: 'noop', idempotency_key: key });
  const second = await enqueueJob(t.app.iwik.pool, { kind: 'noop', idempotency_key: key });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job_id, first.job_id);
  const rows = await t.app.iwik.pool.query(`SELECT 1 FROM jobs WHERE idempotency_key = $1`, [key]);
  assert.equal(rows.rows.length, 1);
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((n) => retryDelayMs(n, 100, 60_000)),
    [100, 200, 400, 800, 1600],
  );
  assert.equal(retryDelayMs(20, 100, 60_000), 60_000);
  await t.app.iwik.pool.query(`DELETE FROM jobs WHERE job_id = $1`, [first.job_id]);
});

test('reap_previews deletes expired previews and keeps unexpired ones', async () => {
  const pool = t.app.iwik.pool;
  await pool.query(
    `INSERT INTO evidence.previews (preview_id, org_ref, content_digest, expires_at) VALUES
       ($1, 'org', 'sha256:a', now() - interval '1 minute'),
       ($2, 'org', 'sha256:b', now() - interval '1 day'),
       ($3, 'org', 'sha256:c', now() + interval '1 hour')`,
    [ulid(), ulid(), ulid()],
  );
  const scheduled = await ensureMaintenanceJobs(pool);
  assert.equal(scheduled.reap, true);
  assert.equal(scheduled.backfill, false, 'no rows need a backfill');
  const again = await ensureMaintenanceJobs(pool);
  assert.equal(again.reap, false, 'one reap per hour bucket');
  const runner = new JobRunner(pool, {
    handlers: buildHandlers({ envelope: t.app.iwik.envelope }),
  });
  assert.equal(await runner.drain(), 1);
  const left = await pool.query<{ content_digest: string }>(
    `SELECT content_digest FROM evidence.previews ORDER BY content_digest`,
  );
  assert.deepEqual(
    left.rows.map((r) => r.content_digest),
    ['sha256:c'],
  );
  const job = await pool.query<{ state: string; attempts: number; last_error: string | null }>(
    `SELECT state, attempts, last_error FROM jobs WHERE idempotency_key = $1`,
    [reapIdempotencyKey()],
  );
  assert.deepEqual(job.rows, [{ state: 'done', attempts: 1, last_error: null }]);
  assert.equal(await countQueued(pool), 0);
});

test('a job that keeps throwing is retried with backoff and lands in failed with last_error after 5 attempts', async () => {
  const pool = t.app.iwik.pool;
  const attempts: number[] = [];
  // A generous backoff so the "not yet runnable" check cannot race the clock;
  // later attempts are brought forward with SQL instead of waiting.
  const runner = new JobRunner(pool, {
    backoffMs: 30_000,
    handlers: {
      async boom(job) {
        attempts.push(job.attempts);
        throw new Error(`boom on attempt ${job.attempts}`);
      },
    },
  });
  const { job_id } = await enqueueJob(pool, { kind: 'boom', idempotency_key: `boom:${ulid()}` });
  assert.equal(await runner.drain(), 1);
  let job = await stateOf(job_id);
  assert.equal(job.state, 'queued', 'retry scheduled');
  assert.equal(job.attempts, 1);
  assert.equal(job.last_error, 'Error: boom on attempt 1');
  assert.ok(job.run_after.getTime() > Date.now() + 20_000, 'run_after pushed back by the backoff');
  assert.equal(job.locked_by, null);
  assert.equal(await runner.drain(), 0, 'not runnable before its run_after');

  const delays: number[] = [];
  for (let i = 0; i < 6 && job.state !== 'failed'; i++) {
    const claimedAt = Date.now();
    await pool.query(`UPDATE jobs SET run_after = now() WHERE job_id = $1`, [job_id]);
    assert.equal(await runner.drain(), 1);
    job = await stateOf(job_id);
    if (job.state === 'queued') delays.push(job.run_after.getTime() - claimedAt);
  }
  // each retry waited longer than the previous one (30 s, 60 s, 120 s, 240 s minus test time)
  assert.equal(delays.length, 3, 'three retries were scheduled after the first');
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i]! > delays[i - 1]!, delays.join(','));
  assert.equal(job.state, 'failed');
  assert.equal(job.attempts, 5);
  assert.equal(job.last_error, 'Error: boom on attempt 5');
  assert.deepEqual(attempts, [1, 2, 3, 4, 5]);
  assert.equal(await runner.drain(), 0, 'a failed job is never picked up again');

  // an unknown kind fails at once, without retries; so does a NonRetryableJobError
  const unknown = await enqueueJob(pool, { kind: 'nobody', idempotency_key: `nobody:${ulid()}` });
  const fatal = await enqueueJob(pool, { kind: 'fatal', idempotency_key: `fatal:${ulid()}` });
  const strict = new JobRunner(pool, {
    handlers: {
      async fatal() {
        throw new NonRetryableJobError('bad payload');
      },
    },
  });
  assert.equal(await strict.drain(), 2);
  const u = await stateOf(unknown.job_id);
  assert.equal(u.state, 'failed');
  assert.equal(u.attempts, 1);
  assert.equal(u.last_error, 'NonRetryableJobError: unknown job kind: nobody');
  const f = await stateOf(fatal.job_id);
  assert.deepEqual(
    [f.state, f.attempts, f.last_error],
    ['failed', 1, 'NonRetryableJobError: bad payload'],
  );
});

test('two workers on one queue never run the same job (FOR UPDATE SKIP LOCKED)', async () => {
  const pool = t.app.iwik.pool;
  const ran = new Map<string, string[]>();
  const handlerFor = (worker: string) => ({
    async slow(job: JobRow) {
      ran.set(job.job_id, [...(ran.get(job.job_id) ?? []), worker]);
      await sleep(15);
      return { worker };
    },
  });
  const ids: string[] = [];
  for (let i = 0; i < 40; i++) {
    ids.push(
      (await enqueueJob(pool, { kind: 'slow', idempotency_key: `slow:${i}:${ulid()}` })).job_id,
    );
  }
  const a = new JobRunner(pool, { workerId: 'worker-a', handlers: handlerFor('a') });
  const b = new JobRunner(pool, { workerId: 'worker-b', handlers: handlerFor('b') });
  await Promise.all([a.drain(), b.drain()]);
  // count this test's jobs only (an earlier test may have left a retrying row)
  const byWorker = { a: 0, b: 0 };
  for (const id of ids) for (const w of ran.get(id) ?? []) byWorker[w as 'a' | 'b'] += 1;
  assert.equal(byWorker.a + byWorker.b, 40);
  assert.ok(
    byWorker.a > 0 && byWorker.b > 0,
    `both workers took jobs (${byWorker.a}/${byWorker.b})`,
  );
  for (const id of ids) {
    assert.deepEqual((ran.get(id) ?? []).length, 1, `job ${id} ran exactly once`);
    const job = await stateOf(id);
    assert.equal(job.state, 'done');
    assert.equal(job.attempts, 1);
    assert.equal(job.locked_by, null);
  }
});

test('a running job whose worker vanished is re-queued once its lock is stale', async () => {
  const pool = t.app.iwik.pool;
  const { job_id } = await enqueueJob(pool, { kind: 'noop', idempotency_key: `stale:${ulid()}` });
  await pool.query(
    `UPDATE jobs SET state = 'running', locked_by = 'dead-worker', attempts = 1,
            locked_at = now() - interval '11 minutes' WHERE job_id = $1`,
    [job_id],
  );
  const runner = new JobRunner(pool, { handlers: { noop: async () => ({}) } });
  assert.equal(await runner.drain(), 0, 'a running row is not claimable');
  assert.equal(await runner.recoverStale(), 1);
  const requeued = await stateOf(job_id);
  assert.equal(requeued.state, 'queued');
  assert.equal(requeued.locked_by, null);
  assert.equal(await runner.drain(), 1);
  const done = await stateOf(job_id);
  assert.equal(done.state, 'done');
  assert.equal(done.attempts, 2, 'the crashed attempt still counts');

  // a fresh lock is left alone
  const recent = await enqueueJob(pool, { kind: 'noop', idempotency_key: `fresh:${ulid()}` });
  await pool.query(
    `UPDATE jobs SET state = 'running', locked_by = 'busy-worker', locked_at = now() WHERE job_id = $1`,
    [recent.job_id],
  );
  assert.equal(await runner.recoverStale(), 0);
  await pool.query(
    `UPDATE jobs SET state = 'done', locked_by = NULL, locked_at = NULL WHERE job_id = $1`,
    [recent.job_id],
  );
});

test('sharing_backfill fills sharing_policy from the decrypted body for rows that predate the column', async () => {
  const pool = t.app.iwik.pool;
  const run = await prepareRun(t);
  run.run_id = ulid();
  run.attempt_id = ulid();
  run.target = { ...run.target, kind: 'service' };
  const { receipt } = await submitRun(t, run);
  assert.equal(receipt['sharing_policy'], 'cooperative');
  const fixtureRun = await prepareRun(t);
  fixtureRun.run_id = ulid();
  fixtureRun.attempt_id = ulid();
  await submitRun(t, fixtureRun);

  const columns = async () =>
    (
      await pool.query<{ run_id: string; sharing_policy: string; backfill_version: number | null }>(
        `SELECT run_id, sharing_policy, backfill_version FROM evidence.runs
          WHERE run_id = ANY($1::text[]) ORDER BY run_id`,
        [[run.run_id, fixtureRun.run_id]],
      )
    ).rows;
  const fresh = await columns();
  assert.deepEqual(fresh.map((r) => [r.sharing_policy, r.backfill_version]).sort(), [
    ['cooperative', 1],
    ['private', 1],
  ]);
  assert.equal(await backfillPending(pool), false);

  // simulate rows migrated with the column default and no backfill yet
  await pool.query(`UPDATE evidence.runs SET sharing_policy = 'private', backfill_version = NULL`);
  assert.equal(await backfillPending(pool), true);
  const scheduled = await ensureMaintenanceJobs(pool);
  assert.equal(scheduled.backfill, true);
  const runner = new JobRunner(pool, {
    handlers: buildHandlers({ envelope: t.app.iwik.envelope }),
  });
  await runner.drain();
  const filled = await columns();
  assert.deepEqual(
    filled.map((r) => [r.run_id, r.sharing_policy, r.backfill_version]),
    [
      [run.run_id, 'cooperative', 1],
      [fixtureRun.run_id, 'private', 1],
    ].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
  );
  const job = await pool.query<{ kind: string; state: string }>(
    `SELECT kind, state FROM jobs WHERE idempotency_key = $1`,
    [SHARING_BACKFILL_KEY],
  );
  assert.deepEqual(job.rows, [{ kind: SHARING_BACKFILL, state: 'done' }]);
  assert.equal(await backfillPending(pool), false);
  assert.equal((await ensureMaintenanceJobs(pool)).backfill, false, 'not scheduled again');
  const reap = await pool.query(`SELECT 1 FROM jobs WHERE kind = $1`, [REAP_PREVIEWS]);
  assert.ok(reap.rows.length >= 1);
});
