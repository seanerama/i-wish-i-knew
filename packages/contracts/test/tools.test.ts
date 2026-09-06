// agent-tools v1: the ten tool names of contracts/agent-tools.md, one input
// and one output schema each, committed under contracts/schema/v1/tools/, and
// a validator that never echoes values.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { toolSchemaDocument, toolSchemaFile } from '../src/schema.js';
import { validateTool } from '../src/validate.js';
import { toolNames, tools } from '../src/v1/tools/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const toolsDir = resolve(here, '..', '..', '..', 'contracts', 'schema', 'v1', 'tools');

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
];

test('exactly the ten contract tools, in contract order', () => {
  assert.deepEqual(toolNames, CONTRACT_TOOLS);
  for (const name of toolNames) {
    assert.equal(tools[name].input.type, 'object');
    assert.equal(tools[name].output.type, 'object');
    assert.equal(tools[name].input.additionalProperties, false, `${name}: closed input`);
  }
});

test('every tool has a committed input and output schema equal to the source', () => {
  for (const name of toolNames) {
    for (const side of ['input', 'output'] as const) {
      const file = join(toolsDir, toolSchemaFile(name, side));
      assert.ok(existsSync(file), `${file} missing; run npm run contracts:build`);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), toolSchemaDocument(name, side));
    }
  }
});

test('the output envelope is ok/data or ok/error with code, message, next_step', () => {
  assert.equal(
    validateTool('run_test', 'output', {
      ok: false,
      error: { code: 'policy_denied', message: 'denied', next_step: 'iwik run --plan 01A' },
    }).ok,
    true,
  );
  assert.equal(validateTool('run_test', 'output', { ok: false, data: {} }).ok, false);
  assert.equal(validateTool('run_test', 'output', { ok: true, error: {} }).ok, false);
  assert.equal(
    validateTool('get_receipt', 'output', { ok: true, data: { receipt: { receipt_id: 'x' } } }).ok,
    true,
  );
  // extra keys in the envelope are rejected (smuggling defence, ADR-0005 amendment)
  assert.equal(
    validateTool('get_receipt', 'output', { ok: true, data: { receipt: {} }, extra: 1 }).ok,
    false,
  );
});

test('inputs are validated with paths and rules only', () => {
  const bad = validateTool('plan_test', 'input', {
    protocol_ref: 'nope',
    target: { url: 'http://x', kind: 'planet' },
    question: '',
  });
  assert.equal(bad.ok, false);
  const rules = bad.errors.map((e) => `${e.path} ${e.rule}`);
  assert.ok(rules.includes('/protocol_ref pattern'), rules.join(', '));
  assert.ok(rules.includes('/target/kind enum'), rules.join(', '));
  assert.ok(rules.includes('/question minLength'), rules.join(', '));
  assert.ok(!JSON.stringify(bad).includes('planet'));
  assert.equal(
    validateTool('plan_test', 'input', {
      protocol_ref: 'inference-api/latency@1',
      target: { url: 'http://127.0.0.1:1', kind: 'fixture' },
      question: 'how fast?',
      context: { concurrency: 1 },
    }).ok,
    true,
  );
  assert.equal(
    validateTool('run_test', 'input', { plan_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }).ok,
    true,
  );
  assert.equal(validateTool('run_test', 'input', {}).ok, false);
});
