// Stage 5 service additions: GET /v1/whoami (any valid node token; never the
// org_ref) and the honest POST /v1/evidence/query stub (validates the shape,
// needs scope query, answers insufficient_evidence / no_cooperative_evidence,
// persists a receipt of kind query that GET /v1/receipts/{id} re-reads).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { validate } from '@iwik/contracts';
import pg from 'pg';
import { parseQueryRequest, queryDigest } from '../src/modules/aggregate/index.js';
import { ApiError } from '../src/errors.js';
import {
  authHeader,
  bootEnrollmentApp,
  DATABASE_URL,
  enrollWithNode,
  SEED_NODE_ID,
  SEED_ORG,
  submitRun,
} from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;

before(async () => {
  t = await bootEnrollmentApp();
});

after(async () => {
  await t.app.close();
});

const PROTOCOL = 'inference-api/latency@1';

test('whoami: node id, display name, scopes; never org_ref; 401 without a token', async () => {
  const me = await t.app.inject({ method: 'GET', url: '/v1/whoami', headers: authHeader(t.token) });
  assert.equal(me.statusCode, 200);
  const body = me.json<Record<string, unknown>>();
  assert.deepEqual(body, {
    node_id: SEED_NODE_ID,
    org_display_name: SEED_ORG,
    scopes: ['query', 'submit', 'publish'],
  });
  assert.ok(!('org_ref' in body));
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    const refs = await client.query<{ org_ref: string }>('SELECT org_ref FROM identity.org_refs');
    for (const row of refs.rows) assert.ok(!me.body.includes(row.org_ref), 'org_ref must not leak');
  } finally {
    await client.end();
  }

  const anon = await t.app.inject({ method: 'GET', url: '/v1/whoami' });
  assert.equal(anon.statusCode, 401);
  const bogus = await t.app.inject({
    method: 'GET',
    url: '/v1/whoami',
    headers: authHeader('not-a-token-' + 'z'.repeat(20)),
  });
  assert.equal(bogus.statusCode, 401);
});

test('whoami: a query-only token of a second organization sees its own node and scopes only', async () => {
  const other = await enrollWithNode(t, 'Whoami Org', ['query']);
  const me = await t.app.inject({
    method: 'GET',
    url: '/v1/whoami',
    headers: authHeader(other.token),
  });
  assert.equal(me.statusCode, 200);
  assert.deepEqual(me.json(), {
    node_id: other.node_id,
    org_display_name: 'Whoami Org',
    scopes: ['query'],
  });
});

test('evidence/query: insufficient_evidence with no_cooperative_evidence, valid AnswerReceipt, no result body', async () => {
  // Even with one accepted run of our own, no cooperative cohort exists.
  await submitRun(t);
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/evidence/query',
    headers: authHeader(t.token),
    payload: {
      protocol_ref: PROTOCOL,
      context_filters: { concurrency: 1, 'model.reported': 'stub-model', cache_disabled: true },
    },
  });
  assert.equal(res.statusCode, 200, res.body);
  const receipt = res.json<Record<string, unknown>>();
  assert.deepEqual(validate('AnswerReceipt', receipt), { ok: true, errors: [] });
  assert.equal(receipt['status'], 'insufficient_evidence');
  assert.deepEqual(receipt['suppression_reasons'], ['no_cooperative_evidence']);
  assert.ok(!('result' in receipt), 'no result body');
  assert.deepEqual(receipt['cohort'], {
    protocol_ref: PROTOCOL,
    filters: { concurrency: 1, 'model.reported': 'stub-model', cache_disabled: true },
    orgs: '<3',
    runs: '<5',
  });
  assert.match(String(receipt['query_digest']), /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof receipt['evidence_revision'], 'number');
  // a receipt never names another organization's run, node, or org
  assert.ok(!res.body.includes(SEED_NODE_ID));

  // the same query yields the same digest, a different receipt
  const again = await t.app.inject({
    method: 'POST',
    url: '/v1/evidence/query',
    headers: authHeader(t.token),
    payload: {
      context_filters: { cache_disabled: true, 'model.reported': 'stub-model', concurrency: 1 },
      protocol_ref: PROTOCOL,
    },
  });
  assert.equal(again.statusCode, 200);
  const second = again.json<Record<string, unknown>>();
  assert.equal(second['query_digest'], receipt['query_digest']);
  assert.notEqual(second['receipt_id'], receipt['receipt_id']);

  // persisted as kind query: GET /v1/receipts/{id} re-reads it
  const read = await t.app.inject({
    method: 'GET',
    url: `/v1/receipts/${String(receipt['receipt_id'])}`,
    headers: authHeader(t.token),
  });
  assert.equal(read.statusCode, 200);
  const stored = read.json<Record<string, unknown>>();
  assert.equal(stored['kind'], 'query');
  const answer: Record<string, unknown> = { ...stored };
  delete answer['kind'];
  assert.deepEqual(answer, receipt);

  // another organization cannot read it
  const other = await enrollWithNode(t, 'Query Org', ['query']);
  const foreign = await t.app.inject({
    method: 'GET',
    url: `/v1/receipts/${String(receipt['receipt_id'])}`,
    headers: authHeader(other.token),
  });
  assert.equal(foreign.statusCode, 404);
});

test('evidence/query: scope query required; shape validated with paths and rules only', async () => {
  const noScope = await enrollWithNode(t, 'Submit Only Org', ['submit']);
  const denied = await t.app.inject({
    method: 'POST',
    url: '/v1/evidence/query',
    headers: authHeader(noScope.token),
    payload: { protocol_ref: PROTOCOL },
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json<{ error: { code: string } }>().error.code, 'scope_required');

  const anon = await t.app.inject({
    method: 'POST',
    url: '/v1/evidence/query',
    payload: { protocol_ref: PROTOCOL },
  });
  assert.equal(anon.statusCode, 401);

  const secretish = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const bad = await t.app.inject({
    method: 'POST',
    url: '/v1/evidence/query',
    headers: authHeader(t.token),
    payload: {
      protocol_ref: 'nope',
      investigation_id: 'x',
      context_filters: { concurrency: { nested: secretish } },
      as_of_revision: -1,
      extra: secretish,
    },
  });
  assert.equal(bad.statusCode, 422);
  const envelope = bad.json<{
    error: { code: string; details: Array<{ path: string; rule: string }> };
  }>();
  assert.equal(envelope.error.code, 'validation_failed');
  const rules = envelope.error.details.map((d) => `${d.path} ${d.rule}`);
  assert.ok(rules.includes('/protocol_ref pattern'), rules.join(', '));
  assert.ok(rules.includes('/investigation_id pattern'), rules.join(', '));
  assert.ok(rules.includes('/context_filters/concurrency type'), rules.join(', '));
  assert.ok(rules.includes('/as_of_revision minimum'), rules.join(', '));
  assert.ok(rules.includes(' additionalProperties'), rules.join(', '));
  assert.ok(!bad.body.includes(secretish), 'error body never echoes values');

  const unknown = await t.app.inject({
    method: 'POST',
    url: '/v1/evidence/query',
    headers: authHeader(t.token),
    payload: { protocol_ref: 'other-pack/thing@1' },
  });
  assert.equal(unknown.statusCode, 422);
  assert.deepEqual(unknown.json<{ error: { details: unknown } }>().error.details, [
    { path: '/protocol_ref', rule: 'protocol_unknown' },
  ]);

  const notJson = await t.app.inject({
    method: 'POST',
    url: '/v1/evidence/query',
    headers: { ...authHeader(t.token), 'content-type': 'application/json' },
    payload: '[1,2',
  });
  assert.equal(notJson.statusCode, 400);
});

test('parseQueryRequest normalizes and queryDigest is order-independent', () => {
  const a = parseQueryRequest({ protocol_ref: PROTOCOL, context_filters: { b: 1, a: 'x' } });
  const b = parseQueryRequest({ context_filters: { a: 'x', b: 1 }, protocol_ref: PROTOCOL });
  assert.equal(queryDigest(a), queryDigest(b));
  assert.notEqual(queryDigest(a), queryDigest(parseQueryRequest({ protocol_ref: PROTOCOL })));
  assert.throws(
    () => parseQueryRequest([]),
    (e: unknown) => e instanceof ApiError && e.status === 422,
  );
  assert.throws(
    () => parseQueryRequest({}),
    (e: unknown) => e instanceof ApiError && e.status === 422,
  );
});
