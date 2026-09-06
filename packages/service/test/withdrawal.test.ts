// Stage 7: POST /v1/withdrawals behind IWIK_FEATURE_WITHDRAWAL, revision-keyed
// stale receipts, the console withdraw form, and the MCP tool end-to-end
// against this service over a real socket.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Run } from '@iwik/contracts';
import { validate } from '@iwik/contracts';
import { callTool, init as runnerInit } from '@iwik/runner';
import { loadConfig } from '../src/config.js';
import { currentRevision } from '../src/modules/intake/index.js';
import { buildHandlers } from '../src/modules/jobs/handlers.js';
import { JobRunner, getJob } from '../src/modules/jobs/index.js';
import { normalizeRunIds, parseWithdrawalBody } from '../src/modules/withdrawal/index.js';
import { ApiError } from '../src/errors.js';
import { ulid } from '../src/ulid.js';
import {
  assertNoEcho,
  authHeader,
  bootApp,
  bootEnrollmentApp,
  browse,
  CookieJar,
  DATABASE_URL,
  enrollWithNode,
  handlerDeps,
  postForm,
  prepareRun,
  repoRoot,
  SEED_NODE_ID,
  SEED_NODE_TOKEN,
  submitRun,
} from './helpers.js';
import type { TestApp } from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';
const cliPath = resolve(repoRoot, 'packages', 'runner', 'bin', 'iwik.cjs');

let t: TestApp;

before(async () => {
  t = await bootEnrollmentApp({ env: { IWIK_FEATURE_WITHDRAWAL: 'on' } });
});

after(async () => {
  await t.app.close();
});

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; next_step?: string };
}

/** The fixture with a fresh run_id and attempt_id so several runs can be accepted. */
async function freshRun(
  app: TestApp,
  identity: { nodeId?: string; token?: string } = {},
  patch: (run: Run) => void = () => {},
): Promise<Run> {
  const run = await prepareRun(app, identity);
  run.run_id = ulid();
  run.attempt_id = ulid();
  patch(run);
  return run;
}

async function post(app: TestApp, token: string, payload: Record<string, unknown>) {
  return app.app.inject({
    method: 'POST',
    url: '/v1/withdrawals',
    headers: authHeader(token),
    payload,
  });
}

async function query(app: TestApp, token: string = app.token) {
  const res = await app.app.inject({
    method: 'POST',
    url: '/v1/evidence/query',
    headers: authHeader(token),
    payload: { protocol_ref: PROTOCOL, context_filters: { concurrency: 1 } },
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<Record<string, unknown>>();
}

async function readReceipt(app: TestApp, id: string, token: string = app.token) {
  const res = await app.app.inject({
    method: 'GET',
    url: `/v1/receipts/${id}`,
    headers: authHeader(token),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<Record<string, unknown>>();
}

async function runRow(runId: string) {
  const res = await t.app.iwik.pool.query<{
    withdrawn_at: Date | null;
    withdrawn_revision: string | null;
    sharing_policy: string;
    backfill_version: number | null;
  }>(
    `SELECT withdrawn_at, withdrawn_revision, sharing_policy, backfill_version
       FROM evidence.runs WHERE run_id = $1`,
    [runId],
  );
  return res.rows[0];
}

test('flag default: IWIK_FEATURE_WITHDRAWAL is off in every environment', () => {
  const base = { DATABASE_URL, IWIK_KEK: '0'.repeat(64) };
  for (const NODE_ENV of ['production', 'development', 'test']) {
    assert.equal(loadConfig({ ...base, NODE_ENV }).featureWithdrawal, false, NODE_ENV);
  }
  assert.equal(loadConfig({ ...base, IWIK_FEATURE_WITHDRAWAL: 'on' }).featureWithdrawal, true);
  assert.equal(loadConfig({ ...base }).workerIntervalMs, 5000);
  assert.equal(loadConfig({ ...base, IWIK_WORKER_INTERVAL_MS: '250' }).workerIntervalMs, 250);
  assert.throws(() => loadConfig({ ...base, IWIK_WORKER_INTERVAL_MS: '0' }), /positive integer/);
});

test('body validation: paths and rules only; the set is normalized', () => {
  const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const bad = (body: unknown) => {
    try {
      parseWithdrawalBody(body);
    } catch (e) {
      assert.ok(e instanceof ApiError && e.status === 422);
      const text = JSON.stringify(e.toEnvelope());
      assert.ok(!text.includes(secret));
      return e.details?.map((d) => `${d.path} ${d.rule}`) ?? [];
    }
    throw new Error('expected 422');
  };
  assert.deepEqual(bad([]), [' type']);
  assert.deepEqual(bad({}), ['/run_ids required', '/reason_code required']);
  assert.deepEqual(bad({ run_ids: [], reason_code: secret }), [
    '/run_ids minItems',
    '/reason_code enum',
  ]);
  assert.deepEqual(bad({ run_ids: [secret, 7], reason_code: 'data_error', extra: 1 }), [
    ' additionalProperties',
    '/run_ids/0 pattern',
    '/run_ids/1 pattern',
  ]);
  assert.deepEqual(
    bad({ run_ids: Array.from({ length: 101 }, () => ulid()), reason_code: 'data_error' }),
    ['/run_ids maxItems'],
  );
  const a = ulid();
  const b = ulid();
  assert.deepEqual(parseWithdrawalBody({ run_ids: [b, a, b], reason_code: 'policy_change' }), {
    run_ids: [a, b].sort(),
    reason_code: 'policy_change',
  });
  assert.deepEqual(normalizeRunIds([b, a, a]), [a, b].sort());
});

test('withdraw two of three: one revision, withdrawn_revision on the rows, query receipt stale, intake receipt not, idempotent on the set', async () => {
  const first = await submitRun(t, await freshRun(t));
  const second = await submitRun(t, await freshRun(t));
  const third = await submitRun(t, await freshRun(t));
  const ids = [first.run.run_id, second.run.run_id, third.run.run_id];
  const before = await currentRevision(t.app.iwik.pool);
  assert.equal(before, 3);
  const answer = await query(t);
  assert.equal(answer['evidence_revision'], 3);
  assert.equal(answer['status'], 'insufficient_evidence');

  const res = await post(t, t.token, { run_ids: [ids[0], ids[1]], reason_code: 'member_request' });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json<{ withdrawal_id: string; effective_revision: number }>();
  assert.deepEqual(Object.keys(body).sort(), ['effective_revision', 'withdrawal_id']);
  assert.match(body.withdrawal_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(body.effective_revision, 4);
  for (const id of ids) assert.ok(!res.body.includes(id), 'the response never lists run ids');
  assert.equal(await currentRevision(t.app.iwik.pool), 4, 'exactly one increment');

  const r1 = await runRow(ids[0] as string);
  const r2 = await runRow(ids[1] as string);
  const r3 = await runRow(ids[2] as string);
  assert.ok(r1?.withdrawn_at instanceof Date);
  assert.equal(Number(r1?.withdrawn_revision), 4);
  assert.equal(Number(r2?.withdrawn_revision), 4);
  assert.equal(r3?.withdrawn_at, null);
  assert.equal(r3?.withdrawn_revision, null);
  // intake wrote the sharing policy and marked the column trustworthy
  assert.equal(r3?.sharing_policy, 'private');
  assert.equal(r3?.backfill_version, 1);

  // the revision log carries one withdrawal row for the protocol at revision 4
  const log = await t.app.iwik.pool.query<{ revision: string; protocol_ref: string; kind: string }>(
    `SELECT revision, protocol_ref, kind FROM evidence.revision_log ORDER BY revision`,
  );
  assert.deepEqual(
    log.rows.map((r) => `${r.revision} ${r.protocol_ref} ${r.kind}`),
    [
      `1 ${PROTOCOL} intake`,
      `2 ${PROTOCOL} intake`,
      `3 ${PROTOCOL} intake`,
      `4 ${PROTOCOL} withdrawal`,
    ],
  );

  // the query receipt issued at revision 3 now reads stale and nothing else changes
  const stale = await readReceipt(t, String(answer['receipt_id']));
  assert.equal(stale['status'], 'stale');
  const restored: Record<string, unknown> = { ...stale, status: 'insufficient_evidence' };
  delete restored['kind'];
  assert.deepEqual(restored, answer);
  const withoutKind: Record<string, unknown> = { ...stale };
  delete withoutKind['kind'];
  assert.deepEqual(validate('AnswerReceipt', withoutKind), { ok: true, errors: [] });
  for (const id of ids) assert.ok(!JSON.stringify(stale).includes(id), 'stale says nothing');
  // the stored row is untouched: staleness is computed on read
  const stored = await t.app.iwik.pool.query<{ status: string }>(
    `SELECT status FROM evidence.receipts WHERE receipt_id = $1`,
    [answer['receipt_id']],
  );
  assert.equal(stored.rows[0]?.status, 'insufficient_evidence');

  // intake receipts never go stale
  const intake = await readReceipt(t, String(first.receipt['receipt_id']));
  assert.equal(intake['status'], 'accepted');
  assert.equal(intake['kind'], 'intake');

  // a query answered after the withdrawal is current
  const fresh = await query(t);
  assert.equal(fresh['evidence_revision'], 4);
  const reread = await readReceipt(t, String(fresh['receipt_id']));
  assert.equal(reread['status'], 'insufficient_evidence');

  // GET /v1/runs/{id} shows the marks (additive fields) for withdrawn runs only
  const withdrawnRun = await t.app.inject({
    method: 'GET',
    url: `/v1/runs/${ids[0]}`,
    headers: authHeader(t.token),
  });
  assert.equal(withdrawnRun.statusCode, 200);
  const shown = withdrawnRun.json<Record<string, unknown>>();
  assert.equal(shown['withdrawn_revision'], 4);
  assert.match(String(shown['withdrawn_at']), /^\d{4}-\d{2}-\d{2}T/);
  const keptRun = await t.app.inject({
    method: 'GET',
    url: `/v1/runs/${ids[2]}`,
    headers: authHeader(t.token),
  });
  assert.ok(!('withdrawn_at' in keptRun.json<Record<string, unknown>>()));

  // idempotent on the set: reversed order and a duplicate are the same withdrawal
  const again = await post(t, t.token, {
    run_ids: [ids[1], ids[0], ids[1]],
    reason_code: 'data_error',
  });
  assert.equal(again.statusCode, 200, again.body);
  assert.deepEqual(again.json(), body);
  assert.equal(await currentRevision(t.app.iwik.pool), 4);
  const withdrawals = await t.app.iwik.pool.query<{ reason_code: string; run_ids: string[] }>(
    `SELECT reason_code, run_ids FROM evidence.withdrawals`,
  );
  assert.equal(withdrawals.rows.length, 1);
  assert.equal(withdrawals.rows[0]?.reason_code, 'member_request');
  assert.deepEqual(withdrawals.rows[0]?.run_ids, [ids[0], ids[1]].sort());

  // a withdrawal_apply job was queued once; running it evicts cache rows of
  // the protocol computed before the effective revision and nothing else
  const jobs = await t.app.iwik.pool.query<{
    kind: string;
    state: string;
    idempotency_key: string;
  }>(`SELECT kind, state, idempotency_key FROM jobs WHERE kind = 'withdrawal_apply'`);
  assert.deepEqual(jobs.rows, [
    {
      kind: 'withdrawal_apply',
      state: 'queued',
      idempotency_key: `withdrawal_apply:${body.withdrawal_id}`,
    },
  ]);
  const pool = t.app.iwik.pool;
  await pool.query(
    `INSERT INTO evidence.cache (key, protocol_ref, revision, payload) VALUES
       ('old', $1, 3, '{}'), ('current', $1, 4, '{}'), ('other', 'other-pack/x@1', 1, '{}')`,
    [PROTOCOL],
  );
  const runner = new JobRunner(pool, {
    handlers: buildHandlers(handlerDeps(t)),
  });
  assert.equal(await runner.drain(), 1);
  const cache = await pool.query<{ key: string }>(`SELECT key FROM evidence.cache ORDER BY key`);
  assert.deepEqual(
    cache.rows.map((r) => r.key),
    ['current', 'other'],
  );
  const applied = await pool.query<{ state: string; attempts: number }>(
    `SELECT state, attempts FROM jobs WHERE kind = 'withdrawal_apply'`,
  );
  assert.deepEqual(applied.rows, [{ state: 'done', attempts: 1 }]);
  assert.equal(Number((await runRow(ids[0] as string))?.withdrawn_revision), 4, 'marks unchanged');
});

test('a foreign or unknown run id in the set: 404, nothing withdrawn, nothing named', async () => {
  const other = await enrollWithNode(t, 'Other Withdraw Org', ['query', 'submit', 'publish']);
  const theirs = await submitRun(
    t,
    await freshRun(t, { nodeId: other.node_id, token: other.token }),
    {
      token: other.token,
      key: other.key,
    },
  );
  const mine = await submitRun(t, await freshRun(t));
  const revision = await currentRevision(t.app.iwik.pool);

  const mixed = await post(t, t.token, {
    run_ids: [mine.run.run_id, theirs.run.run_id],
    reason_code: 'member_request',
  });
  assert.equal(mixed.statusCode, 404, mixed.body);
  assert.deepEqual(mixed.json(), {
    error: { code: 'not_found', message: 'resource not found' },
  });
  assertNoEcho(mixed.body, { run_ids: [mine.run.run_id, theirs.run.run_id] });

  const unknown = await post(t, t.token, { run_ids: [ulid()], reason_code: 'member_request' });
  assert.equal(unknown.statusCode, 404);

  const theirsOnMine = await post(t, other.token, {
    run_ids: [mine.run.run_id],
    reason_code: 'member_request',
  });
  assert.equal(theirsOnMine.statusCode, 404);

  assert.equal(await currentRevision(t.app.iwik.pool), revision, 'no revision moved');
  assert.equal((await runRow(mine.run.run_id))?.withdrawn_at, null);
  assert.equal((await runRow(theirs.run.run_id))?.withdrawn_at, null);
  const rows = await t.app.iwik.pool.query(`SELECT 1 FROM evidence.withdrawals`);
  assert.equal(rows.rows.length, 1, 'only the earlier withdrawal exists');

  // the other organization can withdraw its own run
  const own = await post(t, other.token, {
    run_ids: [theirs.run.run_id],
    reason_code: 'data_error',
  });
  assert.equal(own.statusCode, 201, own.body);
  assert.equal(own.json<{ effective_revision: number }>().effective_revision, revision + 1);
});

test('scope publish is required; the JSON shape is validated; error bodies never echo values', async () => {
  const queryOnly = await enrollWithNode(t, 'Query Only Withdraw Org', ['query', 'submit']);
  const denied = await post(t, queryOnly.token, {
    run_ids: [ulid()],
    reason_code: 'member_request',
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json<{ error: { code: string } }>().error.code, 'scope_required');

  const anon = await t.app.inject({ method: 'POST', url: '/v1/withdrawals', payload: {} });
  assert.equal(anon.statusCode, 401);

  const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const bad = await post(t, t.token, { run_ids: [secret], reason_code: secret, note: secret });
  assert.equal(bad.statusCode, 422);
  const envelope = bad.json<{
    error: { code: string; details: Array<{ path: string; rule: string }> };
  }>();
  assert.equal(envelope.error.code, 'validation_failed');
  assert.deepEqual(
    envelope.error.details.map((d) => `${d.path} ${d.rule}`),
    [' additionalProperties', '/run_ids/0 pattern', '/reason_code enum'],
  );
  assert.ok(!bad.body.includes(secret));

  const notJson = await t.app.inject({
    method: 'POST',
    url: '/v1/withdrawals',
    headers: { ...authHeader(t.token), 'content-type': 'application/json' },
    payload: '{',
  });
  assert.equal(notJson.statusCode, 400);
});

test('console /org: own runs listed, withdraw form needs a confirmation, CSRF, and only own runs', async () => {
  const org = await enrollWithNode(t, 'Console Withdraw Org', ['query', 'submit', 'publish']);
  const a = await submitRun(t, await freshRun(t, { nodeId: org.node_id, token: org.token }), {
    token: org.token,
    key: org.key,
  });
  const b = await submitRun(t, await freshRun(t, { nodeId: org.node_id, token: org.token }), {
    token: org.token,
    key: org.key,
  });
  const seedRun = await submitRun(t, await freshRun(t));

  const page = await browse(t, org.jar, '/org');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /id="withdraw-form"/);
  assert.match(page.body, /id="runs"/);
  assert.match(page.body, new RegExp(`id="run-${a.run.run_id}" class="active"`));
  assert.match(page.body, new RegExp(`name="run_ids" value="${b.run.run_id}"`));
  assert.match(page.body, /<td>inference-api\/latency@1<\/td>/);
  assert.match(page.body, /<td>succeeded<\/td>/);
  assert.match(page.body, /<td>private<\/td>/);
  assert.ok(!page.body.includes(seedRun.run.run_id), 'another organization’s run is never listed');
  for (const code of ['member_request', 'data_error', 'policy_change']) {
    assert.match(page.body, new RegExp(`<option value="${code}">`));
  }

  // no confirmation: refused, nothing withdrawn
  const unconfirmed = await postForm(t, org.jar, '/org/withdrawals', {
    run_ids: a.run.run_id,
    reason_code: 'member_request',
  });
  assert.equal(unconfirmed.statusCode, 303);
  assert.equal(unconfirmed.headers.location, '/org?error=withdraw_confirm');
  assert.equal((await runRow(a.run.run_id))?.withdrawn_at, null);
  const errorPage = await browse(t, org.jar, '/org?error=withdraw_confirm');
  assert.match(errorPage.body, /id="error">[\s\S]*Tick the confirmation box/);

  // no reason
  const noReason = await postForm(t, org.jar, '/org/withdrawals', {
    run_ids: a.run.run_id,
    confirm: 'on',
  });
  assert.equal(noReason.headers.location, '/org?error=withdraw_reason');

  // nothing selected
  const nothing = await postForm(t, org.jar, '/org/withdrawals', {
    reason_code: 'member_request',
    confirm: 'on',
  });
  assert.equal(nothing.headers.location, '/org?error=withdraw_runs');

  // another organization's run through the form: refused, not withdrawn
  const foreign = await postForm(t, org.jar, '/org/withdrawals', {
    run_ids: seedRun.run.run_id,
    reason_code: 'member_request',
    confirm: 'on',
  });
  assert.equal(foreign.headers.location, '/org?error=withdraw_runs');
  assert.equal((await runRow(seedRun.run.run_id))?.withdrawn_at, null);

  // without the CSRF field
  const csrfless = await postForm(
    t,
    org.jar,
    '/org/withdrawals',
    { run_ids: a.run.run_id, reason_code: 'member_request', confirm: 'on' },
    { csrf: null },
  );
  assert.equal(csrfless.statusCode, 403);
  assert.equal(csrfless.json<{ error: { code: string } }>().error.code, 'csrf_failed');
  assert.equal((await runRow(a.run.run_id))?.withdrawn_at, null);

  // confirmed: recorded, listed as withdrawn, checkbox gone
  const revision = await currentRevision(t.app.iwik.pool);
  const done = await postForm(t, org.jar, '/org/withdrawals', {
    run_ids: a.run.run_id,
    reason_code: 'policy_change',
    confirm: 'on',
  });
  assert.equal(done.statusCode, 303, done.body);
  assert.equal(done.headers.location, '/org?notice=withdrawn');
  assert.equal(Number((await runRow(a.run.run_id))?.withdrawn_revision), revision + 1);
  assert.equal((await runRow(b.run.run_id))?.withdrawn_at, null);
  const after = await browse(t, org.jar, '/org?notice=withdrawn');
  assert.match(after.body, /id="notice">[\s\S]*Withdrawal recorded/);
  assert.match(after.body, new RegExp(`id="run-${a.run.run_id}" class="withdrawn"`));
  assert.match(after.body, new RegExp(`withdrawn \\S+ \\(revision ${revision + 1}\\)`));
  assert.ok(!after.body.includes(`value="${a.run.run_id}"`), 'no checkbox for a withdrawn run');
  assert.match(after.body, new RegExp(`name="run_ids" value="${b.run.run_id}"`));

  // the same set again is the same withdrawal
  const repeat = await postForm(t, org.jar, '/org/withdrawals', {
    run_ids: a.run.run_id,
    reason_code: 'member_request',
    confirm: 'on',
  });
  assert.equal(repeat.headers.location, '/org?notice=already_withdrawn');
  assert.equal(await currentRevision(t.app.iwik.pool), revision + 1);

  // signed out: the form redirects to login
  const stranger = new CookieJar();
  await browse(t, stranger, '/');
  const anon = await postForm(t, stranger, '/org/withdrawals', {
    run_ids: b.run.run_id,
    reason_code: 'member_request',
    confirm: 'on',
  });
  assert.equal(anon.statusCode, 303);
  assert.equal(anon.headers.location, '/console/login');
});

test('MCP withdraw_contribution end-to-end: iwik mcp over stdio against this service', async () => {
  const serviceUrl = await t.app.listen({ port: 0, host: '127.0.0.1' });
  const base = mkdtempSync(join(tmpdir(), 'iwik-withdraw-'));
  const home = join(base, 'home');
  const tokenFile = join(base, 'token.txt');
  writeFileSync(tokenFile, SEED_NODE_TOKEN + '\n', { mode: 0o600 });
  runnerInit({ home, serviceUrl, tokenFile, nodeId: SEED_NODE_ID });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cliPath, '--home', home, 'mcp'],
    env: { PATH: process.env['PATH'] ?? '', IWIK_MCP_ENABLED: 'on' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'iwik-withdrawal-test', version: '0.0.0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>): Promise<Envelope> => {
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent as Envelope;
  };
  try {
    const mine = await submitRun(t, await freshRun(t));
    const other = await enrollWithNode(t, 'MCP Other Org', ['query', 'submit', 'publish']);
    const theirs = await submitRun(
      t,
      await freshRun(t, { nodeId: other.node_id, token: other.token }),
      {
        token: other.token,
        key: other.key,
      },
    );
    const answer = await query(t);
    const revision = await currentRevision(t.app.iwik.pool);

    const withdrawn = await call('withdraw_contribution', {
      run_ids: [mine.run.run_id],
      reason_code: 'data_error',
    });
    assert.equal(withdrawn.ok, true, JSON.stringify(withdrawn));
    assert.deepEqual(Object.keys(withdrawn.data ?? {}).sort(), [
      'effective_revision',
      'withdrawal_id',
    ]);
    assert.equal(withdrawn.data?.['effective_revision'], revision + 1);
    const withdrawalId = String(withdrawn.data?.['withdrawal_id']);
    assert.equal(Number((await runRow(mine.run.run_id))?.withdrawn_revision), revision + 1);
    const stored = await t.app.iwik.pool.query<{ reason_code: string }>(
      `SELECT reason_code FROM evidence.withdrawals WHERE withdrawal_id = $1`,
      [withdrawalId],
    );
    assert.equal(stored.rows[0]?.reason_code, 'data_error');

    // the query receipt from before reads stale through get_receipt
    const stale = await call('get_receipt', { receipt_id: String(answer['receipt_id']) });
    assert.equal(stale.ok, true);
    assert.equal((stale.data?.['receipt'] as Record<string, unknown>)['status'], 'stale');

    // same set again (legacy free-text reason is never sent): same withdrawal
    const again = await call('withdraw_contribution', {
      run_ids: [mine.run.run_id],
      reason: 'cache was warm',
    });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.data?.['withdrawal_id'], withdrawalId);
    assert.equal(await currentRevision(t.app.iwik.pool), revision + 1);

    // another organization's run: not_found, nothing withdrawn, id not echoed
    const foreign = await call('withdraw_contribution', {
      run_ids: [theirs.run.run_id],
      reason_code: 'member_request',
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error?.code, 'not_found');
    assert.match(foreign.error?.next_step ?? '', /not a run of your organization/);
    assert.ok(!JSON.stringify(foreign).includes(theirs.run.run_id));
    assert.equal((await runRow(theirs.run.run_id))?.withdrawn_at, null);

    // a reason outside the vocabulary is refused by the input schema before any request
    const bad = await call('withdraw_contribution', {
      run_ids: [mine.run.run_id],
      reason_code: 'because',
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error?.code, 'validation_failed');
    assert.match(bad.error?.message ?? '', /\/reason_code enum/);
  } finally {
    await client.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('IWIK_FEATURE_WITHDRAWAL off: endpoint 404 feature_disabled before auth, console form hidden, tool says feature_disabled', async () => {
  const off = await bootApp({
    reset: false,
    nodeKey: t.nodeKey,
    env: { IWIK_FEATURE_ENROLLMENT: 'on' },
  });
  const base = mkdtempSync(join(tmpdir(), 'iwik-withdraw-off-'));
  try {
    const anon = await off.app.inject({ method: 'POST', url: '/v1/withdrawals', payload: {} });
    assert.equal(anon.statusCode, 404);
    assert.deepEqual(anon.json(), {
      error: { code: 'feature_disabled', message: 'this feature is disabled on this deployment' },
    });
    const mine = await submitRun(off, await freshRun(off));
    const authed = await post(off, off.token, {
      run_ids: [mine.run.run_id],
      reason_code: 'member_request',
    });
    assert.equal(authed.statusCode, 404);
    assert.equal(authed.json<{ error: { code: string } }>().error.code, 'feature_disabled');
    assert.equal((await runRow(mine.run.run_id))?.withdrawn_at, null);

    // console: runs listed, no form, a clear disabled note; the form route is 404
    const org = await enrollWithNode(off, 'Flag Off Org', ['query', 'submit', 'publish']);
    const run = await submitRun(
      off,
      await freshRun(off, { nodeId: org.node_id, token: org.token }),
      {
        token: org.token,
        key: org.key,
      },
    );
    const page = await browse(off, org.jar, '/org');
    assert.equal(page.statusCode, 200);
    assert.match(page.body, new RegExp(`id="run-${run.run.run_id}"`));
    assert.ok(!page.body.includes('id="withdraw-form"'));
    assert.match(page.body, /id="withdrawal-disabled">Withdrawal is disabled/);
    const form = await postForm(off, org.jar, '/org/withdrawals', {
      run_ids: run.run.run_id,
      reason_code: 'member_request',
      confirm: 'on',
    });
    assert.equal(form.statusCode, 404);
    assert.equal(form.json<{ error: { code: string } }>().error.code, 'feature_disabled');
    const home = await off.app.inject({ method: 'GET', url: '/' });
    assert.match(home.body, /id="withdrawal-state">disabled \(IWIK_FEATURE_WITHDRAWAL=off\)</);

    // the tool: ok false, feature_disabled, with a next step
    const serviceUrl = await off.app.listen({ port: 0, host: '127.0.0.1' });
    const tokenFile = join(base, 'token.txt');
    writeFileSync(tokenFile, SEED_NODE_TOKEN + '\n', { mode: 0o600 });
    const runnerHome = join(base, 'home');
    runnerInit({ home: runnerHome, serviceUrl, tokenFile, nodeId: SEED_NODE_ID });
    const envelope = (await callTool(
      'withdraw_contribution',
      { run_ids: [mine.run.run_id], reason_code: 'member_request' },
      { home: runnerHome },
    )) as Envelope;
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error?.code, 'feature_disabled');
    assert.match(envelope.error?.next_step ?? '', /IWIK_FEATURE_WITHDRAWAL/);
    assert.match(envelope.error?.next_step ?? '', /nothing was withdrawn/);
  } finally {
    await off.app.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('the flag-on app is still consistent after the flag-off app shared its database', async () => {
  const flagOn = await t.app.inject({ method: 'GET', url: '/' });
  assert.match(flagOn.body, /id="withdrawal-state">enabled</);
  const job = await t.app.iwik.pool.query<{ job_id: string }>(
    `SELECT job_id FROM jobs WHERE kind = 'withdrawal_apply' ORDER BY created_at LIMIT 1`,
  );
  assert.ok(job.rows[0]);
  assert.equal((await getJob(t.app.iwik.pool, job.rows[0].job_id))?.state, 'done');
});
