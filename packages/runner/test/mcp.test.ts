// `iwik mcp` through the MCP SDK client: the contract test (the ten frozen
// tools plus the additive register_prediction, whose schemas are the
// committed contracts/schema/v1/tools/ files verbatim), the kill-switch, and
// the full flow plan_test -> run_test denied -> policy -> run_test ->
// preview_contribution -> submit_run -> get_receipt, plus query_evidence
// answering insufficient_evidence, withdraw_contribution (stage 7), and the
// stage 10 ledger tools challenge_finding, register_prediction, report_outcome.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Run } from '@iwik/contracts';
import { toolNames, toolSchemaFile, validate, validateTool } from '@iwik/contracts';
import { loadPlan, readReceipt, savePolicy, vaultPaths } from '../src/index.js';
import {
  cliPath,
  cleanupTemp,
  fakeService,
  makeHome,
  startStub,
  toolSchemaDir,
} from './helpers.js';
import type { FakeService } from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';
const CONTRACT_TOOLS = [
  'get_protocol',
  'query_evidence',
  'plan_test',
  'run_test',
  'preview_contribution',
  'submit_run',
  'get_receipt',
  'challenge_finding',
  'report_outcome',
  'withdraw_contribution',
  'register_prediction',
];

let service: FakeService;
let stub: Awaited<ReturnType<typeof startStub>>;
let home: string;
let client: Client;
let transport: StdioClientTransport;

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; next_step?: string };
}

async function call(name: string, args: Record<string, unknown>): Promise<Envelope> {
  const result = await client.callTool({ name, arguments: args });
  const envelope = result.structuredContent as Envelope;
  // the text content carries the same envelope
  const content = result.content as Array<{ type: string; text: string }>;
  assert.deepEqual(JSON.parse(content[0]?.text ?? '{}'), envelope);
  assert.equal(validateTool(name as (typeof toolNames)[number], 'output', envelope).ok, true);
  return envelope;
}

before(async () => {
  service = await fakeService();
  stub = await startStub({ delayMs: 2, errorRate: 0, seed: 9 });
  const made = makeHome(service.url);
  home = made.home;
  service.pubkey = made.pubkey;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, '--home', home, 'mcp'],
    env: { PATH: process.env['PATH'] ?? '', IWIK_MCP_ENABLED: 'on' },
    stderr: 'pipe',
  });
  client = new Client({ name: 'iwik-test-agent', version: '0.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client.close();
  await stub.close();
  await service.close();
  cleanupTemp();
});

test('kill-switch: iwik mcp refuses to start without IWIK_MCP_ENABLED and says why', () => {
  const res = spawnSync(process.execPath, [cliPath, '--home', home, 'mcp'], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '' },
  });
  assert.equal(res.status, 3);
  assert.match(
    res.stderr,
    /^iwik: feature_disabled: iwik mcp is disabled: IWIK_MCP_ENABLED is not set/,
  );
  assert.match(res.stderr, /default off/);
  assert.equal(res.stdout, '');
  const off = spawnSync(process.execPath, [cliPath, '--home', home, 'mcp'], {
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', IWIK_MCP_ENABLED: 'off' },
  });
  assert.equal(off.status, 3);
});

test('contract: the ten tools in order plus register_prediction, with the committed input and output schemas verbatim, and SKILL.md as instructions', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    CONTRACT_TOOLS,
  );
  assert.deepEqual([...toolNames], CONTRACT_TOOLS);
  for (const tool of tools) {
    const name = tool.name as (typeof toolNames)[number];
    const input = JSON.parse(
      readFileSync(join(toolSchemaDir, toolSchemaFile(name, 'input')), 'utf8'),
    );
    const output = JSON.parse(
      readFileSync(join(toolSchemaDir, toolSchemaFile(name, 'output')), 'utf8'),
    );
    assert.deepEqual(tool.inputSchema, input, `${name} input schema`);
    assert.deepEqual(tool.outputSchema, output, `${name} output schema`);
    assert.ok((tool.description ?? '').length > 20);
  }
  const readOnly = tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name);
  assert.deepEqual(readOnly, [
    'get_protocol',
    'query_evidence',
    'preview_contribution',
    'get_receipt',
  ]);
  const instructions = client.getInstructions() ?? '';
  assert.ok(instructions.includes('## Never send'));
  assert.equal(client.getServerVersion()?.name, 'iwik');
});

test('input validation: a bad input is an envelope with paths and rules, never the value', async () => {
  const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const bad = await call('get_protocol', { protocol_ref: secret });
  assert.equal(bad.ok, false);
  assert.equal(bad.error?.code, 'validation_failed');
  assert.match(bad.error?.message ?? '', /\/protocol_ref pattern/);
  assert.ok(!JSON.stringify(bad).includes(secret));
  const extra = await call('run_test', { plan_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', extra: secret });
  assert.equal(extra.error?.code, 'validation_failed');
  assert.match(extra.error?.message ?? '', /additionalProperties/);
  assert.ok(!JSON.stringify(extra).includes(secret));
  await assert.rejects(
    client.callTool({ name: 'delete_everything', arguments: {} }),
    /unknown tool/,
  );
});

test('get_protocol reads the registry; query_evidence answers insufficient_evidence with a next step', async () => {
  const protocol = await call('get_protocol', { protocol_ref: PROTOCOL });
  assert.equal(protocol.ok, true, JSON.stringify(protocol));
  assert.equal(protocol.data?.['ref'], PROTOCOL);
  assert.deepEqual(protocol.data?.['permitted_claims'], ['latency_distribution', 'error_rate']);

  const answer = await call('query_evidence', {
    protocol_ref: PROTOCOL,
    context_filters: { concurrency: 1, 'model.reported': 'stub-model' },
  });
  assert.equal(answer.ok, false);
  assert.equal(answer.error?.code, 'insufficient_evidence');
  assert.match(answer.error?.message ?? '', /no cooperative evidence for inference-api\/latency@1/);
  assert.match(answer.error?.message ?? '', /receipt 01ARZ3NDEKTSV4RRFFQ69G5[0-9A-Z]{3}/);
  assert.match(answer.error?.message ?? '', /no_cooperative_evidence/);
  assert.match(answer.error?.next_step ?? '', /plan_test/);
  assert.match(answer.error?.next_step ?? '', /iwik run --plan/);
  assert.match(answer.error?.next_step ?? '', /get_receipt 01ARZ3NDEKTSV4RRFFQ69G5[0-9A-Z]{3}/);
  assert.equal(service.queries.length, 1);
  assert.deepEqual(service.queries[0], {
    protocol_ref: PROTOCOL,
    context_filters: { concurrency: 1, 'model.reported': 'stub-model' },
  });
  // the query receipt is re-readable
  const receiptId = /receipt (01ARZ3NDEKTSV4RRFFQ69G5[0-9A-Z]{3})/.exec(
    answer.error?.message ?? '',
  )?.[1];
  assert.ok(receiptId);
  const read = await call('get_receipt', { receipt_id: receiptId });
  assert.equal(read.ok, true);
  const receipt = read.data?.['receipt'] as Record<string, unknown>;
  assert.equal(receipt['status'], 'insufficient_evidence');
  assert.equal(receipt['kind'], 'query');
});

test('full flow: plan_test -> run_test denied -> policy -> run_test -> preview_contribution -> submit_run -> get_receipt', async () => {
  const planned = await call('plan_test', {
    protocol_ref: PROTOCOL,
    target: { url: stub.url, kind: 'fixture' },
    question: 'How fast is the stub at concurrency 1?',
    context: {
      'model.requested': 'stub-model',
      concurrency: 1,
      cache_disabled: true,
      client_region: 'local',
    },
    planned: 3,
  });
  assert.equal(planned.ok, true, JSON.stringify(planned));
  const planId = String(planned.data?.['plan_id']);
  assert.match(planId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.deepEqual(planned.data?.['required_context'], {
    known: ['model.requested', 'concurrency', 'cache_disabled', 'client_region'],
    unknown: ['model.reported', 'retry_policy'],
  });
  assert.deepEqual((planned.data?.['estimated_cost'] as Record<string, unknown>)['amount'], 0);
  const execution = planned.data?.['execution'] as { allowed: boolean; next_step: string };
  assert.equal(execution.allowed, false);
  assert.ok(execution.next_step.startsWith(`iwik run --plan ${planId}`));
  assert.equal(loadPlan(home, planId).plan_id, planId);
  assert.equal(stub.stub.stats.requests, 0, 'planning runs nothing');

  // denied by default: the exact operator command comes back
  const denied = await call('run_test', { plan_id: planId });
  assert.equal(denied.ok, false);
  assert.equal(denied.error?.code, 'policy_denied');
  assert.ok(
    denied.error?.next_step?.startsWith(`iwik run --plan ${planId}`),
    denied.error?.next_step,
  );
  assert.match(denied.error?.next_step ?? '', /iwik policy set allow_execution true/);
  assert.match(
    denied.error?.next_step ?? '',
    new RegExp(`iwik policy allow-target 127\\.0\\.0\\.1:${stub.port}`),
  );
  assert.equal(stub.stub.stats.requests, 0, 'a denied run_test runs nothing');

  // allow execution but not the target: still denied, with the allow-target step
  savePolicy(home, {
    allow_execution: true,
    allowed_targets: [],
    budget_per_plan_usd: 0,
    allow_disruptive: false,
  });
  const notAllowed = await call('run_test', { plan_id: planId });
  assert.equal(notAllowed.error?.code, 'target_not_allowed');
  assert.equal(
    notAllowed.error?.next_step,
    `iwik run --plan ${planId} (the operator runs this on the node after: iwik policy allow-target 127.0.0.1:${stub.port})`,
  );

  // the operator enables the policy; the same plan now runs against the stub
  savePolicy(home, {
    allow_execution: true,
    allowed_targets: [`127.0.0.1:${stub.port}`],
    budget_per_plan_usd: 0,
    allow_disruptive: false,
  });
  const ran = await call('run_test', { plan_id: planId });
  assert.equal(ran.ok, true, JSON.stringify(ran));
  const runId = String(ran.data?.['run_id']);
  assert.equal(ran.data?.['plan_id'], planId);
  assert.equal(ran.data?.['execution_status'], 'succeeded');
  assert.deepEqual(ran.data?.['accounting'], {
    planned: 3,
    attempted: 3,
    succeeded: 3,
    failed: 0,
    excluded: 0,
    unobserved: 0,
  });
  assert.equal(ran.data?.['estimated_cost_usd'], 0);
  assert.match(String(ran.data?.['next_step']), new RegExp(`iwik report ${runId}`));
  assert.ok(!JSON.stringify(ran).includes(home), 'no local path in the tool output');
  assert.equal(stub.stub.stats.completions, 3);
  assert.equal(loadPlan(home, planId).runs[0]?.run_id, runId);

  const previewed = await call('preview_contribution', { run_id: runId });
  assert.equal(previewed.ok, true, JSON.stringify(previewed));
  const previewId = String(previewed.data?.['preview_id']);
  assert.match(previewId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  const wire = previewed.data?.['run'] as Run;
  assert.equal(validate('Run', wire).ok, true);
  assert.ok(!('label' in wire.target));
  assert.ok(!JSON.stringify(previewed).includes(stub.url), 'the target URL never appears');
  assert.deepEqual(previewed.data?.['would_store'], { run_id: runId, sharing_policy: 'private' });

  const submitted = await call('submit_run', { run_id: runId });
  assert.equal(submitted.ok, true, JSON.stringify(submitted));
  assert.equal(submitted.data?.['status'], 201);
  const receipt = submitted.data?.['receipt'] as Record<string, unknown>;
  assert.equal(receipt['run_id'], runId);
  assert.deepEqual(readReceipt(home, runId), receipt);
  const again = await call('submit_run', { run_id: runId });
  assert.equal(again.data?.['status'], 200);

  const fetched = await call('get_receipt', { receipt_id: String(receipt['receipt_id']) });
  assert.equal(fetched.ok, true);
  assert.deepEqual(fetched.data?.['receipt'], receipt);

  // submit before preview is an envelope with the next step, not a crash
  const unpreviewed = await call('submit_run', { run_id: '01ARZ3NDEKTSV4RRFFQ69G5ZZZ' });
  assert.equal(unpreviewed.error?.code, 'run_not_found');
  assert.match(unpreviewed.error?.next_step ?? '', /iwik vault/);
  assert.ok(require_ok(vaultPaths(home, runId).receipt));
});

function require_ok(path: string): boolean {
  return readFileSync(path, 'utf8').length > 0;
}

test('withdraw_contribution: real call, reason vocabulary, idempotent set, feature_disabled and not_found with next steps', async () => {
  const runId = [...service.runs.keys()][0];
  assert.ok(runId, 'the full-flow test submitted a run');
  const queriesBefore = service.queries.length;

  const withdrawn = await call('withdraw_contribution', {
    run_ids: [runId],
    reason_code: 'data_error',
  });
  assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
  assert.match(String(withdrawn.data?.['withdrawal_id']), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(typeof withdrawn.data?.['effective_revision'], 'number');
  assert.deepEqual(service.lastBody, { run_ids: [runId], reason_code: 'data_error' });
  assert.equal(service.withdrawals.size, 1);

  // the legacy free-text reason is never sent; the default code goes instead
  const again = await call('withdraw_contribution', {
    run_ids: [runId, runId],
    reason: 'cache was warm',
  });
  assert.equal(again.ok, true);
  assert.equal(again.data?.['withdrawal_id'], withdrawn.data?.['withdrawal_id']);
  assert.deepEqual(service.lastBody, { run_ids: [runId], reason_code: 'member_request' });
  assert.equal(service.withdrawals.size, 1, 'the same set is the same withdrawal');

  // a run that is not ours: not_found with a next step, nothing named
  const foreignId = '01ARZ3NDEKTSV4RRFFQ69G5FXR';
  const foreign = await call('withdraw_contribution', { run_ids: [foreignId] });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.error?.code, 'not_found');
  assert.match(foreign.error?.next_step ?? '', /not a run of your organization/);
  assert.match(foreign.error?.next_step ?? '', /iwik vault/);
  assert.ok(!JSON.stringify(foreign).includes(foreignId));

  // outside the vocabulary: refused by the input schema, nothing sent
  const sent = service.withdrawals.size;
  const bad = await call('withdraw_contribution', { run_ids: [runId], reason_code: 'because' });
  assert.equal(bad.error?.code, 'validation_failed');
  assert.match(bad.error?.message ?? '', /\/reason_code enum/);
  assert.equal(service.withdrawals.size, sent);

  // the deployment has withdrawal switched off
  service.withdrawalEnabled = false;
  try {
    const off = await call('withdraw_contribution', { run_ids: [runId] });
    assert.equal(off.ok, false);
    assert.equal(off.error?.code, 'feature_disabled');
    assert.match(off.error?.next_step ?? '', /IWIK_FEATURE_WITHDRAWAL/);
    assert.match(off.error?.next_step ?? '', /nothing was withdrawn/);
  } finally {
    service.withdrawalEnabled = true;
  }
  assert.equal(service.queries.length, queriesBefore, 'no query was made');
});

test('challenge_finding: frozen input, structured grounds enforced locally, note bounded, real call, feature_disabled and rate_limited with next steps', async () => {
  const receiptId = [...service.receipts.keys()][0];
  assert.ok(receiptId, 'earlier tests issued receipts');
  const filedBefore = service.challenges.size;

  // grounds.kind outside the vocabulary never reaches the service
  const loose = await call('challenge_finding', {
    receipt_id: receiptId,
    grounds: { kind: 'methodology', rationale: 'cache was warm' },
  });
  assert.equal(loose.ok, false);
  assert.equal(loose.error?.code, 'validation_failed');
  assert.match(loose.error?.message ?? '', /\/grounds\/kind enum/);
  assert.match(
    loose.error?.next_step ?? '',
    /method, context_mismatch, data_error, replication_failed, affiliation/,
  );
  assert.equal(service.challenges.size, filedBefore);

  // a note beyond the bound never reaches the service either
  const long = await call('challenge_finding', {
    receipt_id: receiptId,
    grounds: { kind: 'data_error', rationale: 'x'.repeat(501) },
  });
  assert.equal(long.error?.code, 'validation_failed');
  assert.match(long.error?.message ?? '', /\/statement\/note maxLength/);
  assert.equal(service.challenges.size, filedBefore);

  // the real call: the rationale travels as the one bounded note, the
  // structured statement alongside, the target as { kind, id }
  const filed = await call('challenge_finding', {
    receipt_id: receiptId,
    grounds: { kind: 'replication_failed', rationale: 'our own run disagreed' },
    statement: {
      claim: 'latency_distribution',
      metric: 'ttft_ms',
      statistic: 'p95',
      direction: 'higher',
    },
  });
  assert.equal(filed.ok, true, JSON.stringify(filed));
  assert.match(String(filed.data?.['challenge_id']), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(filed.data?.['status'], 'open');
  assert.equal(filed.data?.['grounds'], 'replication_failed');
  assert.deepEqual(service.lastBody, {
    target: { kind: 'receipt', id: receiptId },
    grounds: 'replication_failed',
    statement: {
      claim: 'latency_distribution',
      metric: 'ttft_ms',
      statistic: 'p95',
      direction: 'higher',
      note: 'our own run disagreed',
    },
  });
  assert.equal(service.challenges.size, filedBefore + 1);

  // a claim target
  const claimed = await call('challenge_finding', {
    receipt_id: receiptId,
    claim_id: '01ARZ3NDEKTSV4RRFFQ69G5CM1',
    grounds: { kind: 'method', rationale: 'p50 pooled?' },
  });
  assert.equal(claimed.ok, true, JSON.stringify(claimed));
  assert.deepEqual((service.lastBody as { target: unknown }).target, {
    kind: 'claim',
    id: '01ARZ3NDEKTSV4RRFFQ69G5CM1',
  });

  // a target that is not ours: not_found with a next step, nothing named
  const foreign = await call('challenge_finding', {
    receipt_id: '01ARZ3NDEKTSV4RRFFQ69G5FXR',
    grounds: { kind: 'method', rationale: 'no' },
  });
  assert.equal(foreign.error?.code, 'not_found');
  assert.match(foreign.error?.next_step ?? '', /not one of your organization/);
  assert.ok(!JSON.stringify(foreign).includes('G5FXR'));

  // the sixth in a day: rate_limited with the Retry-After advice
  while (service.challenges.size < 5) {
    const more = await call('challenge_finding', {
      receipt_id: receiptId,
      grounds: { kind: 'data_error', rationale: 'again' },
    });
    assert.equal(more.ok, true);
  }
  const sixth = await call('challenge_finding', {
    receipt_id: receiptId,
    grounds: { kind: 'data_error', rationale: 'once more' },
  });
  assert.equal(sixth.ok, false);
  assert.equal(sixth.error?.code, 'rate_limited');
  assert.match(sixth.error?.next_step ?? '', /5 challenges per organization/);
  assert.equal(service.challenges.size, 5);

  // the deployment has the ledger switched off
  service.challengeEnabled = false;
  try {
    const off = await call('challenge_finding', {
      receipt_id: receiptId,
      grounds: { kind: 'method', rationale: 'no' },
    });
    assert.equal(off.ok, false);
    assert.equal(off.error?.code, 'feature_disabled');
    assert.match(off.error?.next_step ?? '', /IWIK_FEATURE_CHALLENGE/);
    assert.match(off.error?.next_step ?? '', /nothing was sent/);
  } finally {
    service.challengeEnabled = true;
  }
});

test('register_prediction then report_outcome: the prediction goes first, the observation is judged once, the stored prediction is never altered', async () => {
  const receiptId = [...service.receipts.keys()][0];
  assert.ok(receiptId);

  // an outcome without a prediction never reaches the service
  const early = await call('report_outcome', {
    receipt_id: receiptId,
    observation: { p50_ms: 25 },
    observed_at: '2026-09-06T00:00:00Z',
  });
  assert.equal(early.ok, false);
  assert.equal(early.error?.code, 'validation_failed');
  assert.match(early.error?.next_step ?? '', /register_prediction .* BEFORE acting/);
  assert.equal(service.predictions.size, 0);

  const registered = await call('register_prediction', {
    receipt_id: receiptId,
    target: {
      claim: 'latency_distribution',
      metric: 'ttft_ms',
      statistic: 'p95',
      comparator: 'below',
      value: 300,
      unit: 'ms',
    },
    horizon: '2099-01-01',
    probability: 0.7,
    evaluation_rule: 'own_measurement',
  });
  assert.equal(registered.ok, true, JSON.stringify(registered));
  const predictionId = String(registered.data?.['prediction_id']);
  assert.match(predictionId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(registered.data?.['horizon'], '2099-01-01');
  assert.equal(registered.data?.['evaluation_rule'], 'own_measurement');
  assert.deepEqual(service.lastBody, {
    prediction: {
      based_on_receipt_id: receiptId,
      target: {
        claim: 'latency_distribution',
        metric: 'ttft_ms',
        statistic: 'p95',
        comparator: 'below',
        value: 300,
        unit: 'ms',
      },
      horizon: '2099-01-01',
      probability: 0.7,
      evaluation_rule: 'own_measurement',
    },
  });

  // a claim the protocol does not permit: the service's paths come back
  const unknownClaim = await call('register_prediction', {
    receipt_id: receiptId,
    target: { claim: 'throughput' },
    horizon: '2099-01-01',
    evaluation_rule: 'cooperative_requery',
  });
  assert.equal(unknownClaim.error?.code, 'validation_failed');
  assert.match(unknownClaim.error?.message ?? '', /\/prediction\/target\/claim claim_unknown/);
  assert.match(unknownClaim.error?.next_step ?? '', /permitted claims/);

  // the outcome: result and environment_changed may sit inside `observation`
  const reported = await call('report_outcome', {
    receipt_id: receiptId,
    observation: { prediction_id: predictionId, result: 'not_met', environment_changed: true },
    observed_at: '2026-09-28T08:00:00Z',
  });
  assert.equal(reported.ok, true, JSON.stringify(reported));
  assert.match(String(reported.data?.['outcome_id']), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(reported.data?.['prediction_id'], predictionId);
  assert.equal(reported.data?.['result'], 'not_met');
  assert.equal(reported.data?.['environment_changed'], true);
  assert.deepEqual(service.lastBody, {
    prediction_id: predictionId,
    observed: {
      observed_at: '2026-09-28T08:00:00.000Z',
      result: 'not_met',
      environment_changed: true,
    },
    based_on_receipt_id: receiptId,
  });

  // judged exactly once
  const again = await call('report_outcome', {
    receipt_id: receiptId,
    prediction_id: predictionId,
    observation: {},
    result: 'met',
    observed_at: '2026-09-29T08:00:00Z',
  });
  assert.equal(again.error?.code, 'outcome_exists');
  assert.match(again.error?.next_step ?? '', /exactly once/);

  // a different receipt than the one registered: target_mismatch
  const second = await call('register_prediction', {
    receipt_id: receiptId,
    target: { claim: 'error_rate', comparator: 'below', value: 0.05 },
    horizon: '2099-06-01',
    evaluation_rule: 'operational_observation',
  });
  assert.equal(second.ok, true);
  const mismatch = await call('report_outcome', {
    receipt_id: '01ARZ3NDEKTSV4RRFFQ69G5FXR',
    prediction_id: String(second.data?.['prediction_id']),
    observation: {},
    result: 'met',
    observed_at: '2026-09-29T08:00:00Z',
  });
  assert.equal(mismatch.error?.code, 'target_mismatch');
  assert.match(mismatch.error?.next_step ?? '', /cannot be changed/);

  // flag off
  service.challengeEnabled = false;
  try {
    const off = await call('register_prediction', {
      receipt_id: receiptId,
      target: { claim: 'error_rate' },
      horizon: '2099-06-01',
      evaluation_rule: 'own_measurement',
    });
    assert.equal(off.error?.code, 'feature_disabled');
    assert.match(off.error?.next_step ?? '', /IWIK_FEATURE_CHALLENGE/);
  } finally {
    service.challengeEnabled = true;
  }
});
