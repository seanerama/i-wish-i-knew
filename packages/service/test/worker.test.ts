// Entrypoints: the migrate entrypoint is idempotent and reports nothing
// pending on a rerun; the worker's `--once` pass schedules the maintenance
// jobs, drains them, logs `worker idle`, and exits 0; the loop stops cleanly
// on SIGTERM.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import pg from 'pg';
import { DATABASE_URL, TEST_KEK, repoRoot, resetDatabase } from './helpers.js';

const run = promisify(execFile);
const serviceDir = resolve(repoRoot, 'packages', 'service');
const tsx = resolve(repoRoot, 'node_modules', '.bin', 'tsx');
const env = {
  ...process.env,
  DATABASE_URL,
  IWIK_KEK: TEST_KEK,
  NODE_ENV: 'test',
  IWIK_LOG_LEVEL: 'info',
};

function jsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('migrate entrypoint applies once, then reports none pending', async () => {
  await resetDatabase();
  const { stdout } = await run(tsx, [resolve(serviceDir, 'src', 'migrate.ts')], { env });
  assert.match(stdout, /migrations applied: \(none pending\)/);
});

test('worker --once schedules and drains the maintenance jobs, logs `worker idle`, exits 0', async () => {
  const { stdout } = await run(tsx, [resolve(serviceDir, 'src', 'worker.ts'), '--once'], { env });
  const lines = jsonLines(stdout);
  const started = lines.find((l) => l['msg'] === 'worker started');
  assert.ok(started, stdout);
  assert.equal(started['mode'], 'once');
  assert.equal(started['service'], 'iwik-worker');
  const done = lines.filter((l) => l['msg'] === 'job done');
  assert.deepEqual(
    done.map((l) => l['kind']),
    ['reap_previews'],
  );
  assert.equal(done[0]?.['reaped'], 0);
  const idle = lines.find((l) => l['msg'] === 'worker idle');
  assert.ok(idle, stdout);
  assert.equal(idle['ran'], 1);
  assert.equal(idle['queued'], 0);

  // the same hour bucket: nothing new to run
  const second = await run(tsx, [resolve(serviceDir, 'src', 'worker.ts'), '--once'], { env });
  const idleAgain = jsonLines(second.stdout).find((l) => l['msg'] === 'worker idle');
  assert.equal(idleAgain?.['ran'], 0);

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const jobs = await client.query<{ kind: string; state: string; locked_by: string | null }>(
      `SELECT kind, state, locked_by FROM jobs`,
    );
    assert.deepEqual(jobs.rows, [{ kind: 'reap_previews', state: 'done', locked_by: null }]);
  } finally {
    await client.end();
  }
});

test('worker loop: starts, polls at IWIK_WORKER_INTERVAL_MS, stops on SIGTERM with exit 0', async () => {
  const child = spawn(tsx, [resolve(serviceDir, 'src', 'worker.ts')], {
    env: { ...env, IWIK_WORKER_INTERVAL_MS: '50' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => (stdout += chunk));
  child.stderr.on('data', (chunk: string) => (stderr += chunk));
  const started = new Promise<void>((resolveStarted, reject) => {
    const check = (): void => {
      if (stdout.includes('"worker started"')) resolveStarted();
    };
    child.stdout.on('data', check);
    child.once('exit', (code) => reject(new Error(`worker exited early (${code}): ${stderr}`)));
  });
  await started;
  // let it poll a few times, then ask it to stop
  await new Promise((r) => setTimeout(r, 200));
  const exited = new Promise<number | null>((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGTERM');
  const code = await exited;
  assert.equal(code, 0, stderr);
  const lines = jsonLines(stdout);
  assert.equal(lines.find((l) => l['msg'] === 'worker started')?.['mode'], 'loop');
  assert.equal(lines.find((l) => l['msg'] === 'worker stopping')?.['signal'], 'SIGTERM');
  assert.ok(
    lines.some((l) => l['msg'] === 'worker stopped'),
    stdout,
  );
});
