// Egress-guard hardening and vault hygiene (stage 5 carry-forwards from the
// stage 3 review): a Worker, a raw tcp_wrap handle, and a UDP socket cannot
// reach a second host; the harness works outside the vault and cannot read
// sibling runs; an egress-excluded run carries no hostname on the wire.
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { validate } from '@iwik/contracts';
import { EXCLUSION_REASONS, run, vaultPaths, wireRun } from '../src/index.js';
import type { RunDraft, VaultMeta } from '../src/index.js';
import {
  allow,
  cleanupTemp,
  copyPack,
  makeHome,
  naughtyPack,
  OPERATOR_CONTEXT,
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

async function stubTarget() {
  const stub = await startStub({ delayMs: 2, errorRate: 0, seed: 5 });
  closers.push(() => stub.close());
  return stub;
}

test('guard: worker_threads, process.binding(tcp_wrap), and dgram cannot reach a second host', async () => {
  const stub = await stubTarget();
  let leaked = 0;
  const other = createServer((_req, res) => {
    leaked += 1;
    res.end('leak');
  });
  const otherPort = await listen(other);
  closers.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
  let udpPackets = 0;
  const udp = createSocket('udp4');
  udp.on('message', () => {
    udpPackets += 1;
  });
  await new Promise<void>((resolve) => udp.bind(0, '127.0.0.1', () => resolve()));
  const udpPort = udp.address().port;
  closers.push(() => new Promise<void>((resolve) => udp.close(() => resolve())));

  const workerSource =
    `const net = require('node:net'); const s = net.connect({ host: '127.0.0.1', port: ${otherPort} });` +
    ` s.on('connect', () => { s.write('GET /leak HTTP/1.0\\r\\n\\r\\n'); }); s.on('error', () => {});`;
  const prelude =
    `'use strict';\n` +
    `const __wt = require('node:worker_threads'); const __dgram = require('node:dgram');\n` +
    `try { new __wt.Worker(${JSON.stringify(workerSource)}, { eval: true }); } catch {}\n` +
    `try { const __tcp = process.binding('tcp_wrap'); const h = new __tcp.TCP(__tcp.constants.SOCKET); h.connect(new __tcp.TCPConnectWrap(), '127.0.0.1', ${otherPort}); } catch {}\n` +
    `try { process._linkedBinding('tcp_wrap'); } catch {}\n` +
    `try { const u = __dgram.createSocket('udp4'); u.send(Buffer.from('leak'), ${udpPort}, '127.0.0.1', () => u.close()); } catch {}\n`;
  const { packsDir } = naughtyPack(prelude);

  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const result = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 2,
    offline: true,
    targetKind: 'fixture',
    packsDir,
    context: OPERATOR_CONTEXT,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(leaked, 0, 'no TCP connection reached the second host');
  assert.equal(udpPackets, 0, 'no UDP packet reached the second host');
  assert.equal(result.execution_status, 'excluded');
  assert.equal(result.exclusion_reason, 'egress_denied');
  const apis = new Set(result.egress_violations.map((v) => (v as { api: string }).api));
  assert.ok(apis.has('worker_threads.Worker'), [...apis].join(','));
  assert.ok(apis.has('process.binding'), [...apis].join(','));
  assert.ok(apis.has('process._linkedBinding'), [...apis].join(','));
  assert.ok(apis.has('dgram.createSocket'), [...apis].join(','));
  // the allowed target was still reachable through the guard
  assert.equal(stub.stub.stats.completions, 2);
});

test('the harness works outside the vault: it cannot see sibling runs, and its outputs are copied in afterwards', async () => {
  const stub = await stubTarget();
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const first = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    offline: true,
    targetKind: 'fixture',
    context: OPERATOR_CONTEXT,
  });
  assert.equal(first.execution_status, 'succeeded');

  // A probing harness: records where it lives and everything it can list
  // around its input and output, then behaves like the real harness.
  const prelude =
    `'use strict';\n` +
    `{ const fs = require('node:fs'); const path = require('node:path');\n` +
    `  const list = (d) => { try { return fs.readdirSync(d); } catch (e) { return ['ERR:' + e.code]; } };\n` +
    `  const inDir = path.dirname(process.env.IWIK_INPUT); const outDir = process.env.IWIK_OUTPUT;\n` +
    `  const probe = { input: process.env.IWIK_INPUT, output: outDir, egress: process.env.IWIK_EGRESS_LOG, cwd: process.cwd(),\n` +
    `    env_keys: Object.keys(process.env).sort(),\n` +
    `    listings: { in_dir: list(inDir), in_parent: list(path.dirname(inDir)), out_parent: list(path.dirname(outDir)), out_grandparent: list(path.dirname(path.dirname(outDir))) } };\n` +
    `  fs.writeFileSync(path.join(outDir, 'probe.json'), JSON.stringify(probe)); }\n`;
  const { packsDir } = naughtyPack(prelude);
  const second = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    offline: true,
    targetKind: 'fixture',
    packsDir,
    context: OPERATOR_CONTEXT,
  });
  assert.equal(second.execution_status, 'succeeded', second.exclusion_detail);
  const paths = vaultPaths(home, second.run_id);
  const probeFile = join(paths.output, 'probe.json');
  assert.ok(existsSync(probeFile), 'extra harness output is copied into vault/<run>/output/');
  const probe = readJson<{
    input: string;
    output: string;
    egress: string;
    cwd: string;
    env_keys: string[];
    listings: Record<string, string[]>;
  }>(probeFile);
  for (const p of [probe.input, probe.output, probe.egress, probe.cwd]) {
    assert.ok(!p.startsWith(home), `${p} must not be inside the runner home`);
    assert.ok(!p.includes('vault'), `${p} must not point into the vault`);
  }
  const seen = JSON.stringify(probe.listings);
  assert.ok(
    !seen.includes(first.run_id),
    'the sibling run id is not visible anywhere near the harness',
  );
  assert.ok(!seen.includes(second.run_id));
  assert.ok(!seen.includes('run.draft.json'));
  assert.ok(!probe.env_keys.includes('IWIK_HOME'));
  assert.ok(!probe.env_keys.some((k) => /TOKEN|KEY|SECRET/i.test(k) && !k.startsWith('IWIK_')));
  // the work directory is gone afterwards
  assert.ok(!existsSync(probe.output));
  assert.ok(!existsSync(probe.input));
  // the vault copy of the input exists, and the vault entry is private
  assert.ok(existsSync(paths.input));
  assert.ok(existsSync(paths.result));
  assert.ok(existsSync(paths.attempts));
  assert.equal(readdirSync(paths.output).includes('probe.json'), true);
  assert.equal(
    validate('Run', {
      ...readJson<RunDraft>(paths.draft),
      target: { kind: 'fixture', label_digest: 'sha256:' + 'a'.repeat(64) },
      submission: {
        signed_at: '2026-01-01T00:00:00Z',
        key_id: 'k',
        signature: 'AA==',
        sharing_policy: 'private',
      },
    }).ok,
    true,
  );
});

test('wire hygiene: a run excluded for egress carries a fixed reason and no hostname in run.json', async () => {
  const stub = await stubTarget();
  const other = createServer((_req, res) => res.end('leak'));
  const otherPort = await listen(other);
  closers.push(() => new Promise<void>((resolve) => other.close(() => resolve())));
  const prelude =
    `'use strict';\n` +
    `try { require('node:http').get('http://127.0.0.1:${otherPort}/leak', () => {}).on('error', () => {}); } catch {}\n`;
  const { packsDir } = naughtyPack(prelude);
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const result = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    offline: true,
    targetKind: 'fixture',
    packsDir,
    context: OPERATOR_CONTEXT,
  });
  assert.equal(result.execution_status, 'excluded');
  assert.equal(result.exclusion_reason, 'egress_denied');
  assert.ok((EXCLUSION_REASONS as readonly string[]).includes(result.exclusion_reason ?? ''));
  assert.match(result.exclusion_detail ?? '', new RegExp(`127\\.0\\.0\\.1:${otherPort}`));

  const wire = wireRun(home, result.run_id, 'private');
  const text = JSON.stringify(wire);
  assert.equal(wire.exclusion_reason, 'egress_denied');
  assert.ok(!text.includes('127.0.0.1'), 'no hostname on the wire');
  assert.ok(!text.includes(String(otherPort)), 'no port on the wire');
  assert.ok(!text.includes('IWIK_ALLOWED_HOSTS'));
  assert.ok(!('label' in wire.target));
  assert.equal(validate('Run', wire).ok, true);
  // the detail lives in the vault only
  const paths = vaultPaths(home, result.run_id);
  const meta = readJson<VaultMeta>(paths.meta);
  assert.match(meta.exclusion_detail ?? '', /127\.0\.0\.1/);
  assert.match(readFileSync(paths.stderr, 'utf8'), /egress denied: 127\.0\.0\.1/);
});

test('a harness exit-2 reason (stderr) never reaches the wire verbatim', async () => {
  const stub = await stubTarget();
  const { packsDir, packDir } = copyPack();
  const secretish = 'internal-host.corp.example:8443';
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    join(packDir, 'harness', 'index.js'),
    `'use strict';\nprocess.stderr.write('cannot reach ${secretish}\\n');\nprocess.exit(2);\n`,
  );
  rewriteDigests(packDir);
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);
  const result = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    offline: true,
    targetKind: 'fixture',
    packsDir,
    context: OPERATOR_CONTEXT,
  });
  assert.equal(result.exclusion_reason, 'harness_protocol_violation');
  assert.equal(result.exclusion_detail, `cannot reach ${secretish}`);
  const wire = JSON.stringify(wireRun(home, result.run_id, 'private'));
  assert.ok(!wire.includes(secretish));
  assert.ok(!wire.includes('cannot reach'));
});
