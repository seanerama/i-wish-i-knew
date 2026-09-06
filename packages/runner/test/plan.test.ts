// `iwik plan` / `iwik run --plan`: the plan file, the cost model, and the
// budget: a fixture target costs 0; a non-fixture target without operator
// prices has no estimate and is refused (fail closed); an estimate above
// budget_per_plan_usd is refused; within budget it runs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { validateTool } from '@iwik/contracts';
import {
  estimateCost,
  loadPlan,
  parseCostModel,
  plan,
  planPath,
  planSummary,
  readMeta,
  run,
  runPlan,
  RunnerError,
  savePolicy,
  vaultPaths,
} from '../src/index.js';
import type { CostModel } from '../src/index.js';
import {
  allow,
  allowWithBudget,
  cleanupTemp,
  cliPath,
  FREE_PRICES,
  makeHome,
  OPERATOR_CONTEXT,
  packDir,
  readJson,
  startStub,
  startStubProcess,
} from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';
const closers: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const close of closers.splice(0)) await close();
  cleanupTemp();
});

async function stubTarget() {
  const stub = await startStub({ delayMs: 2, errorRate: 0, seed: 11 });
  closers.push(() => stub.close());
  return stub;
}

function iwik(home: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [cliPath, '--home', home, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, all: res.stdout + res.stderr };
}

const claims = readJson<Record<string, unknown>>(
  join(packDir, 'protocols', 'latency', 'claims.json'),
);

test('cost model: fixture is 0, a real target needs both operator prices, the formula is an upper bound', () => {
  const model = parseCostModel(claims) as CostModel;
  assert.equal(model.kind, 'per_request_tokens');
  assert.deepEqual(model.requires_operator_prices, [
    'usd_per_1m_prompt_tokens',
    'usd_per_1m_completion_tokens',
  ]);
  const fixture = estimateCost(model, { targetKind: 'fixture', planned: 100, maxTokens: 64 });
  assert.equal(fixture.amount, 0);
  const unpriced = estimateCost(model, { targetKind: 'service', planned: 10, maxTokens: 64 });
  assert.equal(unpriced.amount, null);
  assert.match(unpriced.basis, /usd_per_1m_prompt_tokens, usd_per_1m_completion_tokens/);
  const half = estimateCost(model, {
    targetKind: 'service',
    planned: 10,
    maxTokens: 64,
    prices: { usd_per_1m_prompt_tokens: 0.5 },
  });
  assert.equal(half.amount, null);
  const priced = estimateCost(model, {
    targetKind: 'service',
    planned: 10,
    maxTokens: 64,
    prices: { usd_per_1m_prompt_tokens: 0.5, usd_per_1m_completion_tokens: 1.5 },
  });
  // 10 * (64 * 0.5 + 64 * 1.5) / 1e6
  assert.equal(priced.amount, 0.00128);
  // no model at all: fixture still free, anything else unpriceable
  assert.equal(
    estimateCost(undefined, { targetKind: 'fixture', planned: 5, maxTokens: 8 }).amount,
    0,
  );
  assert.equal(
    estimateCost(undefined, { targetKind: 'device', planned: 5, maxTokens: 8 }).amount,
    null,
  );
  // no value from the target ever appears in the basis
  assert.ok(!priced.basis.includes('http'));
});

test('plan: writes plans/<id>.json (0600), lists unknown required context, estimates cost, never executes', async () => {
  const stub = await stubTarget();
  const { home } = makeHome();
  const record = plan({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    targetKind: 'fixture',
    question: 'How fast is the stub at concurrency 1?',
    context: ['model.requested=stub-model', 'concurrency=1'],
    planned: 12,
  });
  assert.match(record.plan_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  const file = planPath(home, record.plan_id);
  assert.ok(existsSync(file));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(readJson(file), record);
  assert.deepEqual(record.required_context.known, ['model.requested', 'concurrency']);
  assert.deepEqual(record.required_context.unknown, [
    'model.reported',
    'retry_policy',
    'cache_disabled',
    'client_region',
  ]);
  assert.deepEqual(record.estimated_cost, {
    currency: 'usd',
    amount: 0,
    basis: 'fixture target: 12 requests at 0 USD each (pack cost model)',
    budget_per_plan_usd: 0,
    within_budget: true,
  });
  assert.deepEqual(record.resolves.claims, ['latency_distribution', 'error_rate']);
  assert.match(record.resolves.statement, /local evidence only, unreplicated/);
  assert.match(record.resolves.statement, /never releasable to a cohort/);
  assert.equal(record.execution.allowed, false);
  assert.ok(record.execution.reasons.some((r) => /allow_execution false/.test(r)));
  assert.ok(record.execution.next_step.startsWith(`iwik run --plan ${record.plan_id}`));
  assert.equal(
    validateTool('plan_test', 'output', { ok: true, data: planSummary(record) }).ok,
    true,
  );
  assert.equal(stub.stub.stats.requests, 0, 'planning never touches the target');
  assert.deepEqual(loadPlan(home, record.plan_id), record);
  await assert.rejects(
    runPlan(record.plan_id, { home, offline: true }),
    (e: unknown) => e instanceof RunnerError && e.code === 'policy_denied',
  );
  assert.throws(
    () => loadPlan(home, '01ARZ3NDEKTSV4RRFFQ69G5ZZZ'),
    (e: unknown) => e instanceof RunnerError && e.code === 'plan_not_found',
  );
});

test('budget: a service target without prices is refused (fail closed); over budget refused; within budget runs', async () => {
  const stub = await stubTarget();
  const { home } = makeHome();
  allow(home, `127.0.0.1:${stub.port}`);

  const unpriced = plan({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    targetKind: 'service',
    question: 'q',
    context: OPERATOR_CONTEXT,
    planned: 2,
  });
  assert.equal(unpriced.estimated_cost.amount, null);
  assert.equal(unpriced.estimated_cost.within_budget, null);
  assert.equal(unpriced.execution.allowed, false);
  assert.ok(unpriced.execution.reasons.some((r) => /no cost estimate/.test(r)));
  await assert.rejects(
    runPlan(unpriced.plan_id, { home, offline: true }),
    (e: unknown) => e instanceof RunnerError && e.code === 'budget_unknown' && e.exitCode === 3,
  );
  // a direct run is held to the same rule
  await assert.rejects(
    run({
      home,
      protocol: PROTOCOL,
      target: stub.url,
      planned: 2,
      offline: true,
      context: OPERATOR_CONTEXT,
    }),
    (e: unknown) => e instanceof RunnerError && e.code === 'budget_unknown',
  );

  const priced = plan({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    targetKind: 'service',
    question: 'q',
    context: OPERATOR_CONTEXT,
    planned: 2,
    prices: { usd_per_1m_prompt_tokens: 1000, usd_per_1m_completion_tokens: 1000 },
  });
  // 2 * (64 * 1000 + 64 * 1000) / 1e6 = 0.256 USD > budget 0
  assert.equal(priced.estimated_cost.amount, 0.256);
  assert.equal(priced.estimated_cost.within_budget, false);
  assert.ok(priced.execution.reasons.some((r) => /exceeds budget_per_plan_usd/.test(r)));
  assert.match(priced.execution.next_step, /iwik policy set budget_per_plan_usd/);
  await assert.rejects(
    runPlan(priced.plan_id, { home, offline: true }),
    (e: unknown) => e instanceof RunnerError && e.code === 'budget_exceeded' && e.exitCode === 3,
  );
  assert.equal(stub.stub.stats.requests, 0, 'nothing ran');

  allowWithBudget(home, 0.3, `127.0.0.1:${stub.port}`);
  const result = await runPlan(priced.plan_id, { home, offline: true });
  assert.equal(result.execution_status, 'succeeded', result.exclusion_detail);
  assert.equal(result.plan_id, priced.plan_id);
  assert.equal(result.estimated_cost.amount, 0.256);
  assert.equal(stub.stub.stats.completions, 2);
  const meta = readMeta(home, result.run_id);
  assert.equal(meta.plan_id, priced.plan_id);
  assert.equal(meta.estimated_cost_usd, 0.256);
  const record = loadPlan(home, priced.plan_id);
  assert.equal(record.runs.length, 1);
  assert.equal(record.runs[0]?.run_id, result.run_id);
  assert.equal(record.runs[0]?.execution_status, 'succeeded');
  // the plan's input reached the harness: plan_id in the vault copy of input.json
  assert.equal(
    readJson<{ plan_id: string }>(vaultPaths(home, result.run_id).input).plan_id,
    priced.plan_id,
  );
});

test('CLI: iwik plan prints the id; iwik run --plan is denied (3) then runs; iwik plans shows the runs', async () => {
  // the CLI is driven with spawnSync, so the stub must live in its own process
  const stub = await startStubProcess(['--delay-ms', '2']);
  closers.push(() => stub.close());
  const { home } = makeHome();
  const planned = iwik(home, [
    'plan',
    '--protocol',
    PROTOCOL,
    '--target',
    stub.url,
    '--target-kind',
    'fixture',
    '--question',
    'how fast?',
    '--context',
    'model.requested=stub-model',
    '--context',
    'concurrency=1',
    '--context',
    'cache_disabled=true',
    '--context',
    'client_region=local',
    '--planned',
    '2',
  ]);
  assert.equal(planned.code, 0, planned.all);
  const planId = planned.stdout.trim();
  assert.match(planId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(planned.stderr, /estimated cost: 0 USD/);
  assert.match(planned.stderr, /execution: denied/);
  assert.match(planned.stderr, new RegExp(`next: iwik run --plan ${planId}`));

  const denied = iwik(home, ['run', '--plan', planId, '--offline']);
  assert.equal(denied.code, 3);
  assert.match(denied.stderr, /^iwik: policy_denied: /);
  assert.equal(denied.stdout, '');

  const both = iwik(home, ['run', '--plan', planId, '--protocol', PROTOCOL]);
  assert.equal(both.code, 2);

  savePolicy(home, {
    allow_execution: true,
    allowed_targets: [`127.0.0.1:${stub.port}`],
    budget_per_plan_usd: 0,
    allow_disruptive: false,
  });
  const ran = iwik(home, ['run', '--plan', planId, '--offline']);
  assert.equal(ran.code, 0, ran.all);
  const runId = ran.stdout.trim();
  assert.match(runId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(ran.stderr, /succeeded planned=2 attempted=2/);
  assert.match(ran.stderr, new RegExp(`report: iwik report ${runId}`));

  const shown = iwik(home, ['plans', planId]);
  assert.equal(shown.code, 0);
  const record = JSON.parse(shown.stdout) as { runs: Array<{ run_id: string }> };
  assert.equal(record.runs[0]?.run_id, runId);

  const json = iwik(home, [
    'plan',
    '--protocol',
    PROTOCOL,
    '--target',
    stub.url,
    '--question',
    'priced?',
    '--price',
    'usd_per_1m_prompt_tokens=0.5',
    '--price',
    'usd_per_1m_completion_tokens=1.5',
    '--json',
  ]);
  assert.equal(json.code, 0, json.all);
  const summary = JSON.parse(json.stdout) as { estimated_cost: { amount: number } };
  assert.equal(summary.estimated_cost.amount, 0.00128);
  assert.equal(validateTool('plan_test', 'output', { ok: true, data: summary }).ok, true);
  assert.ok(!json.stdout.includes('"prices"'), 'the summary omits the record-only fields');
  const badPrice = iwik(home, [
    'plan',
    '--protocol',
    PROTOCOL,
    '--target',
    stub.url,
    '--question',
    'q',
    '--price',
    'x',
  ]);
  assert.equal(badPrice.code, 2);
  void FREE_PRICES;
});
