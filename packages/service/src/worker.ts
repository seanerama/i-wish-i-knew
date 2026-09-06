// Worker entrypoint: `node packages/service/dist/worker.js`. The job table
// exists (ADR-0001) but no job kinds are defined yet, so the worker connects,
// reports the queue, logs `worker idle`, and exits 0.
import pino from 'pino';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { loggerOptions } from './logger.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ ...loggerOptions(config), base: { service: 'iwik-worker' } });
  const pool = createPool(config.databaseUrl);
  try {
    const res = await pool.query<{ n: string | number }>(
      `SELECT count(*) AS n FROM jobs WHERE state = 'queued' AND run_after <= now()`,
    );
    log.info({ queued: Number(res.rows[0]?.n ?? 0) }, 'worker idle');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`worker failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
