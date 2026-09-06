// The stage-2 spine against a real PostgreSQL: preview -> submit -> receipt,
// idempotency, preview binding, signature, sanitization, accounting, registry
// checks, organization isolation, and the error-envelope no-echo rule.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Run } from '@iwik/contracts';
import { createNode, createOrganization, issueToken } from '../src/modules/identity/index.js';
import { contentDigest } from '../src/modules/intake/index.js';
import {
  assertNoEcho,
  authHeader,
  bootApp,
  generateNodeKey,
  prepareRun,
  preview,
  signRun,
  submit,
  submitRun,
} from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;

before(async () => {
  t = await bootApp();
});

after(async () => {
  await t.app.close();
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('readiness: migrations applied, registry loaded, openapi served', async () => {
  const ready = await t.app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), { ok: true });

  const health = await t.app.inject({ method: 'GET', url: '/healthz' });
  assert.deepEqual(health.json(), { ok: true });

  const protocols = await t.app.inject({
    method: 'GET',
    url: '/v1/protocols',
    headers: authHeader(t.token),
  });
  assert.equal(protocols.statusCode, 200);
  const list = protocols.json<{ protocols: Array<{ ref: string; protocol_digest: string }> }>();
  assert.deepEqual(
    list.protocols.map((p) => p.ref),
    ['inference-api/latency@1'],
  );

  const encoded = await t.app.inject({
    method: 'GET',
    url: '/v1/protocols/inference-api%2Flatency%401',
    headers: authHeader(t.token),
  });
  assert.equal(encoded.statusCode, 200);
  const one = encoded.json<{ ref: string; pack: { pack_digest: string; download: unknown } }>();
  assert.equal(one.ref, 'inference-api/latency@1');
  assert.match(one.pack.pack_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(one.pack.download, { kind: 'repository_path', path: 'packs/inference-api' });

  const openapi = await t.app.inject({ method: 'GET', url: '/v1/openapi.json' });
  assert.equal(openapi.statusCode, 200);
  assert.equal(openapi.json<{ openapi: string }>().openapi, '3.1.0');
});

test('auth: missing token 401, wrong scope 403 scope_required, unknown route 404', async () => {
  const anon = await t.app.inject({ method: 'GET', url: '/v1/protocols' });
  assert.equal(anon.statusCode, 401);
  assert.equal(anon.json<{ error: { code: string } }>().error.code, 'unauthorized');

  const bogus = await t.app.inject({
    method: 'GET',
    url: '/v1/protocols',
    headers: authHeader('not-a-real-token-value-0000000000'),
  });
  assert.equal(bogus.statusCode, 401);

  const { pool } = t.app.iwik;
  const org = await createOrganization(pool, 'Query Only Org');
  const nodeId = await createNode(pool, org.org_id, generateNodeKey().pubkey);
  const queryOnly = await issueToken(pool, nodeId, ['query']);
  const run = await prepareRun(t);
  const denied = await preview(t, run, queryOnly);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(denied.json(), {
    error: {
      code: 'scope_required',
      message: 'token lacks the required scope',
      details: [{ path: '', rule: 'scope:submit' }],
    },
  });

  const missing = await t.app.inject({
    method: 'GET',
    url: '/v1/nope',
    headers: authHeader(t.token),
  });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json<{ error: { code: string } }>().error.code, 'not_found');
});

test('spine: preview -> 201 -> 200 same receipt -> 409 preview_mismatch -> 401 -> 422s', async () => {
  const run = await prepareRun(t);
  const revisionBefore = await t.app.inject({ method: 'GET', url: '/' });
  assert.match(revisionBefore.body, /id="evidence-revision">0</);

  // preview
  const p = await preview(t, run);
  assert.equal(p.statusCode, 200, p.body);
  const previewBody = p.json<{
    preview_id: string;
    content_digest: string;
    validation: { ok: boolean };
    sanitization: { strings_checked: number; rules: string[] };
    would_store: { sharing_policy: string; target_kind: string };
  }>();
  assert.equal(previewBody.content_digest, contentDigest(run));
  assert.equal(previewBody.validation.ok, true);
  assert.ok(previewBody.sanitization.strings_checked > 20);
  assert.deepEqual(previewBody.sanitization.rules, ['secret_pattern', 'string_too_long']);
  // fixture target => stored private regardless of the requested policy
  assert.equal(run.submission.sharing_policy, 'cooperative');
  assert.equal(previewBody.would_store.target_kind, 'fixture');
  assert.equal(previewBody.would_store.sharing_policy, 'private');

  // submit 201
  const signed = signRun(run, t.nodeKey);
  const s1 = await submit(t, previewBody.preview_id, signed);
  assert.equal(s1.statusCode, 201, s1.body);
  const receipt = s1.json<Record<string, unknown>>();
  assert.equal(receipt['kind'], 'intake');
  assert.equal(receipt['status'], 'accepted');
  assert.equal(receipt['run_id'], run.run_id);
  assert.equal(receipt['content_digest'], previewBody.content_digest);
  assert.equal(receipt['sharing_policy'], 'private');
  assert.equal(receipt['evidence_revision'], 1);
  assert.match(String(receipt['receipt_id']), /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(!('org_ref' in receipt) && !('node_id' in receipt));

  // resubmit: 200, identical receipt, no second revision
  const s2 = await submit(t, previewBody.preview_id, signed);
  assert.equal(s2.statusCode, 200, s2.body);
  assert.deepEqual(s2.json(), receipt);
  const page = await t.app.inject({ method: 'GET', url: '/' });
  assert.match(page.body, /id="evidence-revision">1</);

  // altered body with the old preview: 409 preview_mismatch
  const altered = clone(signed);
  const field = altered.context.find((f) => f.key === 'client_region');
  assert.ok(field);
  field.value = 'eu-west-1';
  const s3 = await submit(t, previewBody.preview_id, signRun(altered, t.nodeKey));
  assert.equal(s3.statusCode, 409, s3.body);
  assert.equal(s3.json<{ error: { code: string } }>().error.code, 'preview_mismatch');
  assertNoEcho(s3.body, { preview_id: previewBody.preview_id, run: altered });

  // altered run_id, previewed, but signed by a different key: 401 bad_signature
  const renamed = clone(run);
  renamed.run_id = '01ARZ3NDEKTSV4RRFFQ69G5FB1';
  const p2 = await preview(t, renamed);
  assert.equal(p2.statusCode, 200, p2.body);
  const forged = signRun(renamed, generateNodeKey());
  const s4 = await submit(t, p2.json<{ preview_id: string }>().preview_id, forged);
  assert.equal(s4.statusCode, 401, s4.body);
  assert.equal(s4.json<{ error: { code: string } }>().error.code, 'bad_signature');
  assertNoEcho(s4.body, { run: forged });

  // same run_id, different content, fresh preview: 409 run_conflict
  const conflicting = clone(altered);
  const p3 = await preview(t, conflicting);
  assert.equal(p3.statusCode, 200, p3.body);
  const s5 = await submit(
    t,
    p3.json<{ preview_id: string }>().preview_id,
    signRun(conflicting, t.nodeKey),
  );
  assert.equal(s5.statusCode, 409, s5.body);
  assert.equal(s5.json<{ error: { code: string } }>().error.code, 'run_conflict');

  // injected AWS key in a context value: 422 secret_pattern, no value echoed
  const leaky = clone(run);
  const leakIndex = leaky.context.findIndex((f) => f.key === 'model.reported');
  assert.ok(leakIndex >= 0);
  const fakeKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
  (leaky.context[leakIndex] as Run['context'][number]).value = `model ${fakeKey}`;
  for (const call of [
    preview(t, leaky),
    submit(t, previewBody.preview_id, signRun(leaky, t.nodeKey)),
  ]) {
    const res = await call;
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json<{
      error: { code: string; details: Array<{ path: string; rule: string }> };
    }>();
    assert.equal(body.error.code, 'validation_failed');
    assert.deepEqual(body.error.details, [
      { path: `/context/${leakIndex}/value`, rule: 'secret_pattern' },
    ]);
    assert.ok(!res.body.includes(fakeKey));
    assertNoEcho(res.body, { run: leaky });
  }

  // a private key block inside the free-form result, and an over-long string
  const nested = clone(run);
  (nested.result as Record<string, unknown>)['note'] = '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----';
  (nested.result as Record<string, unknown>)['long'] = 'x'.repeat(2000);
  const r = await preview(t, nested);
  assert.equal(r.statusCode, 422);
  const nestedDetails = r.json<{ error: { details: Array<{ path: string; rule: string }> } }>()
    .error.details;
  assert.deepEqual(nestedDetails, [
    { path: '/result/note', rule: 'secret_pattern' },
    { path: '/result/long', rule: 'string_too_long' },
  ]);
  assertNoEcho(r.body, { run: nested });

  // unreconciled accounting: 422 accounting_reconciles
  const bad = clone(run);
  bad.accounting.succeeded = 20;
  const b = await preview(t, bad);
  assert.equal(b.statusCode, 422, b.body);
  assert.deepEqual(b.json<{ error: { details: unknown } }>().error.details, [
    { path: '/accounting', rule: 'accounting_reconciles' },
  ]);
  assertNoEcho(b.body, { run: bad });

  // required context missing: 422 with the key path (from the registry, not the body)
  const missing = clone(run);
  missing.context = missing.context.filter((f) => f.key !== 'retry_policy');
  const m = await preview(t, missing);
  assert.equal(m.statusCode, 422, m.body);
  assert.deepEqual(m.json<{ error: { details: unknown } }>().error.details, [
    { path: '/context/retry_policy', rule: 'required_context_missing' },
  ]);

  // registry checks: unknown protocol, stale digests, wrong node
  const stale = clone(run);
  stale.protocol_digest = 'sha256:' + '0'.repeat(64);
  stale.harness_digest = 'sha256:' + '1'.repeat(64);
  stale.node_id = '01ARZ3NDEKTSV4RRFFQ69G5N0E';
  const st = await preview(t, stale);
  assert.equal(st.statusCode, 422);
  assert.deepEqual(st.json<{ error: { details: unknown } }>().error.details, [
    { path: '/protocol_digest', rule: 'protocol_digest_mismatch' },
    { path: '/harness_digest', rule: 'harness_digest_unknown' },
    { path: '/node_id', rule: 'node_mismatch' },
  ]);
  const unknown = clone(run);
  unknown.protocol_ref = 'inference-api/throughput@1';
  const u = await preview(t, unknown);
  assert.equal(u.statusCode, 422);
  assert.deepEqual(u.json<{ error: { details: unknown } }>().error.details, [
    { path: '/protocol_ref', rule: 'protocol_unknown' },
  ]);

  // server-assigned org_ref must not be on the wire; malformed bodies never echo
  const withOrg = { ...clone(run), org_ref: 'someone-elses-org-ref-value' };
  const o = await preview(t, withOrg as Run);
  assert.equal(o.statusCode, 422);
  assert.ok(
    o
      .json<{ error: { details: Array<{ path: string; rule: string }> } }>()
      .error.details.some((d) => d.path === '/org_ref' && d.rule === 'server_assigned'),
  );
  assertNoEcho(o.body, { run: withOrg });

  const noPreview = await t.app.inject({
    method: 'POST',
    url: '/v1/runs',
    headers: authHeader(t.token),
    payload: { run: signed },
  });
  assert.equal(noPreview.statusCode, 422);
  assert.deepEqual(noPreview.json<{ error: { details: unknown } }>().error.details, [
    { path: '/preview_id', rule: 'required' },
  ]);

  const badJson = await t.app.inject({
    method: 'POST',
    url: '/v1/runs',
    headers: { ...authHeader(t.token), 'content-type': 'application/json' },
    payload: '{"run": {"note": "never-echo-' + 'a'.repeat(24) + '"',
  });
  assert.equal(badJson.statusCode, 400);
  assert.equal(badJson.json<{ error: { code: string } }>().error.code, 'bad_json');
  assert.ok(!badJson.body.includes('never-echo'));

  const unknownPreview = await submit(t, '01ARZ3NDEKTSV4RRFFQ69G5PRV', signed);
  assert.equal(unknownPreview.statusCode, 404);
  assert.equal(unknownPreview.json<{ error: { code: string } }>().error.code, 'preview_not_found');
});

test('read back: own run decrypts with server-assigned org_ref and private policy; receipt re-reads', async () => {
  const { receipt, run } = await submitRun(t, {
    ...(await prepareRun(t)),
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5FC0',
    attempt_id: '01ARZ3NDEKTSV4RRFFQ69G5FC1',
  });
  const got = await t.app.inject({
    method: 'GET',
    url: `/v1/runs/${run.run_id}`,
    headers: authHeader(t.token),
  });
  assert.equal(got.statusCode, 200, got.body);
  const body = got.json<{ run: Run; receipt_id: string; evidence_revision: number }>();
  assert.equal(body.receipt_id, receipt['receipt_id']);
  assert.equal(body.run.run_id, run.run_id);
  assert.equal(typeof body.run.org_ref, 'string');
  assert.equal(body.run.submission.sharing_policy, 'private');
  assert.equal(body.run.submission.signature, run.submission.signature);
  assert.deepEqual(body.run.context, run.context);

  const re = await t.app.inject({
    method: 'GET',
    url: `/v1/receipts/${String(receipt['receipt_id'])}`,
    headers: authHeader(t.token),
  });
  assert.equal(re.statusCode, 200);
  assert.deepEqual(re.json(), receipt);

  // stored ciphertext does not contain the plaintext body
  const row = await t.app.iwik.pool.query<{ body_ciphertext: Buffer; org_ref: string }>(
    `SELECT body_ciphertext, org_ref FROM evidence.runs WHERE run_id = $1`,
    [run.run_id],
  );
  const cipher = row.rows[0]?.body_ciphertext;
  assert.ok(cipher);
  assert.ok(!cipher.toString('latin1').includes(run.run_id));
  assert.ok(!cipher.toString('latin1').includes('stub-model'));
  // the evidence schema knows only the opaque org_ref
  assert.match(row.rows[0]?.org_ref ?? '', /^[0-9a-f]{32}$/);
});

test('isolation: another organization never sees this org run_id, receipt, or org_ref', async () => {
  const { pool } = t.app.iwik;
  const { receipt, run } = await submitRun(t, {
    ...(await prepareRun(t)),
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5FD0',
    attempt_id: '01ARZ3NDEKTSV4RRFFQ69G5FD1',
  });
  const otherKey = generateNodeKey();
  const other = await createOrganization(pool, 'Other Org');
  const otherNodeId = await createNode(pool, other.org_id, otherKey.pubkey);
  const otherToken = await issueToken(pool, otherNodeId, ['query', 'submit']);

  const runRes = await t.app.inject({
    method: 'GET',
    url: `/v1/runs/${run.run_id}`,
    headers: authHeader(otherToken),
  });
  assert.equal(runRes.statusCode, 404);
  assert.ok(!runRes.body.includes(run.run_id));

  const receiptRes = await t.app.inject({
    method: 'GET',
    url: `/v1/receipts/${String(receipt['receipt_id'])}`,
    headers: authHeader(otherToken),
  });
  assert.equal(receiptRes.statusCode, 404);

  // The other org's previews do not bind this org's submissions.
  const theirs = {
    ...(await prepareRun(t)),
    node_id: otherNodeId,
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5FE0',
  };
  const theirPreview = await preview(t, theirs, otherToken);
  assert.equal(theirPreview.statusCode, 200, theirPreview.body);
  const crossed = await submit(
    t,
    theirPreview.json<{ preview_id: string }>().preview_id,
    signRun({ ...theirs, node_id: run.node_id }, t.nodeKey),
  );
  assert.equal(crossed.statusCode, 404);
  assert.equal(crossed.json<{ error: { code: string } }>().error.code, 'preview_not_found');

  // Reusing this org's run_id from the other org is a conflict with nothing leaked.
  const collide = { ...theirs, run_id: run.run_id };
  const cp = await preview(t, collide, otherToken);
  assert.equal(cp.statusCode, 200, cp.body);
  const cs = await submit(
    t,
    cp.json<{ preview_id: string }>().preview_id,
    signRun(collide, otherKey),
    otherToken,
  );
  assert.equal(cs.statusCode, 409);
  assert.equal(cs.json<{ error: { code: string } }>().error.code, 'run_conflict');
  const orgRef = (
    await pool.query<{ org_ref: string }>(`SELECT org_ref FROM evidence.runs WHERE run_id = $1`, [
      run.run_id,
    ])
  ).rows[0]?.org_ref;
  assert.ok(orgRef);
  for (const res of [runRes, receiptRes, crossed, cs]) {
    assert.ok(!res.body.includes(orgRef));
    assert.ok(!res.body.includes(String(receipt['receipt_id'])));
  }
});

test('openapi: every /v1 route is documented and every documented path has a route', async () => {
  const doc = (await t.app.inject({ method: 'GET', url: '/v1/openapi.json' })).json<{
    paths: Record<string, Record<string, unknown>>;
  }>();
  const documented = new Set<string>();
  for (const [path, ops] of Object.entries(doc.paths)) {
    for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${path}`);
  }
  const registered = new Set(
    t.app.iwik.routes
      .filter((r) => r.url.startsWith('/v1') || r.url === '/healthz' || r.url === '/readyz')
      .map((r) => `${r.method} ${r.url.replace(/:([a-z_]+)/g, '{$1}')}`),
  );
  assert.deepEqual([...registered].sort(), [...documented].sort());
});
