// Stage 14: real service/socket + installed runner/CLI/MCP. Only the loopback
// fixture is executed. Service-shaped records below are explicitly synthetic
// helper setup in the disposable PostgreSQL; never relabel runner measurements.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { init as runnerInit, loadKey, homePaths, savePolicy, queryCooperative } from '@iwik/runner';
import { createOrganization, createNode, issueToken } from '../src/modules/identity/index.js';
import {
  bootCooperativeApp,
  repoRoot,
  submitFresh,
  seededRun,
  CookieJar,
  browse,
  postForm,
} from './helpers.js';
import type { TestApp, OrgWithNode } from './helpers.js';

const require = createRequire(import.meta.url);
// Local tooling intentionally has no public wire schema or generated typings.
const driver = require(resolve(repoRoot, 'scripts/investigation.cjs')) as Record<
  'init' | 'execute' | 'open' | 'renderReport' | 'main',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (...args: any[]) => any
>;
const { startStub } = require(
  resolve(repoRoot, 'packs/inference-api/fixtures/stub-server/index.js'),
) as { startStub: (o: object) => Promise<{ url: string; port: number; close(): Promise<void> }> };
let t: TestApp;
let base: string;
let scenario: string;
let stub: Awaited<ReturnType<typeof startStub>>;
const orgs: Record<string, OrgWithNode> = {};
const homes: Record<string, string> = {};
function json(file: string) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
function save(file: string, value: unknown) {
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}
async function proof(name: string, extra: object = {}) {
  const file = join(base, `${name}.json`);
  const artifact = join(base, `${name}.txt`);
  writeFileSync(artifact, 'CI synthetic setup / HTTP integration proof only');
  save(file, {
    checked: true,
    observed_at: new Date().toISOString(),
    notes: 'Synthetic integration setup, never browser/live acceptance',
    artifacts: [artifact],
    ...extra,
  });
  return driver.execute(scenario, name, file);
}
function step(name: string, arg?: string) {
  return driver.execute(scenario, name, arg);
}
before(async () => {
  base = mkdtempSync(join(tmpdir(), 'iwik-investigation-'));
  t = await bootCooperativeApp({ env: { IWIK_FEATURE_CHALLENGE: 'on' } });
  const url = await t.app.listen({ host: '127.0.0.1', port: 0 });
  stub = await startStub({ delayMs: 2, errorRate: 0, seed: 1 });
  for (const member of ['A', 'B', 'C']) {
    const home = join(base, member);
    runnerInit({ home, serviceUrl: url });
    const key = loadKey(homePaths(home).key);
    const org = await createOrganization(t.app.iwik.pool, `Synthetic stage14 ${member}`);
    const node_id = await createNode(t.app.iwik.pool, org.org_id, key.pubkey);
    const token = await issueToken(t.app.iwik.pool, node_id, ['query', 'submit', 'publish']);
    const tokenFile = join(base, `${member}.token`);
    writeFileSync(tokenFile, token, { mode: 0o600 });
    runnerInit({ home, serviceUrl: url, tokenFile, nodeId: node_id });
    savePolicy(home, {
      allow_execution: true,
      allowed_targets: [`127.0.0.1:${stub.port}`],
      budget_per_plan_usd: 0,
      allow_disruptive: false,
    });
    orgs[member] = {
      ...org,
      node_id,
      token,
      key: { privateKey: key.privateKey, pubkey: key.pubkey },
    };
    homes[member] = home;
  }
  const config = join(base, 'config.json');
  save(config, {
    mode: 'fixture-ci',
    commit: 'a'.repeat(40),
    homes,
    question: 'Does fixture p50 TTFT stay below 0 ms?',
    target: { kind: 'fixture', url: stub.url },
    planned: 12,
    max_tokens: 64,
    timeout_ms: 1000,
    context: {
      'model.requested': 'stub-model',
      concurrency: 1,
      cache_disabled: true,
      client_region: 'local',
    },
    filters: { client_region: 'local' },
    budget: { max_runs: 8, max_requests: 96, max_usd: 0, max_elapsed_ms: 3600000 },
    prediction: {
      metric: 'ttft_ms',
      statistic: 'p50',
      comparator: 'below',
      value: 0,
      horizon: '2099-01-01',
    },
  });
  scenario = driver.init(join(base, 'scenario'), config);
});
after(async () => {
  await stub?.close();
  await t?.app.close();
  rmSync(base, { recursive: true, force: true });
});

test('scenario: incomplete live preflight and failed CLI steps exit nonzero; private report excludes raw input', async () => {
  const cfg = json(join(scenario, 'scenario.json'));
  delete cfg.target;
  cfg.mode = 'live';
  cfg.question = 'secret-token-canary and foreign-node-canary';
  const file = join(base, 'missing.json');
  save(file, cfg);
  const missing = driver.init(join(base, 'missing'), file);
  await assert.rejects(driver.execute(missing, 'preflight'));
  const report = readFileSync(join(missing, 'report.md'), 'utf8');
  assert.match(report, /INCOMPLETE live acceptance/);
  assert.doesNotMatch(report, /secret-token-canary|foreign-node-canary/);
  const code = await new Promise((done) => {
    const child = spawn(
      process.execPath,
      [resolve(repoRoot, 'scripts/investigation.cjs'), 'step', missing, 'initial'],
      { stdio: 'ignore' },
    );
    child.on('exit', done);
  });
  assert.equal(code, 1);
  assert.equal(statSync(join(missing, 'journal.json')).mode & 0o777, 0o600);
  assert.equal(statSync(missing).mode & 0o777, 0o700);
});

test('scenario: real runner fixture plan/run/report/preview/explicit approve remains private; resume cannot duplicate', async () => {
  await step('preflight');
  await assert.rejects(step('enrollment'));
  await proof('enrollment');
  await step('initial');
  await step('plan-A1');
  const run = await step('run-A1');
  assert.equal(run.execution_status, 'succeeded');
  await step('local-A1');
  const preview = await step('preview-A1');
  assert.equal(preview.would_store.target_kind, 'fixture');
  assert.equal(preview.would_store.sharing_policy, 'private');
  await assert.rejects(step('approve-A1'));
  const submitted = await step('approve-A1', '--approve');
  assert.equal(submitted.status, 201);
  assert.equal(submitted.receipt.sharing_policy, 'private');
  assert.deepEqual(await step('approve-A1', '--approve'), submitted);
  await step('replay');
  const stored = await t.app.iwik.pool.query(
    'SELECT count(*)::int AS n FROM evidence.runs WHERE run_id=$1',
    [run.run_id],
  );
  assert.equal(stored.rows[0].n, 1);
  const journal = json(join(scenario, 'journal.json'));
  assert.equal(Object.keys(journal.reservations).length, 1);
  await assert.rejects(step('two-orgs'));
  assert.match(readFileSync(join(scenario, 'report.md'), 'utf8'), /INCOMPLETE live acceptance/);
});

test('scenario: interrupted execution/prediction/outcome intents block replay; lock excludes second writer; reservation persists', async () => {
  const file = join(scenario, 'journal.json');
  const journal = json(file);
  for (const key of ['run-A9', 'prediction', 'outcome']) {
    journal.steps[key] = { status: 'pending', intent: true };
    save(file, journal);
    await assert.rejects(step(key), /ambiguous_write/);
    delete journal.steps[key];
  }
  save(file, journal);
  writeFileSync(join(scenario, '.lock'), 'another writer');
  await assert.rejects(step('plan-A2'), /EEXIST/);
  rmSync(join(scenario, '.lock'));
  assert.equal(Object.keys(json(file).reservations).length, 1);
});

test('scenario: accepted submission with lost response resumes once; later submissions invalidate cleanup; expired budget permits cleanup', async () => {
  await step('cleanup');
  await proof('inventory');
  await step('plan-A8');
  const run = await step('run-A8');
  await step('local-A8');
  await step('preview-A8');
  const realFetch = globalThis.fetch;
  let accepted = false;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    if (String(args[0]).endsWith('/v1/runs') && args[1]?.method === 'POST') {
      assert.equal(response.status, 201);
      await response.text();
      accepted = true;
      throw new Error('test transport lost the real accepted response');
    }
    return response;
  };
  try {
    await assert.rejects(step('approve-A8', '--approve'));
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(accepted, true);
  // A retry lacking approval must not erase the previous committed-write intent.
  await assert.rejects(step('approve-A8'), /approval_required/);
  // Cleanup must reconcile a committed run even before approve has a pass result.
  await step('cleanup');
  const lostResponseRun = await t.app.iwik.pool.query(
    'SELECT withdrawn_at FROM evidence.runs WHERE run_id=$1',
    [run.run_id],
  );
  assert.ok(lostResponseRun.rows[0].withdrawn_at);
  const replay = await step('approve-A8', '--approve');
  assert.equal(replay.status, 200);
  assert.match(readFileSync(join(scenario, 'report.md'), 'utf8'), /Error history/);
  assert.ok(
    json(join(scenario, 'journal.json')).errors.some(
      (e: { step: string }) => e.step === 'approve-A8',
    ),
  );
  const persisted = await t.app.iwik.pool.query(
    'SELECT count(*)::int AS n FROM evidence.runs WHERE run_id=$1',
    [run.run_id],
  );
  assert.equal(persisted.rows[0].n, 1);
  const file = join(scenario, 'journal.json');
  const journal = json(file);
  assert.equal(journal.steps.cleanup, undefined);
  assert.equal(journal.steps.inventory, undefined);
  const started = journal.started_at;
  journal.started_at = '2000-01-01T00:00:00Z';
  save(file, journal);
  await step('plan-B8');
  await assert.rejects(step('run-B8'), /budget_exhausted/);
  const reservationCount = Object.keys(json(file).reservations).length;
  assert.equal(reservationCount, 2);
  await step('cleanup');
  const withdrawn = await t.app.iwik.pool.query(
    'SELECT withdrawn_at FROM evidence.runs WHERE run_id=$1',
    [run.run_id],
  );
  assert.ok(withdrawn.rows[0].withdrawn_at);
  const restored = json(file);
  restored.started_at = started;
  save(file, restored);
});

test('scenario: synthetic six-run release joins actual CLI/MCP/console, prediction -> later fixture outcome -> withdrawal/pin', async () => {
  // Explicit synthetic service-shaped records via existing test helper. These
  // never originate in the runner fixture vault and never claim live provenance.
  const journalFile = join(scenario, 'journal.json');
  const seedMember = async (member: string, values: number[]) => {
    const journal = json(journalFile);
    const who = orgs[member];
    assert.ok(who);
    for (const [i, value] of values.entries()) {
      const { res } = await submitFresh(t, who, seededRun({ region: 'local', ttft_p50: value }));
      assert.equal(res.statusCode, 201);
      journal.steps[`approve-${member}${i + 2}`] = {
        status: 'pass',
        data: { status: 201, receipt: res.json(), qualifying: true },
        synthetic_test_setup: true,
      };
    }
    save(journalFile, journal);
  };
  await seedMember('A', [20, 21]);
  await seedMember('B', [60, 61]);
  await step('two-orgs');
  await seedMember('C', [40, 41]);
  const released = await step('release');
  assert.equal(released.result.uncertainty.tail_claims.supported, false);
  assert.ok(released.result.contradictions.length > 0);
  assert.doesNotMatch(JSON.stringify(released.result.contradictions), /because|caused|due to/);
  await step('surfaces');
  const jar = new CookieJar();
  await browse(t, jar, '/');
  await postForm(t, jar, '/console/session', { token: orgs.A!.token });
  const consoleReceipt = await browse(t, jar, `/receipts/${released.receipt_id}`);
  assert.equal(consoleReceipt.statusCode, 200);
  assert.match(consoleReceipt.body, /Contradictions/);
  assert.match(consoleReceipt.body, /non-overlapping interquartile ranges/);
  await proof('console-released');
  const prediction = await step('prediction');
  assert.deepEqual(await step('prediction'), prediction);
  await step('plan-followup');
  await step('run-followup');
  await step('local-followup');
  // The server commits an outcome; transport loses its response. Resume must
  // stop, not issue another outcome/prediction. Recovery below uses that exact
  // captured server response as an explicitly synthetic reconciliation proof.
  const realFetch = globalThis.fetch;
  let acceptedOutcome: unknown;
  globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
    const response = await realFetch(...args);
    if (String(args[0]).endsWith('/v1/outcomes') && args[1]?.method === 'POST') {
      assert.equal(response.status, 201);
      acceptedOutcome = await response.json();
      throw new Error('test transport lost the real outcome response');
    }
    return response;
  };
  try {
    await assert.rejects(step('outcome', 'changed'));
  } finally {
    globalThis.fetch = realFetch;
  }
  await assert.rejects(step('outcome', 'changed'), /ambiguous_write/);
  const outcomeCount = await t.app.iwik.pool.query(
    'SELECT count(*)::int AS n FROM evidence.outcomes WHERE prediction_id=$1',
    [prediction.prediction_id],
  );
  assert.equal(outcomeCount.rows[0].n, 1);
  const reconciled = json(journalFile);
  reconciled.steps.outcome = {
    status: 'pass',
    data: acceptedOutcome,
    synthetic_reconciliation: true,
  };
  save(journalFile, reconciled);
  const outcome = await step('outcome', 'changed');
  assert.equal(outcome.observed.result, 'not_met');
  assert.equal(outcome.observed.environment_changed, true);
  assert.deepEqual(outcome.prediction, prediction);
  assert.deepEqual(await step('outcome', 'unchanged'), outcome);
  await step('second-outcome');
  await step('withdraw');
  await step('stale');
  await step('pinned');
  const stale = await browse(t, jar, `/receipts/${released.receipt_id}`);
  assert.match(stale.body, /stale/);
  await step('cleanup');
  const remaining = await t.app.iwik.pool.query(
    'SELECT count(*)::int AS n FROM evidence.runs WHERE withdrawn_at IS NULL',
  );
  assert.equal(remaining.rows[0].n, 0);
  const report = readFileSync(join(scenario, 'report.md'), 'utf8');
  for (const org of Object.values(orgs))
    for (const secret of [org.token, org.node_id, org.org_ref, org.org_id])
      assert.ok(!report.includes(secret));
  assert.ok(!report.includes(released.receipt_id));
  assert.match(report, /INCOMPLETE live acceptance/);
});

test('scenario: cycle budget boundary accepts 100 and rejects 101 before work; 100 own records clean up idempotently', async () => {
  // Fresh identity keeps this boundary isolated from the earlier scenario's
  // own-evidence history. Helper intake below is explicitly synthetic setup;
  // no inference calls or runner measurements are needed to fill the boundary.
  const serviceUrl = json(homePaths(homes.A!).config).service_url;
  const home = join(base, 'boundary-home');
  runnerInit({ home, serviceUrl });
  const key = loadKey(homePaths(home).key);
  const org = await createOrganization(t.app.iwik.pool, 'Synthetic boundary organization');
  const node_id = await createNode(t.app.iwik.pool, org.org_id, key.pubkey);
  const token = await issueToken(t.app.iwik.pool, node_id, ['query', 'submit', 'publish']);
  const tokenFile = join(base, 'boundary.token');
  writeFileSync(tokenFile, token, { mode: 0o600 });
  runnerInit({ home, serviceUrl, tokenFile, nodeId: node_id });
  savePolicy(home, {
    allow_execution: true,
    allowed_targets: [`127.0.0.1:${stub.port}`],
    budget_per_plan_usd: 0,
    allow_disruptive: false,
  });
  const config = json(join(scenario, 'scenario.json'));
  config.homes.A = home;
  config.budget.max_runs = 100;
  config.budget.max_requests = config.planned * 100;
  const configFile = join(base, 'boundary-config.json');
  save(configFile, config);
  const accepted = driver.init(join(base, 'boundary-100'), configFile);
  await driver.execute(accepted, 'preflight');

  config.budget.max_runs = 101;
  config.budget.max_requests = config.planned * 101;
  save(configFile, config);
  const rejected = driver.init(join(base, 'boundary-101'), configFile);
  const before = await t.app.iwik.pool.query('SELECT count(*)::int AS n FROM evidence.runs');
  await assert.rejects(driver.execute(rejected, 'preflight'), /prerequisite_missing/);
  await assert.rejects(driver.execute(rejected, 'run-A1'), /prerequisite_missing/);
  await assert.rejects(driver.execute(rejected, 'approve-A1', '--approve'), /prerequisite_missing/);
  assert.deepEqual(json(join(rejected, 'journal.json')).reservations, {});
  assert.deepEqual(readdirSync(homePaths(home).vault), []);
  const after = await t.app.iwik.pool.query('SELECT count(*)::int AS n FROM evidence.runs');
  assert.equal(after.rows[0].n, before.rows[0].n);

  const journalFile = join(accepted, 'journal.json');
  const journal = json(journalFile);
  const ids: string[] = [];
  for (let i = 1; i <= 100; i++) {
    const { res, run } = await submitFresh(
      t,
      { node_id, token, key: { privateKey: key.privateKey, pubkey: key.pubkey } },
      seededRun({ region: 'local', ttft_p50: i, target_kind: 'fixture' }),
    );
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().sharing_policy, 'private');
    ids.push(run.run_id);
    journal.steps[`approve-A${i}`] = {
      status: 'pass',
      data: { receipt: res.json(), qualifying: false },
      synthetic_test_setup: true,
    };
  }
  save(journalFile, journal);
  const own = await queryCooperative({
    home,
    protocol: 'inference-api/latency@1',
    context: { client_region: 'local' },
  });
  assert.equal(own.result?.own_evidence?.runs.length, 100);
  assert.notEqual(own.status, 'released');
  const cleanup = await driver.execute(accepted, 'cleanup');
  assert.equal(cleanup.withdrawals.length, 1);
  assert.equal(cleanup.withdrawals[0].status, 201);
  assert.equal(cleanup.withdrawals[0].run_ids.length, 100);
  const persisted = await t.app.iwik.pool.query(
    'SELECT count(*)::int AS n, count(withdrawn_at)::int AS withdrawn FROM evidence.runs WHERE run_id = ANY($1::text[])',
    [ids],
  );
  assert.deepEqual(persisted.rows[0], { n: 100, withdrawn: 100 });
  const replay = await driver.execute(accepted, 'cleanup');
  assert.equal(replay.withdrawals[0].status, 200);
  assert.equal(replay.withdrawals[0].withdrawal_id, cleanup.withdrawals[0].withdrawal_id);
});
