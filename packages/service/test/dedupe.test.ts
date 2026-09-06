// Stage 8: intake dedupe behind IWIK_FEATURE_DEDUPE, the plaintext index
// projection, the contributions ledger, cohortPreview, the index_backfill
// job, and the operator cohort endpoint (ranges only).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Run } from '@iwik/contracts';
import { digest } from '@iwik/contracts';
import { loadConfig } from '../src/config.js';
import {
  cohortPreview,
  listContributions,
  orgRange,
  runRange,
  shareBand,
} from '../src/modules/cohort/index.js';
import { currentRevision } from '../src/modules/intake/index.js';
import {
  INDEX_VERSION,
  measurementDigest,
  projectIndexContext,
  redactProjection,
} from '../src/modules/intake/projection.js';
import {
  BODY_NOT_JSON,
  INDEX_BACKFILL,
  INDEX_BACKFILL_KEY,
  buildHandlers,
  ensureMaintenanceJobs,
  indexBackfillPending,
} from '../src/modules/jobs/handlers.js';
import { JobRunner, getJob } from '../src/modules/jobs/index.js';
import { ulid } from '../src/ulid.js';
import {
  DATABASE_URL,
  OPERATOR_TOKEN,
  SEED_NODE_ID,
  SEED_ORG,
  addNode,
  assertNoEcho,
  authHeader,
  bootApp,
  bootDedupeApp,
  createOrgWithNode,
  handlerDeps,
  indexRow,
  loadFixtureRun,
  submitFresh,
} from './helpers.js';
import type { TestApp } from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';
const REQUIRED = [
  'model.requested',
  'model.reported',
  'concurrency',
  'retry_policy',
  'cache_disabled',
  'client_region',
];

let t: TestApp;
let seeded: {
  org_id: string;
  org_ref: string;
  node_id: string;
  key: TestApp['nodeKey'];
  token: string;
};

before(async () => {
  t = await bootDedupeApp({ env: { IWIK_FEATURE_WITHDRAWAL: 'on' } });
  const org = await t.app.iwik.pool.query<{ org_id: string; org_ref: string }>(
    `SELECT o.org_id, r.org_ref FROM identity.organizations o
       JOIN identity.org_refs r ON r.org_id = o.org_id WHERE o.name = $1`,
    [SEED_ORG],
  );
  const row = org.rows[0];
  assert.ok(row);
  seeded = { ...row, node_id: SEED_NODE_ID, key: t.nodeKey, token: t.token };
});

after(async () => {
  await t.app.close();
});

/** A service-kind run (fixture runs are never counted) tagged with a region so tests can filter on it. */
function serviceRun(region: string, variant = 0): (run: Run) => void {
  return (run) => {
    run.target = { kind: 'service', label_digest: 'sha256:' + 'a'.repeat(64) };
    for (const field of run.context) if (field.key === 'client_region') field.value = region;
    if (variant !== 0) {
      const result = run.result as Record<string, unknown>;
      const summary = result['summary'] as Record<string, unknown>;
      summary['variant'] = variant;
    }
  };
}

async function ledger() {
  return (await listContributions(t.app.iwik.pool, PROTOCOL)).map((r) => ({
    org_ref: r.org_ref,
    runs_accepted: r.runs_accepted,
    runs_withdrawn: r.runs_withdrawn,
  }));
}

async function ledgerFor(orgRef: string) {
  return (await ledger()).find((r) => r.org_ref === orgRef) ?? null;
}

async function cohorts(query: string, token: string | null = OPERATOR_TOKEN) {
  return t.app.inject({
    method: 'GET',
    url: `/v1/admin/cohorts${query}`,
    headers: token === null ? {} : authHeader(token),
  });
}

test('flag default: IWIK_FEATURE_DEDUPE is off in every environment', () => {
  const base = { DATABASE_URL, IWIK_KEK: '0'.repeat(64) };
  for (const NODE_ENV of ['production', 'development', 'test']) {
    assert.equal(loadConfig({ ...base, NODE_ENV }).featureDedupe, false, NODE_ENV);
  }
  assert.equal(loadConfig({ ...base, IWIK_FEATURE_DEDUPE: 'on' }).featureDedupe, true);
});

test('measurement_digest: the documented recipe; blind to ids, node, timestamps, context, signature', () => {
  const run = loadFixtureRun();
  const expected = digest({
    protocol_digest: run.protocol_digest,
    target_label_digest: run.target.label_digest,
    result: run.result,
    attempts_summary: run.accounting,
  });
  assert.equal(measurementDigest(run), expected);
  assert.match(expected, /^sha256:[0-9a-f]{64}$/);

  const same: Run = {
    ...run,
    run_id: ulid(),
    attempt_id: ulid(),
    node_id: ulid(),
    started_at: '2026-09-06T00:00:00Z',
    ended_at: '2026-09-06T00:00:09Z',
    context: [...run.context, { key: 'extra', value: 'x', origin: 'measured' }],
    submission: { ...run.submission, signature: 'AAAA', signed_at: '2026-09-06T00:00:10Z' },
    artifacts: [],
  };
  assert.equal(measurementDigest(same), expected, 'a re-upload of the same measurement collides');

  const otherResult: Run = {
    ...run,
    result: { ...(run.result as Record<string, unknown>), extra: 1 },
  };
  const otherTarget: Run = {
    ...run,
    target: { ...run.target, label_digest: 'sha256:' + 'b'.repeat(64) },
  };
  const otherAccounting: Run = {
    ...run,
    accounting: { ...run.accounting, planned: 21, unobserved: 1 },
  };
  const otherProtocol: Run = { ...run, protocol_digest: 'sha256:' + 'c'.repeat(64) };
  for (const [name, variant] of Object.entries({
    otherResult,
    otherTarget,
    otherAccounting,
    otherProtocol,
  })) {
    assert.notEqual(measurementDigest(variant), expected, name);
  }
});

test('projection: only required_context keys, missing keys null/unknown, extra keys never projected, values rescanned', () => {
  const run = loadFixtureRun();
  const sanitize = { maxStringLength: 1024, extraPatterns: [] };
  const { index_context, issues } = projectIndexContext(run, REQUIRED, sanitize);
  assert.deepEqual(issues, []);
  assert.deepEqual(Object.keys(index_context).sort(), [...REQUIRED].sort());
  assert.ok(!('max_tokens' in index_context), 'the fixture carries max_tokens; it is not required');
  assert.deepEqual(index_context['concurrency'], { value: 1, origin: 'measured' });
  assert.deepEqual(index_context['client_region'], { value: 'local', origin: 'operator_reported' });

  // a required key the run lacks is emitted as null/unknown, never dropped
  const without: Run = { ...run, context: run.context.filter((f) => f.key !== 'retry_policy') };
  const missing = projectIndexContext(without, REQUIRED, sanitize);
  assert.deepEqual(missing.index_context['retry_policy'], { value: null, origin: 'unknown' });
  assert.deepEqual(Object.keys(missing.index_context).sort(), [...REQUIRED].sort());

  // a key outside required_context is never projected even when asked for by the run
  const smuggled: Run = {
    ...run,
    context: [...run.context, { key: 'hostname', value: 'db-1.internal', origin: 'measured' }],
  };
  const projected = projectIndexContext(smuggled, REQUIRED, sanitize);
  assert.ok(!('hostname' in projected.index_context));
  assert.ok(!JSON.stringify(projected.index_context).includes('db-1.internal'));

  // the projected values are rescanned: a secret or an over-long value is reported by key, never by value
  const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const leaky: Run = {
    ...run,
    context: run.context.map((f) =>
      f.key === 'model.reported' ? { ...f, value: `model ${secret}` } : f,
    ),
  };
  const scanned = projectIndexContext(leaky, REQUIRED, { ...sanitize, maxStringLength: 8 });
  assert.deepEqual(
    scanned.issues.map((i) => `${i.path} ${i.rule}`).sort(),
    [
      '/context/model.reported secret_pattern',
      '/context/model.reported string_too_long',
      '/context/model.requested string_too_long',
    ].sort(),
  );
  assert.ok(!JSON.stringify(scanned.issues).includes(secret));
  const redacted = redactProjection(scanned);
  assert.deepEqual(redacted['model.reported'], { value: null, origin: 'unknown' });
  assert.deepEqual(redacted['model.requested'], { value: null, origin: 'unknown' });
  assert.deepEqual(redacted['concurrency'], { value: 1, origin: 'measured' });
  assert.ok(!JSON.stringify(redacted).includes(secret));
});

test('ranges: the count-range vocabulary and the 50 % band', () => {
  assert.deepEqual([0, 2, 3, 5, 6, 10, 11, 40].map(orgRange), [
    '<3',
    '<3',
    '3-5',
    '3-5',
    '6-10',
    '6-10',
    '11+',
    '11+',
  ]);
  assert.deepEqual([0, 4, 5, 10, 11, 50, 51].map(runRange), [
    '<5',
    '<5',
    '5-10',
    '5-10',
    '11-50',
    '11-50',
    '51+',
  ]);
  assert.deepEqual([0, 0.5, 0.5000001, 1].map(shareBand), ['<=50%', '<=50%', '>50%', '>50%']);
});

test('same measurement from two nodes of one organization: duplicate receipt, duplicate_of, counted once, no revision', async () => {
  const { pool } = t.app.iwik;
  const second = await addNode(t, seeded.org_id);
  const first = await submitFresh(t, seeded, serviceRun('dup'));
  assert.equal(first.res.statusCode, 201, first.res.body);
  assert.equal(first.res.json<{ status: string }>().status, 'accepted');
  const revision = await currentRevision(pool);
  assert.deepEqual(await ledgerFor(seeded.org_ref), {
    org_ref: seeded.org_ref,
    runs_accepted: 1,
    runs_withdrawn: 0,
  });

  const again = await submitFresh(t, second, serviceRun('dup'));
  assert.equal(again.res.statusCode, 201, again.res.body);
  const receipt = again.res.json<Record<string, unknown>>();
  assert.equal(receipt['kind'], 'intake');
  assert.equal(receipt['status'], 'duplicate');
  assert.equal(receipt['duplicate_of'], first.run.run_id);
  assert.equal(receipt['run_id'], again.run.run_id);
  assert.equal(receipt['evidence_revision'], revision);
  assert.equal(await currentRevision(pool), revision, 'a duplicate is not an evidence revision');

  const row = await indexRow(t, again.run.run_id);
  assert.ok(row);
  assert.equal(row.duplicate_of, first.run.run_id);
  assert.equal(row.shared_source_suspect, false);
  assert.equal(row.is_fixture, false);
  assert.equal(row.index_version, INDEX_VERSION);
  assert.equal(row.node_id, second.node_id);
  assert.equal(row.measurement_digest, measurementDigest(again.run));
  assert.equal(row.measurement_digest, (await indexRow(t, first.run.run_id))?.measurement_digest);
  assert.deepEqual(Object.keys(row.index_context ?? {}).sort(), [...REQUIRED].sort());
  assert.deepEqual(row.index_context?.['client_region'], {
    value: 'dup',
    origin: 'operator_reported',
  });

  // not counted: the ledger and the cohort still see one measurement from one organization
  assert.deepEqual(await ledgerFor(seeded.org_ref), {
    org_ref: seeded.org_ref,
    runs_accepted: 1,
    runs_withdrawn: 0,
  });
  assert.deepEqual(await cohortPreview(pool, PROTOCOL, { client_region: 'dup' }), {
    protocol_ref: PROTOCOL,
    filters: { client_region: 'dup' },
    orgs: 1,
    runs: 1,
    max_org_share: 1,
  });

  // a third copy points at the original, not at the duplicate
  const third = await submitFresh(t, seeded, serviceRun('dup'));
  assert.equal(third.res.json<{ duplicate_of: string }>().duplicate_of, first.run.run_id);

  // the duplicate receipt re-reads as duplicate (intake receipts never go stale) and the run reads back
  const reread = await t.app.inject({
    method: 'GET',
    url: `/v1/receipts/${String(receipt['receipt_id'])}`,
    headers: authHeader(second.token),
  });
  assert.equal(reread.statusCode, 200);
  assert.equal(reread.json<{ status: string }>().status, 'duplicate');
  const read = await t.app.inject({
    method: 'GET',
    url: `/v1/runs/${again.run.run_id}`,
    headers: authHeader(second.token),
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.json<{ run: Run }>().run.run_id, again.run.run_id);
});

test('same measurement from two organizations: both stored, both shared_source_suspect, counted for each, one contributor', async () => {
  const { pool } = t.app.iwik;
  const other = await createOrgWithNode(t, 'Shared Source Org');
  const mine = await submitFresh(t, seeded, serviceRun('shared', 100));
  assert.equal(mine.res.statusCode, 201, mine.res.body);
  assert.equal((await indexRow(t, mine.run.run_id))?.shared_source_suspect, false);

  const theirs = await submitFresh(t, other, serviceRun('shared', 100));
  assert.equal(theirs.res.statusCode, 201, theirs.res.body);
  const receipt = theirs.res.json<Record<string, unknown>>();
  assert.equal(receipt['status'], 'accepted', 'across organizations it is not a duplicate');
  assert.equal(receipt['duplicate_of'], undefined);
  assert.equal((await indexRow(t, theirs.run.run_id))?.shared_source_suspect, true);
  assert.equal(
    (await indexRow(t, mine.run.run_id))?.shared_source_suspect,
    true,
    'flagged retroactively',
  );
  assert.equal((await indexRow(t, theirs.run.run_id))?.duplicate_of, null);

  assert.equal((await ledgerFor(seeded.org_ref))?.runs_accepted, 2, 'dup test + this one');
  assert.deepEqual(await ledgerFor(other.org_ref), {
    org_ref: other.org_ref,
    runs_accepted: 1,
    runs_withdrawn: 0,
  });
  // a shared source is one contributor, however many organizations uploaded it
  assert.deepEqual(await cohortPreview(pool, PROTOCOL, { client_region: 'shared' }), {
    protocol_ref: PROTOCOL,
    filters: { client_region: 'shared' },
    orgs: 1,
    runs: 2,
    max_org_share: 1,
  });
  // a third organization with its own measurement is independent of the pair
  const third = await createOrgWithNode(t, 'Independent Org');
  assert.equal((await submitFresh(t, third, serviceRun('shared', 107))).res.statusCode, 201);
  const preview = await cohortPreview(pool, PROTOCOL, { client_region: 'shared' });
  assert.equal(preview.orgs, 2);
  assert.equal(preview.runs, 3);
  assert.ok(Math.abs(preview.max_org_share - 2 / 3) < 1e-9);
});

test('ten runs from org A and one from org B: orgs 2, max share 0.91; the operator sees <3, 11-50, >50%', async () => {
  const { pool } = t.app.iwik;
  const a = await createOrgWithNode(t, 'Concentrated Org A');
  const b = await createOrgWithNode(t, 'Concentrated Org B');
  for (let i = 1; i <= 10; i++) {
    const res = (await submitFresh(t, a, serviceRun('conc', i))).res;
    assert.equal(res.statusCode, 201, res.body);
    assert.equal(res.json<{ status: string }>().status, 'accepted');
  }
  assert.equal((await submitFresh(t, b, serviceRun('conc', 11))).res.statusCode, 201);
  assert.deepEqual(await ledgerFor(a.org_ref), {
    org_ref: a.org_ref,
    runs_accepted: 10,
    runs_withdrawn: 0,
  });
  assert.deepEqual(await ledgerFor(b.org_ref), {
    org_ref: b.org_ref,
    runs_accepted: 1,
    runs_withdrawn: 0,
  });

  const preview = await cohortPreview(pool, PROTOCOL, { client_region: 'conc' });
  assert.equal(preview.orgs, 2);
  assert.equal(preview.runs, 11);
  assert.ok(Math.abs(preview.max_org_share - 10 / 11) < 1e-9, String(preview.max_org_share));
  assert.equal(preview.max_org_share.toFixed(2), '0.91');
  // filters combine (containment): a number parses as a number, a mismatch narrows to nothing
  assert.equal(
    (await cohortPreview(pool, PROTOCOL, { client_region: 'conc', concurrency: 1 })).runs,
    11,
  );
  assert.deepEqual(await cohortPreview(pool, PROTOCOL, { client_region: 'conc', concurrency: 2 }), {
    protocol_ref: PROTOCOL,
    filters: { client_region: 'conc', concurrency: 2 },
    orgs: 0,
    runs: 0,
    max_org_share: 0,
  });
  assert.equal(
    (await cohortPreview(pool, PROTOCOL, { client_region: 'conc', concurrency: '1' })).runs,
    0,
  );

  // the operator endpoint: ranges only
  const res = await cohorts(
    `?protocol_ref=${encodeURIComponent(PROTOCOL)}&filter.client_region=conc`,
  );
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json<Record<string, unknown>>();
  assert.deepEqual(Object.keys(body).sort(), [
    'evidence_revision',
    'filters',
    'max_org_share',
    'orgs',
    'protocol_ref',
    'runs',
  ]);
  assert.equal(body['orgs'], '<3');
  assert.equal(body['runs'], '11-50');
  assert.equal(body['max_org_share'], '>50%');
  assert.deepEqual(body['filters'], { client_region: 'conc' });
  assert.equal(body['evidence_revision'], await currentRevision(pool));
  assert.ok(!res.body.includes('0.9'), 'no exact share');
  assert.ok(!res.body.includes(a.org_ref) && !res.body.includes(b.org_ref));

  const numeric = await cohorts(
    `?protocol_ref=${encodeURIComponent(PROTOCOL)}&filter.client_region=conc&filter.concurrency=1`,
  );
  assert.deepEqual(numeric.json<{ filters: unknown; runs: string }>().filters, {
    client_region: 'conc',
    concurrency: 1,
  });
  assert.equal(numeric.json<{ runs: string }>().runs, '11-50');
  const narrowed = await cohorts(
    `?protocol_ref=${encodeURIComponent(PROTOCOL)}&filter.client_region=conc&filter.concurrency=2`,
  );
  assert.deepEqual(
    [narrowed.json<{ orgs: string }>().orgs, narrowed.json<{ runs: string }>().runs],
    ['<3', '<5'],
  );

  // balance it: nine more from B put A at exactly half, which is on the allowed side of the cap
  for (let i = 12; i <= 20; i++) await submitFresh(t, b, serviceRun('conc', i));
  const balanced = await cohortPreview(pool, PROTOCOL, { client_region: 'conc' });
  assert.equal(balanced.runs, 20);
  assert.equal(balanced.max_org_share, 0.5);
  const half = await cohorts(
    `?protocol_ref=${encodeURIComponent(PROTOCOL)}&filter.client_region=conc`,
  );
  assert.equal(half.json<{ max_org_share: string }>().max_org_share, '<=50%');
});

test('operator endpoint: operator token only (constant-time), 422 with paths and rules, nothing echoed', async () => {
  const good = `?protocol_ref=${encodeURIComponent(PROTOCOL)}`;
  assert.equal((await cohorts(good, null)).statusCode, 401);
  assert.equal((await cohorts(good, t.token)).statusCode, 401, 'a node token is not an operator');
  assert.equal((await cohorts(good, OPERATOR_TOKEN + 'x')).statusCode, 401);
  assert.equal((await cohorts(good, OPERATOR_TOKEN.slice(0, -1))).statusCode, 401);
  assert.equal((await cohorts(good)).statusCode, 200);

  const bad = async (query: string) => {
    const res = await cohorts(query);
    assert.equal(res.statusCode, 422, res.body);
    const body = res.json<{
      error: { code: string; details: Array<{ path: string; rule: string }> };
    }>();
    assert.equal(body.error.code, 'validation_failed');
    return body.error.details.map((d) => `${d.path} ${d.rule}`).sort();
  };
  assert.deepEqual(await bad(''), ['/protocol_ref required']);
  assert.deepEqual(await bad('?protocol_ref=Not%20A%20Ref'), ['/protocol_ref pattern']);
  assert.deepEqual(await bad('?protocol_ref=nope%2Fnothing%401'), [
    '/protocol_ref protocol_unknown',
  ]);
  assert.deepEqual(await bad(`${good}&filter.max_tokens=64`), ['/filter.max_tokens not_indexed']);
  assert.deepEqual(await bad(`${good}&filter.hostname=db-1.internal`), [
    '/filter.hostname not_indexed',
  ]);
  assert.deepEqual(await bad(`${good}&limit=5`), ['/limit additionalProperties']);
  assert.deepEqual(await bad(`${good}&filter.=x`), ['/filter. additionalProperties']);
  assert.deepEqual(await bad(`${good}&filter.concurrency=1&filter.concurrency=2`), [
    '/filter.concurrency type',
  ]);
  const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const echo = await cohorts(`${good}&filter.hostname=${secret}&filter.client_region=${secret}`);
  assert.equal(echo.statusCode, 422);
  assertNoEcho(echo.body, { secret });
});

test('fixture runs: stored with is_fixture, never in the ledger or a cohort; a fixture repeat is still a duplicate', async () => {
  const { pool } = t.app.iwik;
  const before = (await ledgerFor(seeded.org_ref))?.runs_accepted ?? 0;
  const tag = (run: Run) => {
    for (const field of run.context) if (field.key === 'client_region') field.value = 'fixture';
  };
  const first = await submitFresh(t, seeded, tag);
  assert.equal(first.res.statusCode, 201, first.res.body);
  assert.equal(first.res.json<{ status: string; sharing_policy: string }>().status, 'accepted');
  assert.equal(first.res.json<{ sharing_policy: string }>().sharing_policy, 'private');
  const row = await indexRow(t, first.run.run_id);
  assert.equal(row?.is_fixture, true);
  assert.equal(row?.index_version, INDEX_VERSION);
  assert.equal(
    (await ledgerFor(seeded.org_ref))?.runs_accepted,
    before,
    'fixture runs are not contributions',
  );
  assert.deepEqual(await cohortPreview(pool, PROTOCOL, { client_region: 'fixture' }), {
    protocol_ref: PROTOCOL,
    filters: { client_region: 'fixture' },
    orgs: 0,
    runs: 0,
    max_org_share: 0,
  });
  const repeat = await submitFresh(t, seeded, tag);
  assert.equal(repeat.res.json<{ status: string }>().status, 'duplicate');
  assert.equal(repeat.res.json<{ duplicate_of: string }>().duplicate_of, first.run.run_id);
  assert.equal((await ledgerFor(seeded.org_ref))?.runs_accepted, before);
});

test('withdrawal moves the ledger from accepted to withdrawn and drops the run from the cohort; a re-upload afterwards is fresh', async () => {
  const { pool } = t.app.iwik;
  const c = await createOrgWithNode(t, 'Withdrawing Org');
  const one = await submitFresh(t, c, serviceRun('wd', 1));
  const two = await submitFresh(t, c, serviceRun('wd', 2));
  const dup = await submitFresh(t, c, serviceRun('wd', 2));
  assert.equal(dup.res.json<{ status: string }>().status, 'duplicate');
  assert.deepEqual(await ledgerFor(c.org_ref), {
    org_ref: c.org_ref,
    runs_accepted: 2,
    runs_withdrawn: 0,
  });

  const withdraw = async (ids: string[]) =>
    t.app.inject({
      method: 'POST',
      url: '/v1/withdrawals',
      headers: authHeader(c.token),
      payload: { run_ids: ids, reason_code: 'member_request' },
    });
  assert.equal((await withdraw([one.run.run_id])).statusCode, 201);
  assert.deepEqual(await ledgerFor(c.org_ref), {
    org_ref: c.org_ref,
    runs_accepted: 1,
    runs_withdrawn: 1,
  });
  assert.equal((await cohortPreview(pool, PROTOCOL, { client_region: 'wd' })).runs, 1);
  // the same set again: idempotent, the ledger does not move twice
  assert.equal((await withdraw([one.run.run_id])).statusCode, 200);
  assert.deepEqual(await ledgerFor(c.org_ref), {
    org_ref: c.org_ref,
    runs_accepted: 1,
    runs_withdrawn: 1,
  });
  // withdrawing a duplicate: it was never counted, so nothing moves
  assert.equal((await withdraw([dup.run.run_id])).statusCode, 201);
  assert.deepEqual(await ledgerFor(c.org_ref), {
    org_ref: c.org_ref,
    runs_accepted: 1,
    runs_withdrawn: 1,
  });
  assert.equal((await cohortPreview(pool, PROTOCOL, { client_region: 'wd' })).runs, 1);
  // a withdrawn measurement uploaded again is a fresh contribution, not a duplicate of the withdrawn row
  const back = await submitFresh(t, c, serviceRun('wd', 1));
  assert.equal(back.res.json<{ status: string }>().status, 'accepted');
  assert.deepEqual(await ledgerFor(c.org_ref), {
    org_ref: c.org_ref,
    runs_accepted: 2,
    runs_withdrawn: 1,
  });
  assert.equal((await cohortPreview(pool, PROTOCOL, { client_region: 'wd' })).runs, 2);
  assert.equal(two.res.statusCode, 201);
});

test('index_backfill reproduces what intake wrote: projection, index_version, ledger, duplicate and suspect marks; last_error never carries plaintext', async () => {
  const { pool, envelope } = t.app.iwik;
  const snapshot = async () => ({
    rows: (
      await pool.query<Record<string, unknown>>(
        `SELECT run_id, measurement_digest, node_id, index_context, is_fixture, index_version,
                shared_source_suspect, duplicate_of
           FROM evidence.runs ORDER BY run_id`,
      )
    ).rows,
    ledger: await ledger(),
  });
  const before = await snapshot();
  assert.ok(before.rows.length >= 20);
  assert.ok(before.rows.every((r) => r['index_version'] === INDEX_VERSION));
  assert.ok(before.rows.some((r) => r['duplicate_of'] !== null));
  assert.ok(before.rows.some((r) => r['shared_source_suspect'] === true));
  assert.ok(before.rows.some((r) => r['is_fixture'] === true));
  assert.equal(await indexBackfillPending(pool), false);
  assert.equal((await ensureMaintenanceJobs(pool)).index_backfill, false, 'nothing to backfill');

  // simulate rows migrated with the column defaults and an empty ledger
  await pool.query(
    `UPDATE evidence.runs SET measurement_digest = NULL, node_id = NULL, index_context = NULL,
            is_fixture = false, index_version = NULL, shared_source_suspect = false, duplicate_of = NULL`,
  );
  await pool.query(`DELETE FROM evidence.contributions`);
  assert.equal(await indexBackfillPending(pool), true);
  assert.deepEqual(await cohortPreview(pool, PROTOCOL, {}), {
    protocol_ref: PROTOCOL,
    filters: {},
    orgs: 0,
    runs: 0,
    max_org_share: 0,
  });

  // one row whose body is not JSON: skipped, reported with a fixed message, never its content
  const plaintext =
    'not json: {"hostname":"db-1.internal","token":"' + 'AKIA' + 'IOSFODNN7EXAMPLE"';
  const sealed = await envelope.seal(seeded.org_ref, Buffer.from(plaintext, 'utf8'));
  const badId = ulid();
  await pool.query(
    `INSERT INTO evidence.runs
       (run_id, org_ref, protocol_ref, protocol_digest, harness_digest, execution_status,
        content_digest, body_ciphertext, key_id, receipt_id, evidence_revision, sharing_policy,
        backfill_version, received_at)
     VALUES ($1, $2, $3, 'sha256:x', 'sha256:y', 'succeeded', 'sha256:z', $4, $5, $6, 1, 'private', 1,
             now() - interval '1 day')`,
    [badId, seeded.org_ref, PROTOCOL, sealed.ciphertext, sealed.key_id, ulid()],
  );

  const scheduled = await ensureMaintenanceJobs(pool);
  assert.equal(scheduled.index_backfill, true);
  const warnings: Array<Record<string, unknown>> = [];
  const runner = new JobRunner(pool, {
    handlers: buildHandlers(handlerDeps(t)),
    backoffMs: 60_000,
    log: {
      info() {},
      warn(obj) {
        warnings.push(obj);
      },
      error() {},
    },
  });
  await runner.drain();
  const job = await pool.query<{ job_id: string; state: string; last_error: string | null }>(
    `SELECT job_id, state, last_error FROM jobs WHERE idempotency_key = $1`,
    [INDEX_BACKFILL_KEY],
  );
  const first = job.rows[0];
  assert.ok(first);
  assert.equal(first.state, 'queued', 'retry scheduled because one row was skipped');
  assert.equal(first.last_error, 'Error: index_backfill: 1 row(s) could not be projected');
  const skipped = warnings.find((w) => w['run_id'] === badId);
  assert.ok(skipped, JSON.stringify(warnings));
  assert.equal(skipped['reason'], BODY_NOT_JSON);
  for (const text of [first.last_error ?? '', JSON.stringify(warnings)]) {
    assert.ok(!text.includes('db-1.internal') && !text.includes('AKIA'), text);
  }
  // every other row was projected in that same pass
  const after = await snapshot();
  assert.deepEqual(
    after.rows.filter((r) => r['run_id'] !== badId),
    before.rows,
  );
  assert.deepEqual(after.ledger, before.ledger);
  assert.equal(after.rows.find((r) => r['run_id'] === badId)?.['index_version'], null);

  // remove the bad row, bring the retry forward: the job completes and is not scheduled again
  await pool.query(`DELETE FROM evidence.runs WHERE run_id = $1`, [badId]);
  await pool.query(`UPDATE jobs SET run_after = now() WHERE job_id = $1`, [first.job_id]);
  assert.ok((await runner.drain()) >= 1);
  const done = await getJob(pool, first.job_id);
  assert.deepEqual([done?.kind, done?.state, done?.last_error], [INDEX_BACKFILL, 'done', null]);
  assert.equal(await indexBackfillPending(pool), false);
  assert.equal((await ensureMaintenanceJobs(pool)).index_backfill, false);
  assert.deepEqual(await snapshot(), before);
});

test('IWIK_FEATURE_DEDUPE off: intake as before (no duplicate status, no suspect flags) but the projection and ledger are written; admin endpoint 404', async () => {
  const off = await bootApp({ reset: false, nodeKey: t.nodeKey });
  try {
    const home = await off.app.inject({ method: 'GET', url: '/' });
    assert.match(home.body, /id="dedupe-state">disabled \(IWIK_FEATURE_DEDUPE=off\)</);
    const first = await submitFresh(off, seeded, serviceRun('off', 200));
    const again = await submitFresh(off, seeded, serviceRun('off', 200));
    for (const { res } of [first, again]) {
      assert.equal(res.statusCode, 201, res.body);
      const receipt = res.json<Record<string, unknown>>();
      assert.equal(receipt['status'], 'accepted');
      assert.equal('duplicate_of' in receipt, false);
    }
    const other = await createOrgWithNode(off, 'Flag Off Other Org');
    const theirs = await submitFresh(off, other, serviceRun('off', 200));
    assert.equal(theirs.res.json<{ status: string }>().status, 'accepted');
    for (const runId of [first.run.run_id, again.run.run_id, theirs.run.run_id]) {
      const row = await indexRow(off, runId);
      assert.ok(row);
      assert.equal(row.duplicate_of, null);
      assert.equal(row.shared_source_suspect, false);
      assert.equal(row.index_version, INDEX_VERSION, 'the projection is written regardless');
      assert.equal(row.measurement_digest, measurementDigest(first.run));
      assert.equal(row.is_fixture, false);
      assert.deepEqual(Object.keys(row.index_context ?? {}).sort(), [...REQUIRED].sort());
    }
    assert.equal((await indexRow(off, first.run.run_id))?.node_id, SEED_NODE_ID);
    // counted as before: every accepted run is a contribution, so no backfill is needed later
    assert.deepEqual(await cohortPreview(off.app.iwik.pool, PROTOCOL, { client_region: 'off' }), {
      protocol_ref: PROTOCOL,
      filters: { client_region: 'off' },
      orgs: 2,
      runs: 3,
      max_org_share: 2 / 3,
    });
    const rows = await listContributions(off.app.iwik.pool, PROTOCOL);
    assert.equal(rows.find((r) => r.org_ref === other.org_ref)?.runs_accepted, 1);

    const admin = await off.app.inject({
      method: 'GET',
      url: `/v1/admin/cohorts?protocol_ref=${encodeURIComponent(PROTOCOL)}`,
      headers: authHeader(OPERATOR_TOKEN),
    });
    assert.equal(admin.statusCode, 404);
    assert.deepEqual(admin.json(), {
      error: { code: 'feature_disabled', message: 'this feature is disabled on this deployment' },
    });
    const anon = await off.app.inject({ method: 'GET', url: '/v1/admin/cohorts' });
    assert.equal(anon.statusCode, 404, 'disabled before authentication');
  } finally {
    await off.app.close();
  }
  const on = await t.app.inject({ method: 'GET', url: '/' });
  assert.match(on.body, /id="dedupe-state">enabled</);
});
