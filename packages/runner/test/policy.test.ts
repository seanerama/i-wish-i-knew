// Policy tests (stage 3): execution denied by default; target not in the
// allowlist denied; neither spawns a harness or touches the vault.
import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  checkExecution,
  DEFAULT_POLICY,
  homePaths,
  loadPolicy,
  run,
  RunnerError,
  savePolicy,
  targetAllowed,
} from '../src/index.js';
import {
  allow,
  cleanupTemp,
  copyPack,
  makeHome,
  OPERATOR_CONTEXT,
  rewriteDigests,
} from './helpers.js';

after(cleanupTemp);

/** A pack copy whose harness leaves a marker file the moment it starts. */
function markerPack(): { packsDir: string; marker: string } {
  const { packsDir, packDir } = copyPack();
  const marker = join(packsDir, 'harness-ran');
  writeFileSync(
    join(packDir, 'harness', 'index.js'),
    `'use strict';\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\nprocess.exit(0);\n`,
  );
  rewriteDigests(packDir);
  return { packsDir, marker };
}

test('default policy denies execution and lists no targets', () => {
  const { home } = makeHome();
  assert.deepEqual(loadPolicy(home), DEFAULT_POLICY);
  assert.equal(loadPolicy(home).allow_execution, false);
  assert.deepEqual(loadPolicy(home).allowed_targets, []);
  // a missing policy file is the default policy, never permissive
  const empty = join(home, 'nope');
  assert.equal(loadPolicy(empty).allow_execution, false);
});

test('execution denied by default: no harness spawn, no vault entry', async () => {
  const { home } = makeHome();
  const { packsDir, marker } = markerPack();
  await assert.rejects(
    run({
      home,
      protocol: 'inference-api/latency@1',
      target: 'http://127.0.0.1:9',
      offline: true,
      packsDir,
      context: OPERATOR_CONTEXT,
    }),
    (e: unknown) => e instanceof RunnerError && e.code === 'policy_denied' && e.exitCode === 3,
  );
  assert.deepEqual(readdirSync(homePaths(home).vault), []);
  assert.ok(!readdirSync(packsDir).includes('harness-ran'), `marker ${marker} must not exist`);
});

test('target not in allowed_targets denied: no harness spawn, no vault entry', async () => {
  const { home } = makeHome();
  const { packsDir } = markerPack();
  allow(home, '127.0.0.1:8089', 'example.test');
  await assert.rejects(
    run({
      home,
      protocol: 'inference-api/latency@1',
      target: 'http://127.0.0.1:9',
      offline: true,
      packsDir,
      context: OPERATOR_CONTEXT,
    }),
    (e: unknown) => e instanceof RunnerError && e.code === 'target_not_allowed' && e.exitCode === 3,
  );
  assert.deepEqual(readdirSync(homePaths(home).vault), []);
  assert.ok(!readdirSync(packsDir).includes('harness-ran'));
});

test('allowlist matching: bare host, host:port, and origins; ports must match when given', () => {
  const policy = {
    ...DEFAULT_POLICY,
    allow_execution: true,
    allowed_targets: ['Example.test', '127.0.0.1:8089', 'https://api.example.test:8443/'],
  };
  assert.equal(targetAllowed(policy, new URL('http://example.test/v1')), true);
  assert.equal(targetAllowed(policy, new URL('http://example.test:9999/v1')), true);
  assert.equal(targetAllowed(policy, new URL('http://127.0.0.1:8089')), true);
  assert.equal(targetAllowed(policy, new URL('http://127.0.0.1:8090')), false);
  assert.equal(targetAllowed(policy, new URL('https://api.example.test:8443')), true);
  assert.equal(targetAllowed(policy, new URL('https://api.example.test')), false);
  assert.equal(targetAllowed(policy, new URL('http://localhost:8089')), false);
  assert.throws(() => checkExecution(policy, 'ftp://example.test'), /http\(s\)/);
  assert.throws(() => checkExecution(policy, 'not a url'), /http\(s\)/);
});

test('a malformed policy file is an error, not a permissive default', () => {
  const { home } = makeHome();
  writeFileSync(homePaths(home).policy, '{"allow_execution": "yes"}');
  assert.throws(
    () => loadPolicy(home),
    (e: unknown) => e instanceof RunnerError && e.code === 'policy_invalid',
  );
  writeFileSync(homePaths(home).policy, 'not json');
  assert.throws(
    () => loadPolicy(home),
    (e: unknown) => e instanceof RunnerError && e.code === 'policy_invalid',
  );
  savePolicy(home, { ...DEFAULT_POLICY, allowed_targets: ['a.test'] });
  assert.deepEqual(loadPolicy(home).allowed_targets, ['a.test']);
});
