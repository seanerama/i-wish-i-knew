// Feed this file to `docker exec -i i-wish-i-knew node --input-type=module`.
// It enqueues existing maintenance and observes it; it never runs a worker.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export async function probe(pool, enqueueJob, { timeoutMs = 60000, emit = console.log } = {}) {
  const deadline = Date.now() + timeoutMs;
  const { job_id } = await enqueueJob(pool, {
    kind: 'reap_previews',
    idempotency_key: `staging-probe:${randomUUID()}`,
  });
  emit(JSON.stringify({ job_id, kind: 'reap_previews', state: 'enqueued' }));
  while (Date.now() < deadline) {
    const { rows } = await pool.query('SELECT state, attempts FROM jobs WHERE job_id = $1', [
      job_id,
    ]);
    const row = rows[0];
    if (row?.state === 'done') {
      emit(
        JSON.stringify({ job_id, kind: 'reap_previews', state: 'done', attempts: row.attempts }),
      );
      return job_id;
    }
    if (row?.state === 'failed') throw new Error(`worker probe failed: job_id=${job_id}`);
    await delay(Math.min(1000, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`worker probe timed out: job_id=${job_id}`);
}

// In the image /app is the working directory. Import the image's actual job
// producer so identifiers and queue semantics remain owned by the service.
if (!process.argv[1] || import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let pool;
  try {
    const { default: pg } = await import('pg');
    const { enqueueJob } = await import(
      pathToFileURL(resolve('packages/service/dist/modules/jobs/index.js')).href
    );
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 5000,
      query_timeout: 6000,
    });
    await probe(pool, enqueueJob);
  } catch (err) {
    // Do not echo database/driver errors that could include credentials or SQL.
    const message =
      err instanceof Error &&
      /^worker probe (failed|timed out): job_id=[0-9A-HJKMNP-TV-Z]{26}$/.test(err.message)
        ? err.message
        : 'worker probe unavailable (inspect operator-local database/process state)';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}
