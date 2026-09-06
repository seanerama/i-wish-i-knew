// CLI tests: init prints the public key and never the private key or token;
// policy commands; every denial exits nonzero with a one-line reason.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { loadPolicy } from '../src/index.js';
import { cleanupTemp, cliPath, NODE_ID, tempDir, TEST_TOKEN } from './helpers.js';

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
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /required option/);

  // uninitialised home: not_initialized, exit 7, no stack trace
  const fresh = join(tempDir(), 'nothing');
  const uninit = iwik(fresh, ['preview', '01ARZ3NDEKTSV4RRFFQ69G5ZZZ']);
  assert.equal(uninit.code, 6);
  assert.match(uninit.stderr, /^iwik: run_not_found: /);
  const noKey = iwik(fresh, ['receipt', 'x']);
  assert.equal(noKey.code, 7);
  assert.match(noKey.stderr, /^iwik: not_initialized: /);
});
