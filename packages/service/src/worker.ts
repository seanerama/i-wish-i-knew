// Worker entrypoint: `node packages/service/dist/worker.js [--once]`.
//
// The job loop (modules/jobs): every IWIK_WORKER_INTERVAL_MS it re-queues
// stale `running` rows, schedules the maintenance kinds (reap_previews per
// hour bucket; sharing_backfill while rows need it), and drains whatever is
// runnable, one claim at a time with FOR UPDATE SKIP LOCKED so several
// workers share one queue safely. `--once` does a single pass and exits 0
// (tests, cron). SIGTERM/SIGINT finish the job in flight, then exit 0.
import pino from 'pino';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { loggerOptions } from './logger.js';
import { Envelope } from './modules/crypto/index.js';
import { buildHandlers, ensureMaintenanceJobs } from './modules/jobs/handlers.js';
import { JobRunner, countQueued } from './modules/jobs/index.js';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const config = loadConfig();
  const log = pino({ ...loggerOptions(config), base: { service: 'iwik-worker' } });
  const pool = createPool(config.databaseUrl);
  const envelope = new Envelope(pool, config.kek);
  const runner = new JobRunner(pool, { handlers: buildHandlers({ envelope }), log });
  const stop = new AbortController();
  const onSignal = (signal: string): void => {
    log.info({ signal }, 'worker stopping');
    stop.abort();
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));

  const tick = async (): Promise<number> => {
    await runner.recoverStale();
    await ensureMaintenanceJobs(pool);
    return runner.drain(stop.signal);
  };

  try {
    log.info(
      {
        worker_id: runner.workerId,
        interval_ms: config.workerIntervalMs,
        mode: once ? 'once' : 'loop',
      },
      'worker started',
    );
    if (once) {
      const ran = await tick();
      log.info({ ran, queued: await countQueued(pool) }, 'worker idle');
      return;
    }
    while (!stop.signal.aborted) {
      let ran = 0;
      try {
        ran = await tick();
      } catch (err) {
        // A database hiccup is not fatal: log it and try again next tick.
        log.error({ err }, 'worker tick failed');
      }
      if (ran === 0) await sleep(config.workerIntervalMs, stop.signal);
    }
    log.info('worker stopped');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`worker failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
