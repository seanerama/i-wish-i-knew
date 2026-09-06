// CLI tests: init prints the public key and never the private key or token;
// policy commands; every denial exits nonzero with a one-line reason.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadPolicy } from '../src/index.js';
import {
  cleanupTemp,
  cliPath,
  fakeService,
  makeHome,
  NODE_ID,
  repoRoot,
  tempDir,
  TEST_TOKEN,
} from './helpers.js';

after(cleanupTemp);

function iwik(home: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [cliPath, '--home', home, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, all: res.stdout + res.stderr };
}

test('init: prints the enrollment public key, never the token or private key; idempotent', () => {
  const base = tempDir();
  const home = join(base, 'home');
  const tokenFile = join(base, 'token.txt');
  writeFileSync(tokenFile, TEST_TOKEN + '\n');
  const first = iwik(home, [
    'init',
    '--service',
    'http://127.0.0.1:1/',
    '--token-file',
    tokenFile,
    '--node-id',
    NODE_ID,
  ]);
  assert.equal(first.code, 0, first.all);
  const pubkey = first.stdout.trim();
  assert.match(pubkey, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(pubkey, 'base64').length, 32);
  assert.ok(!first.all.includes(TEST_TOKEN));
  assert.ok(!first.all.includes('PRIVATE KEY'));
  const pem = readFileSync(join(home, 'key.ed25519'), 'utf8');
  assert.match(pem, /-----BEGIN PRIVATE KEY-----/);
  for (const line of pem.split('\n').filter((l) => l !== '' && !l.startsWith('-----'))) {
    assert.ok(!first.all.includes(line), 'private key material must not be printed');
  }
  assert.equal(readFileSync(join(home, 'token'), 'utf8'), TEST_TOKEN + '\n');
  // enrollment instructions point at the console's /org page (same wording as org.eta)
  const text = first.stderr.replace(/\s+/g, ' ');
  assert.match(
    text,
    /Enroll this node: sign in to the console at http:\/\/127\.0\.0\.1:1\/org, then/,
  );
  assert.match(text, /Paste the public key above under "Register a node" and register the node/);
  // the base64 raw key is what init prints; PEM is accepted at registration only
  assert.match(
    text,
    /iwik init prints the base64 raw key; a PEM block is accepted there too but is never what iwik init prints/,
  );
  assert.match(text, /base64 raw key: one line of 44 characters, the 32 raw bytes/);
  assert.match(text, /PEM SPKI block: -----BEGIN PUBLIC KEY----- \.\.\. -----END PUBLIC KEY-----/);
  assert.match(text, /Either form is stored canonically as the base64 raw key/);
  assert.match(text, /query reads, submit previews and submits runs, publish challenges/);
  assert.match(text, /Revoke the token, or revoke the whole node/);
  // the only key material anywhere in the output is the public key itself
  const base64ish = first.all.match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? [];
  assert.ok(base64ish.length >= 1);
  for (const blob of base64ish) assert.equal(blob, pubkey);
  assert.equal(
    JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).service_url,
    'http://127.0.0.1:1',
  );

  const second = iwik(home, ['init', '--service', 'http://127.0.0.1:2']);
  assert.equal(second.code, 0, second.all);
  assert.equal(second.stdout.trim(), pubkey, 'the key is kept');
  assert.match(second.stderr, /signing key: kept/);
  assert.equal(readFileSync(join(home, 'token'), 'utf8'), TEST_TOKEN + '\n', 'the token is kept');
  assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).node_id, NODE_ID);
});

test('init: with a token and no --node-id, the node id comes from GET /v1/whoami; offline keeps working', async () => {
  // the CLI is driven with spawnSync, so the service lives in its own process
  const base = tempDir();
  const log = join(base, 'requests.log');
  writeFileSync(log, '');
  const service = spawn(
    process.execPath,
    [
      join(repoRoot, 'packages', 'runner', 'test', 'fixtures', 'whoami-server.cjs'),
      TEST_TOKEN,
      log,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let text = '';
    service.stdout.setEncoding('utf8');
    service.stdout.on('data', (chunk: string) => {
      text += chunk;
      if (text.includes('\n'))
        resolve((JSON.parse(text.split('\n')[0] ?? '{}') as { port: number }).port);
    });
    service.once('error', reject);
  });
  const seen = (): string[] =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((l) => l !== '');
  try {
    const home = join(base, 'home');
    const tokenFile = join(base, 'token.txt');
    writeFileSync(tokenFile, TEST_TOKEN + '\n');
    const first = iwik(home, [
      'init',
      '--service',
      `http://127.0.0.1:${port}`,
      '--token-file',
      tokenFile,
    ]);
    assert.equal(first.code, 0, first.all);
    assert.deepEqual(seen(), ['GET /v1/whoami auth']);
    assert.match(
      first.stderr,
      new RegExp(
        `node id: ${NODE_ID} \\(from GET /v1/whoami; organization "Whoami Org", scopes query, submit\\)`,
      ),
    );
    assert.ok(!first.all.includes(TEST_TOKEN));
    assert.equal(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).node_id, NODE_ID);

    // no token: no call, and the message says how to set the id
    const bare = join(base, 'bare');
    const noToken = iwik(bare, ['init', '--service', `http://127.0.0.1:${port}`]);
    assert.equal(noToken.code, 0, noToken.all);
    assert.equal(seen().length, 1);
    assert.match(
      noToken.stderr,
      /node id: \(not set; store a token so GET \/v1\/whoami can fill it in, or pass --node-id\)/,
    );

    // --offline: no call; the service being down is reported, not fatal
    const offline = iwik(home, ['init', '--service', `http://127.0.0.1:${port}`, '--offline']);
    assert.equal(offline.code, 0, offline.all);
    assert.equal(seen().length, 1);
    assert.match(offline.stderr, new RegExp(`node id: ${NODE_ID}$`, 'm'));
    const down = iwik(join(base, 'down'), [
      'init',
      '--service',
      'http://127.0.0.1:1',
      '--token-file',
      tokenFile,
    ]);
    assert.equal(down.code, 0, down.all);
    assert.match(down.stderr, /GET \/v1\/whoami failed: .*pass --node-id to set it offline/);
    assert.ok(!down.all.includes(TEST_TOKEN));
  } finally {
    await new Promise<void>((resolve) => {
      service.once('exit', () => resolve());
      service.kill('SIGTERM');
    });
  }
});

test('policy show / set / allow-target / deny-target', () => {
  const home = join(tempDir(), 'home');
  const init = iwik(home, ['init', '--service', 'http://127.0.0.1:1']);
  assert.equal(init.code, 0, init.all);
  const shown = iwik(home, ['policy', 'show']);
  assert.equal(shown.code, 0);
  assert.deepEqual(JSON.parse(shown.stdout), {
    allow_execution: false,
    allowed_targets: [],
    budget_per_plan_usd: 0,
    allow_disruptive: false,
  });
  assert.equal(iwik(home, ['policy', 'set', 'allow_execution', 'true']).code, 0);
  assert.equal(iwik(home, ['policy', 'allow-target', 'http://127.0.0.1:8089/']).code, 0);
  assert.deepEqual(loadPolicy(home), {
    allow_execution: true,
    allowed_targets: ['127.0.0.1:8089'],
    budget_per_plan_usd: 0,
    allow_disruptive: false,
  });
  assert.equal(iwik(home, ['policy', 'deny-target', '127.0.0.1:8089']).code, 0);
  assert.deepEqual(loadPolicy(home).allowed_targets, []);
  const bad = iwik(home, ['policy', 'set', 'allow_execution', 'maybe']);
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /^iwik: usage: /);
  const unknownKey = iwik(home, ['policy', 'set', 'allowed_targets', 'x']);
  assert.equal(unknownKey.code, 2);
});

test('run: policy denial exits 3 with a one-line reason; submit without preview exits 6', () => {
  const home = join(tempDir(), 'home');
  assert.equal(
    iwik(home, ['init', '--service', 'http://127.0.0.1:1', '--node-id', NODE_ID]).code,
    0,
  );
  const denied = iwik(home, [
    'run',
    '--protocol',
    'inference-api/latency@1',
    '--target',
    'http://127.0.0.1:9',
    '--offline',
  ]);
  assert.equal(denied.code, 3);
  assert.equal(denied.stdout, '');
  assert.equal(denied.stderr.trim().split('\n').length, 1);
  assert.match(denied.stderr, /^iwik: policy_denied: policy denies execution/);

  iwik(home, ['policy', 'set', 'allow_execution', 'true']);
  const notAllowed = iwik(home, [
    'run',
    '--protocol',
    'inference-api/latency@1',
    '--target',
    'http://127.0.0.1:9',
    '--offline',
  ]);
  assert.equal(notAllowed.code, 3);
  assert.match(
    notAllowed.stderr,
    /^iwik: target_not_allowed: policy denies target host 127\.0\.0\.1:9/,
  );

  const noPreview = iwik(home, ['submit', '01ARZ3NDEKTSV4RRFFQ69G5ZZZ']);
  assert.equal(noPreview.code, 6);
  assert.match(noPreview.stderr, /^iwik: run_not_found: /);

  const usage = iwik(home, ['run', '--protocol', 'nope']);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /^iwik: usage: required option/);

  // uninitialised home: not_initialized, exit 7, no stack trace
  const fresh = join(tempDir(), 'nothing');
  const uninit = iwik(fresh, ['preview', '01ARZ3NDEKTSV4RRFFQ69G5ZZZ']);
  assert.equal(uninit.code, 6);
  assert.match(uninit.stderr, /^iwik: run_not_found: /);
  const noKey = iwik(fresh, ['receipt', 'x']);
  assert.equal(noKey.code, 7);
  assert.match(noKey.stderr, /^iwik: not_initialized: /);
});

/** The CLI driven asynchronously, so an in-process fake service can answer it. */
function iwikAsync(home: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; all: string }>(
    (resolve) => {
      const child = spawn(process.execPath, [cliPath, '--home', home, ...args], {
        env: { PATH: process.env['PATH'] ?? '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => (stdout += c));
      child.stderr.on('data', (c: string) => (stderr += c));
      child.once('close', (code) => resolve({ code, stdout, stderr, all: stdout + stderr }));
    },
  );
}

test('withdraw: validates ids and the reason vocabulary locally, prints the withdrawal id, exits 5 on not_found', async () => {
  const service = await fakeService();
  try {
    const { home } = makeHome(service.url);
    const runId = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    service.runs.set(runId, { digest: 'sha256:' + 'd'.repeat(64), receipt: {} });

    const noReason = iwik(home, ['withdraw', runId]);
    assert.equal(noReason.code, 1);
    assert.match(noReason.stderr, /required option '--reason <code>'/);
    const badReason = iwik(home, ['withdraw', runId, '--reason', 'because']);
    assert.equal(badReason.code, 1);
    assert.match(
      badReason.stderr,
      /reason must be one of: member_request, data_error, policy_change/,
    );
    const badId = iwik(home, ['withdraw', 'not-a-ulid', '--reason', 'data_error']);
    assert.equal(badId.code, 2);
    assert.match(badId.stderr, /^iwik: usage: .*\[\/run_ids\/0 pattern\]/);
    assert.equal(service.withdrawals.size, 0, 'nothing sent');

    const ok = await iwikAsync(home, ['withdraw', runId, '--reason', 'data_error']);
    assert.equal(ok.code, 0, ok.all);
    assert.match(ok.stdout.trim(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(
      ok.stderr,
      /withdrawal recorded: 1 run\(s\), reason data_error, effective at evidence revision \d+/,
    );
    assert.match(ok.stderr, /cannot be recalled/);
    assert.ok(!ok.all.includes(TEST_TOKEN));
    const again = await iwikAsync(home, ['withdraw', runId, runId, '--reason', 'member_request']);
    assert.equal(again.code, 0, again.all);
    assert.equal(again.stdout, ok.stdout);
    assert.match(again.stderr, /already withdrawn/);

    const foreign = await iwikAsync(home, [
      'withdraw',
      '01ARZ3NDEKTSV4RRFFQ69G5FXR',
      '--reason',
      'member_request',
    ]);
    assert.equal(foreign.code, 5);
    assert.match(foreign.stderr, /^iwik: api_error: not_found: not_found \(HTTP 404\)/);
  } finally {
    await service.close();
  }
});
