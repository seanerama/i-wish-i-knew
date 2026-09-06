// Entrypoints: the worker connects, logs `worker idle`, and exits 0; the
// migrate entrypoint is idempotent and reports nothing pending on a rerun.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
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

test('migrate entrypoint applies once, then reports none pending', async () => {
  await resetDatabase();
  const { stdout } = await run(tsx, [resolve(serviceDir, 'src', 'migrate.ts')], { env });
  assert.match(stdout, /migrations applied: \(none pending\)/);
});

test('worker entrypoint logs `worker idle` as JSON and exits 0', async () => {
  const { stdout } = await run(tsx, [resolve(serviceDir, 'src', 'worker.ts')], { env });
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const idle = lines.find((l) => l['msg'] === 'worker idle');
  assert.ok(idle, stdout);
  assert.equal(idle['queued'], 0);
  assert.equal(idle['service'], 'iwik-worker');
});
