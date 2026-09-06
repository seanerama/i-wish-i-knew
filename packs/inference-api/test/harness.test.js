'use strict';
// Harness tests per stage 1: stub with delay_ms = 20, error_rate = 0.1, seeded
// RNG; harness with planned = 20; unreachable target; egress guard.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');
const { Ajv2020 } = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const { startStub } = require('../fixtures/stub-server/index.js');

const packDir = path.resolve(__dirname, '..');
const harnessPath = path.join(packDir, 'harness', 'index.js');
const resultSchema = JSON.parse(
  fs.readFileSync(path.join(packDir, 'protocols', 'latency', 'result.schema.json'), 'utf8'),
);
const contextFieldSchema = JSON.parse(
  fs.readFileSync(
    path.resolve(packDir, '..', '..', 'contracts', 'schema', 'v1', 'ContextField.schema.json'),
    'utf8',
  ),
);

const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
const validateResult = ajv.compile(resultSchema);
const validateContextField = ajv.compile(contextFieldSchema);

const tmpRoots = [];
after(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwik-harness-test-'));
  tmpRoots.push(dir);
  return dir;
}

function writeInput(dir, overrides = {}) {
  const input = {
    plan_id: '01ARZ3NDEKTSV4RRFFQ69G5PLN',
    protocol_ref: 'inference-api/latency@1',
    target: { url: 'http://127.0.0.1:1', model: 'stub-model' },
    context: {
      'model.requested': 'stub-model',
      concurrency: 1,
      retry_policy: 'none',
      cache_disabled: true,
      client_region: 'local',
    },
    budget: { planned: 20, max_tokens: 8 },
    timeout_ms: 5000,
    ...overrides,
  };
  const file = path.join(dir, 'input.json');
  fs.writeFileSync(file, JSON.stringify(input));
  return file;
}

function runHarness({ inputFile, outputDir, allowedHosts }) {
  return new Promise((resolve) => {
    const env = { ...process.env, IWIK_INPUT: inputFile, IWIK_OUTPUT: outputDir };
    delete env.IWIK_ALLOWED_HOSTS;
    if (allowedHosts !== undefined) env.IWIK_ALLOWED_HOSTS = allowedHosts;
    const child = spawn(process.execPath, [harnessPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });
}

/** A port nothing listens on: bind an ephemeral port, then release it. */
function closedPort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

test('20 planned attempts against the stub: accounting, result schema, exit 0', async () => {
  const stub = await startStub({
    delayMs: 20,
    errorRate: 0.1,
    seed: 42,
    modelName: 'stub-model-v1',
  });
  try {
    const dir = tempDir();
    const outputDir = path.join(dir, 'out');
    const inputFile = writeInput(dir, { target: { url: stub.url, model: 'stub-model' } });
    const run = await runHarness({ inputFile, outputDir, allowedHosts: '127.0.0.1' });
    assert.equal(run.code, 0, `stderr: ${run.stderr}`);

    const lines = fs
      .readFileSync(path.join(outputDir, 'attempts.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 20);
    lines.forEach((line, i) => {
      assert.equal(line.attempt_index, i);
      assert.ok(['succeeded', 'failed'].includes(line.status));
      assert.equal(typeof line.timing.total_ms, 'number');
      if (line.status === 'succeeded') assert.equal(typeof line.timing.ttft_ms, 'number');
    });

    const stats = await getJson(`${stub.url}/__stub/stats`);
    assert.equal(stats.completions, 20);
    const failed = lines.filter((l) => l.status === 'failed').length;
    assert.equal(failed, stats.errors, 'failed attempts must equal injected stub errors');
    assert.ok(stats.errors > 0, 'seed 42 at 10% should inject at least one error in 20');

    const result = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'));
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    assert.equal(result.summary.planned, 20);
    assert.equal(result.summary.attempted, 20);
    assert.equal(result.summary.failed, failed);
    assert.equal(result.summary.succeeded, 20 - failed);
    assert.equal(result.attempts.length, 20);
    assert.ok(result.summary.ttft_ms.p50 >= 20, 'TTFT must include the 20 ms stub delay');
    assert.ok(result.summary.total_ms.p50 >= result.summary.ttft_ms.p50);
    assert.ok(result.summary.ttft_ms.p99 >= result.summary.ttft_ms.p50);
    const succeededAttempt = result.attempts.find((a) => a.status === 'succeeded');
    assert.equal(succeededAttempt.tokens.origin, 'reported');
    assert.equal(succeededAttempt.tokens.completion_tokens, 8);
    const failedAttempt = result.attempts.find((a) => a.status === 'failed');
    assert.equal(failedAttempt.error_class, 'http_5xx');
    assert.equal(failedAttempt.http_status, 500);
    assert.equal(failedAttempt.ttft_ms, null);

    const context = JSON.parse(fs.readFileSync(path.join(outputDir, 'context.json'), 'utf8'));
    for (const field of context) {
      assert.ok(validateContextField(field), JSON.stringify(validateContextField.errors));
    }
    const reported = context.find((f) => f.key === 'model.reported');
    assert.deepEqual(reported, {
      key: 'model.reported',
      value: 'stub-model-v1',
      origin: 'measured',
    });
    assert.deepEqual(
      context.find((f) => f.key === 'concurrency'),
      { key: 'concurrency', value: 1, origin: 'measured' },
    );
  } finally {
    await stub.close();
  }
});

test('unreachable target exits 3 with no attempts written', async () => {
  const port = await closedPort();
  const dir = tempDir();
  const outputDir = path.join(dir, 'out');
  const inputFile = writeInput(dir, { target: { url: `http://127.0.0.1:${port}` } });
  const run = await runHarness({ inputFile, outputDir, allowedHosts: '127.0.0.1' });
  assert.equal(run.code, 3, `stderr: ${run.stderr}`);
  assert.match(run.stderr.split('\n')[0], /unreachable/);
  assert.ok(!fs.existsSync(path.join(outputDir, 'attempts.jsonl')));
  assert.ok(!fs.existsSync(path.join(outputDir, 'result.json')));
});

test('egress guard: host not in IWIK_ALLOWED_HOSTS exits 2 and never touches the stub', async () => {
  const stub = await startStub({ delayMs: 0, errorRate: 0, seed: 1 });
  try {
    const dir = tempDir();
    const outputDir = path.join(dir, 'out');
    const inputFile = writeInput(dir, { target: { url: stub.url } });
    const run = await runHarness({ inputFile, outputDir, allowedHosts: 'example.invalid' });
    assert.equal(run.code, 2, `stderr: ${run.stderr}`);
    assert.match(run.stderr.split('\n')[0], /egress denied/);
    assert.ok(!fs.existsSync(path.join(outputDir, 'attempts.jsonl')));
    const stats = await getJson(`${stub.url}/__stub/stats`);
    assert.equal(stats.requests, 1, 'only this stats call may have reached the stub');
    assert.equal(stats.completions, 0);
  } finally {
    await stub.close();
  }
});

test('egress guard: unset IWIK_ALLOWED_HOSTS denies everything', async () => {
  const stub = await startStub({ delayMs: 0, errorRate: 0, seed: 1 });
  try {
    const dir = tempDir();
    const inputFile = writeInput(dir, { target: { url: stub.url } });
    const run = await runHarness({ inputFile, outputDir: path.join(dir, 'out') });
    assert.equal(run.code, 2);
    const stats = await getJson(`${stub.url}/__stub/stats`);
    assert.equal(stats.completions, 0);
  } finally {
    await stub.close();
  }
});

test('egress guard accepts host:port entries as well as bare hosts', async () => {
  const stub = await startStub({ delayMs: 0, errorRate: 0, seed: 1 });
  try {
    const dir = tempDir();
    const inputFile = writeInput(dir, { target: { url: stub.url }, budget: { planned: 2 } });
    const run = await runHarness({
      inputFile,
      outputDir: path.join(dir, 'out'),
      allowedHosts: `other.example, 127.0.0.1:${stub.port}`,
    });
    assert.equal(run.code, 0, run.stderr);
  } finally {
    await stub.close();
  }
});

test('protocol violation: concurrency other than 1 exits 2 before any request', async () => {
  const stub = await startStub({ delayMs: 0, errorRate: 0, seed: 1 });
  try {
    const dir = tempDir();
    const inputFile = writeInput(dir, {
      target: { url: stub.url },
      context: { concurrency: 4 },
    });
    const run = await runHarness({
      inputFile,
      outputDir: path.join(dir, 'out'),
      allowedHosts: '127.0.0.1',
    });
    assert.equal(run.code, 2);
    assert.match(run.stderr.split('\n')[0], /concurrency/);
    const stats = await getJson(`${stub.url}/__stub/stats`);
    assert.equal(stats.completions, 0);
  } finally {
    await stub.close();
  }
});

test('all attempts failing is still a completed run (exit 0) with model.reported unknown', async () => {
  const stub = await startStub({ delayMs: 0, errorRate: 1, seed: 7 });
  try {
    const dir = tempDir();
    const outputDir = path.join(dir, 'out');
    const inputFile = writeInput(dir, { target: { url: stub.url }, budget: { planned: 5 } });
    const run = await runHarness({ inputFile, outputDir, allowedHosts: '127.0.0.1' });
    assert.equal(run.code, 0, run.stderr);
    const result = JSON.parse(fs.readFileSync(path.join(outputDir, 'result.json'), 'utf8'));
    assert.ok(validateResult(result), JSON.stringify(validateResult.errors));
    assert.equal(result.summary.failed, 5);
    assert.equal(result.summary.error_rate, 1);
    assert.equal(result.summary.ttft_ms.p50, null);
    const context = JSON.parse(fs.readFileSync(path.join(outputDir, 'context.json'), 'utf8'));
    assert.deepEqual(
      context.find((f) => f.key === 'model.reported'),
      { key: 'model.reported', value: null, origin: 'unknown' },
    );
  } finally {
    await stub.close();
  }
});
