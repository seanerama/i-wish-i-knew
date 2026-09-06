// Stage 9: the real POST /v1/evidence/query behind IWIK_FEATURE_COOPERATIVE_QUERY.
// A fixture cohort (organizations created through identity or enrolled through
// the console, every run through the real intake with seeded latencies) drives
// the released answer with hand-checked percentiles, each suppression reason,
// the differencing defence, withdrawal staleness and recomputation, as_of
// pinning, the cache, the decrypt cap, the privacy scan of released receipts
// (brief demonstration 5), the contradiction with no cause text (demonstration
// 3), own evidence, the MCP tool and CLI end-to-end, the console receipt page,
// and the flag-off stub. Pure-function tests for the calculation, matching, and
// policy follow at the end.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AnswerReceipt, ReceiptResult } from '@iwik/contracts';
import { validate } from '@iwik/contracts';
import { init as runnerInit } from '@iwik/runner';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import {
  CALCULATION_VERSION,
  PINNED_NOT_REPRODUCIBLE,
  POLICY_VERSION,
  STUB_CALCULATION_VERSION,
  listOwnQueryReceipts,
} from '../src/modules/aggregate/index.js';
import {
  TAIL_MINIMUM_RUNS,
  claimReasons,
  compute,
  contradictionText,
  exactSpread,
  iqrDisjoint,
  nearestRank,
  parseClaims,
  quartiles,
  releaseSections,
  releasedCount,
} from '../src/modules/aggregate/calc.js';
import type { Sample } from '../src/modules/aggregate/calc.js';
import {
  MIN_ORG_DIFFERENCE,
  cohortHashKey,
  differencingConflict,
  membersHash,
  orgHash,
  symmetricDifference,
  thresholdReasons,
} from '../src/modules/aggregate/policy.js';
import { cacheKey } from '../src/modules/aggregate/releases.js';
import { currentRevision } from '../src/modules/intake/index.js';
import type { IndexContext } from '../src/modules/intake/projection.js';
import {
  checkFilterKeys,
  matchesFilters,
  rankCandidates,
  rankScore,
  unknownKeys,
} from '../src/modules/matching/index.js';
import { orgRefOf } from '../src/modules/withdrawal/index.js';
import {
  DATABASE_URL,
  SEED_NODE_ID,
  SEED_NODE_TOKEN,
  SEED_ORG,
  assertReceiptPrivate,
  authHeader,
  bootApp,
  bootCooperativeApp,
  browse,
  CookieJar,
  contribute,
  createOrgWithNode,
  enrollWithNode,
  queryEvidence,
  repoRoot,
  seededOrg,
} from './helpers.js';
import type { OrgWithNode, TestApp } from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';
const cliPath = resolve(repoRoot, 'packages', 'runner', 'bin', 'iwik.cjs');
const claimsJson = JSON.parse(
  readFileSync(
    resolve(repoRoot, 'packs', 'inference-api', 'protocols', 'latency', 'claims.json'),
    'utf8',
  ),
) as Record<string, unknown>;
const REQUIRED = [
  'model.requested',
  'model.reported',
  'concurrency',
  'retry_policy',
  'cache_disabled',
  'client_region',
];
/** Brief §7 "Diagnosis": a contradiction is listed, never explained away. */
const CAUSAL_WORDS = /\b(because|caused|causes|cause|due to)\b/i;

let t: TestApp;
let A: OrgWithNode & { jar: CookieJar };
let B: OrgWithNode;
let C: OrgWithNode;
let D: OrgWithNode;
let E: OrgWithNode;
let F: OrgWithNode;
let Z: OrgWithNode;
const runsOf = new Map<string, string[]>();
/** Every id and name the receipts of the fixture must never carry. */
let secrets: string[] = [];

before(async () => {
  t = await bootCooperativeApp();
  const alpha = await enrollWithNode(t, 'Alpha Org');
  const alphaRef = await orgRefOf(t.app.iwik.pool, alpha.org_id);
  assert.ok(alphaRef);
  A = {
    org_id: alpha.org_id,
    org_ref: alphaRef,
    node_id: alpha.node_id,
    key: alpha.key,
    token: alpha.token,
    jar: alpha.jar,
  };
  B = await createOrgWithNode(t, 'Beta Org');
  C = await seededOrg(t);
  D = await createOrgWithNode(t, 'Delta Org');
  E = await createOrgWithNode(t, 'Epsilon Org');
  F = await createOrgWithNode(t, 'Foxtrot Org');
  Z = await createOrgWithNode(t, 'Zeta Org', ['query']);
  secrets = [A, B, C, D, E, F, Z].flatMap((o) => [o.org_ref, o.node_id, o.org_id]);
  secrets.push('Alpha Org', 'Beta Org', SEED_ORG, 'Delta Org', 'Epsilon Org', 'Foxtrot Org');
});

after(async () => {
  await t.app.close();
});

function remember(org: OrgWithNode, ids: string[]): string[] {
  runsOf.set(org.org_ref, [...(runsOf.get(org.org_ref) ?? []), ...ids]);
  return ids;
}

function allRunIds(): string[] {
  return [...runsOf.values()].flat();
}

async function query(token: string, body: Parameters<typeof queryEvidence>[2]) {
  const res = await queryEvidence(t, token, body);
  assert.equal(res.statusCode, 200, res.body);
  const receipt = res.json<AnswerReceipt>();
  assert.deepEqual(validate('AnswerReceipt', receipt), { ok: true, errors: [] });
  return receipt;
}

async function readReceipt(token: string, id: string) {
  const res = await t.app.inject({
    method: 'GET',
    url: `/v1/receipts/${id}`,
    headers: authHeader(token),
  });
  assert.equal(res.statusCode, 200, res.body);
  return res.json<Record<string, unknown>>();
}

/** The CLI in its own process; the service listens in this one, so never spawnSync. */
function iwik(home: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveDone) => {
    const child = spawn(process.execPath, [cliPath, '--home', home, ...args], {
      env: { PATH: process.env['PATH'] ?? '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (stdout += c));
    child.stderr.on('data', (c: string) => (stderr += c));
    child.once('close', (code) => resolveDone({ code, stdout, stderr }));
  });
}

/** Count decryptions on this app's envelope while `fn` runs. */
async function opens(app: TestApp, fn: () => Promise<void>): Promise<number> {
  const envelope = app.app.iwik.envelope;
  const original = envelope.open.bind(envelope);
  let n = 0;
  envelope.open = async (orgRef, keyId, ciphertext) => {
    n += 1;
    return original(orgRef, keyId, ciphertext);
  };
  try {
    await fn();
  } finally {
    envelope.open = original;
  }
  return n;
}

function spreadOf(receipt: AnswerReceipt, claim: string, metric: string, stat?: string) {
  const claims = receipt.result?.distributions?.claims ?? {};
  const m = claims[claim]?.[metric];
  assert.ok(m, `${claim}/${metric} released`);
  return stat === undefined ? m.values : m.statistics?.[stat];
}

test('flag default: IWIK_FEATURE_COOPERATIVE_QUERY is off in every environment; cap defaults to 500', () => {
  const base = { DATABASE_URL, IWIK_KEK: '0'.repeat(64) };
  for (const NODE_ENV of ['production', 'development', 'test']) {
    assert.equal(loadConfig({ ...base, NODE_ENV }).featureCooperativeQuery, false, NODE_ENV);
  }
  assert.equal(
    loadConfig({ ...base, IWIK_FEATURE_COOPERATIVE_QUERY: 'on' }).featureCooperativeQuery,
    true,
  );
  assert.equal(loadConfig(base).queryCohortCap, 500);
  assert.equal(loadConfig({ ...base, IWIK_QUERY_COHORT_CAP: '4' }).queryCohortCap, 4);
  assert.throws(() => loadConfig({ ...base, IWIK_QUERY_COHORT_CAP: '0' }), /positive integer/);
  assert.equal(CALCULATION_VERSION, 'latency-v1');
  assert.equal(POLICY_VERSION, '2026-09-p1');
});

test('released answer: three organizations, six runs, hand-checked nearest-rank spreads, bands everywhere', async () => {
  // r1: per-run ttft p50 [20,22,24,26,28,30] spread over A, B, C so that every
  // organization's IQR overlaps another's; failed 1..6 of 20 -> rates 0.05..0.3.
  remember(
    A,
    await contribute(t, A, [
      { ttft_p50: 20, failed: 1, region: 'r1' },
      { ttft_p50: 30, failed: 6, region: 'r1' },
    ]),
  );
  remember(
    B,
    await contribute(t, B, [
      { ttft_p50: 22, failed: 2, region: 'r1' },
      { ttft_p50: 28, failed: 5, region: 'r1' },
    ]),
  );
  remember(
    C,
    await contribute(t, C, [
      { ttft_p50: 24, failed: 3, region: 'r1' },
      { ttft_p50: 26, failed: 4, region: 'r1' },
    ]),
  );
  // Never candidates: A's private run, A's fixture run, and a run of B whose
  // harness digest is not in the protocol's compatibility list.
  const privateRun = remember(
    A,
    await contribute(t, A, [{ ttft_p50: 99, region: 'r1', sharing_policy: 'private' }]),
  )[0] as string;
  const fixtureRun = remember(
    A,
    await contribute(t, A, [{ ttft_p50: 99, region: 'r1', target_kind: 'fixture' }]),
  )[0] as string;
  const oldHarness = remember(B, await contribute(t, B, [{ ttft_p50: 99, region: 'r1' }]))[0];
  await t.app.iwik.pool.query(`UPDATE evidence.runs SET harness_digest = $2 WHERE run_id = $1`, [
    oldHarness,
    'sha256:' + 'e'.repeat(64),
  ]);

  const receipt = await query(C.token, { context_filters: { client_region: 'r1' } });
  assert.equal(receipt.status, 'released');
  assert.equal(receipt.calculation_version, 'latency-v1');
  assert.equal(receipt.policy_version, '2026-09-p1');
  assert.deepEqual(receipt.cohort, {
    protocol_ref: PROTOCOL,
    filters: { client_region: 'r1' },
    orgs: '3-5',
    runs: '5-10',
  });
  assert.equal(receipt.suppression_reasons, undefined);
  const result = receipt.result as ReceiptResult;
  assert.deepEqual(
    result.findings?.map((f) => `${f.claim}:${f.status}`),
    ['latency_distribution:released', 'error_rate:released'],
  );
  // nearest-rank over [20,22,24,26,30,28] sorted: p50 -> rank 3 = 24; p90 -> rank 6 = 30
  assert.deepEqual(spreadOf(receipt, 'latency_distribution', 'ttft_ms', 'p50'), {
    n: '5-10',
    min: 20,
    p50: 24,
    p90: 30,
    p95: 30,
    p99: 30,
    max: 30,
  });
  assert.deepEqual(spreadOf(receipt, 'latency_distribution', 'ttft_ms', 'p90'), {
    n: '5-10',
    min: 23,
    p50: 27,
    p90: 33,
    p95: 33,
    p99: 33,
    max: 33,
  });
  assert.deepEqual(spreadOf(receipt, 'latency_distribution', 'total_ms', 'p50'), {
    n: '5-10',
    min: 30,
    p50: 34,
    p90: 40,
    p95: 40,
    p99: 40,
    max: 40,
  });
  // per-run rates [0.05,0.1,0.15,0.2,0.25,0.3]: p50 -> rank 3 = 0.15
  assert.deepEqual(spreadOf(receipt, 'error_rate', 'error_rate'), {
    n: '5-10',
    min: 0.05,
    p50: 0.15,
    p90: 0.3,
    p95: 0.3,
    p99: 0.3,
    max: 0.3,
  });
  assert.deepEqual(result.distributions?.contributors, { orgs: '3-5', max_org_share: '<=50%' });
  assert.deepEqual(result.missingness, {
    attempts: {
      planned: 120,
      attempted: 120,
      succeeded: 99,
      failed: 21,
      excluded: '<11',
      unobserved: '<11',
    },
    runs_with_unknown_context: '<5',
    runs_below_claim_minimum: { latency_distribution: '<5', error_rate: '<5' },
  });
  assert.deepEqual(result.applicability?.filters_applied, ['client_region']);
  assert.deepEqual(
    result.applicability?.unfiltered_required_context,
    REQUIRED.filter((k) => k !== 'client_region').sort(),
  );
  for (const key of REQUIRED.filter((k) => k !== 'client_region')) {
    assert.equal(result.applicability?.context_known?.[key], '5-10', key);
  }
  assert.deepEqual(result.contradictions, []);
  assert.equal(result.uncertainty?.kind, 'descriptive');
  assert.equal(result.uncertainty?.runs, '5-10');
  assert.deepEqual(result.uncertainty?.tail_claims?.supported, false);
  assert.equal(result.uncertainty?.tail_claims?.minimum_runs, TAIL_MINIMUM_RUNS);
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(result.freshness, { oldest_received_on: today, newest_received_on: today });
  assert.ok(result.limitations?.some((l) => /Fewer than 20 runs/.test(l)));
  assert.ok(!result.limitations?.some((l) => /unknown/.test(l)), 'no unknown context here');

  // own evidence for C: its two runs, both in the cohort; nobody else's
  const own = result.own_evidence;
  assert.ok(own);
  assert.deepEqual(own.runs.map((r) => r.run_id).sort(), [...(runsOf.get(C.org_ref) ?? [])].sort());
  assert.equal(own.compatible, 2);
  assert.equal(own.in_cohort, 2);
  assert.ok(own.runs.every((r) => r.compatible && r.in_cohort && r.reasons.length === 0));

  // the receipt is re-readable as kind query and another organization cannot read it
  const stored = await readReceipt(C.token, receipt.receipt_id);
  assert.equal(stored['kind'], 'query');
  assert.equal(stored['status'], 'released');
  const foreign = await t.app.inject({
    method: 'GET',
    url: `/v1/receipts/${receipt.receipt_id}`,
    headers: authHeader(B.token),
  });
  assert.equal(foreign.statusCode, 404);

  // A sees why its private and fixture runs are not in the cohort; B sees the harness mismatch
  const asA = await query(A.token, { context_filters: { client_region: 'r1' } });
  assert.equal(asA.status, 'released');
  const byId = new Map(asA.result?.own_evidence?.runs.map((r) => [r.run_id, r]));
  assert.deepEqual(byId.get(privateRun)?.reasons, ['private']);
  assert.deepEqual(byId.get(fixtureRun)?.reasons, ['fixture', 'private']);
  assert.equal(asA.result?.own_evidence?.in_cohort, 2);
  const asB = await query(B.token, { context_filters: { client_region: 'r1' } });
  const bById = new Map(asB.result?.own_evidence?.runs.map((r) => [r.run_id, r]));
  assert.deepEqual(bById.get(oldHarness as string)?.reasons, ['harness_incompatible']);
  assert.equal(asB.result?.own_evidence?.in_cohort, 2);
  // the release log holds keyed hashes, never an org_ref, and one row per released set
  const releases = await t.app.iwik.pool.query<{
    member_org_hashes: string[];
    org_count: number;
    run_count: number;
  }>(`SELECT member_org_hashes, org_count, run_count FROM evidence.cohort_releases`);
  assert.equal(releases.rows.length, 1);
  assert.equal(releases.rows[0]?.org_count, 3);
  assert.equal(releases.rows[0]?.run_count, 6);
  for (const h of releases.rows[0]?.member_org_hashes ?? []) {
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.ok(!secrets.includes(h));
  }
});

test('privacy (brief demonstration 5): a released receipt carries no foreign run_id, node_id, org_ref, name, or exact small count', async () => {
  // As a stranger with no runs: nothing private at all, and own_evidence is absent.
  const stranger = await query(Z.token, { context_filters: { client_region: 'r1' } });
  assert.equal(stranger.status, 'released');
  assert.deepEqual(stranger.result?.own_evidence?.runs, []);
  assert.equal(stranger.result?.own_evidence?.compatible, 0);
  assertReceiptPrivate(stranger as unknown as Record<string, unknown>, {
    forbidden: [...secrets, ...allRunIds()],
  });
  // As a contributor: its own ids under own_evidence only, everyone else's nowhere.
  const mine = runsOf.get(C.org_ref) ?? [];
  const asC = await query(C.token, { context_filters: { client_region: 'r1' } });
  assertReceiptPrivate(asC as unknown as Record<string, unknown>, {
    forbidden: [...secrets, ...allRunIds().filter((id) => !mine.includes(id))],
    own: mine,
  });
  // The persisted receipt and the console page are the same object.
  const stored = await readReceipt(C.token, asC.receipt_id);
  assertReceiptPrivate(stored, {
    forbidden: [...secrets, ...allRunIds().filter((id) => !mine.includes(id))],
    own: mine,
  });
});

test('suppressed: two organizations -> min_orgs; four runs -> min_runs; 60 % from one organization -> concentration; own evidence still shown', async () => {
  remember(
    A,
    await contribute(t, A, [
      { ttft_p50: 20, region: 'r2' },
      { ttft_p50: 21, region: 'r2' },
      { ttft_p50: 22, region: 'r2' },
    ]),
  );
  remember(
    B,
    await contribute(t, B, [
      { ttft_p50: 23, region: 'r2' },
      { ttft_p50: 24, region: 'r2' },
      { ttft_p50: 25, region: 'r2' },
    ]),
  );
  const minOrgs = await query(A.token, { context_filters: { client_region: 'r2' } });
  assert.equal(minOrgs.status, 'suppressed');
  assert.deepEqual(minOrgs.suppression_reasons, ['min_orgs']);
  assert.deepEqual(minOrgs.cohort, {
    protocol_ref: PROTOCOL,
    filters: { client_region: 'r2' },
    orgs: '<3',
    runs: '5-10',
  });
  assert.equal(minOrgs.calculation_version, 'latency-v1');
  assert.deepEqual(Object.keys(minOrgs.result ?? {}), ['own_evidence'], 'no cooperative section');
  assert.equal(minOrgs.result?.own_evidence?.compatible, 3);
  assert.equal(minOrgs.result?.own_evidence?.in_cohort, 3);
  assertReceiptPrivate(minOrgs as unknown as Record<string, unknown>, {
    forbidden: [...secrets, ...(runsOf.get(B.org_ref) ?? [])],
    own: runsOf.get(A.org_ref) ?? [],
  });

  remember(
    A,
    await contribute(t, A, [
      { ttft_p50: 20, region: 'r3' },
      { ttft_p50: 21, region: 'r3' },
    ]),
  );
  remember(B, await contribute(t, B, [{ ttft_p50: 22, region: 'r3' }]));
  remember(C, await contribute(t, C, [{ ttft_p50: 23, region: 'r3' }]));
  const minRuns = await query(Z.token, { context_filters: { client_region: 'r3' } });
  assert.equal(minRuns.status, 'suppressed');
  assert.deepEqual(minRuns.suppression_reasons, ['min_runs']);
  assert.equal(minRuns.cohort.orgs, '3-5');
  assert.equal(minRuns.cohort.runs, '<5');
  assert.equal(minRuns.result, undefined, 'a stranger with no runs gets no result at all');

  remember(
    A,
    await contribute(
      t,
      A,
      [20, 21, 22, 23, 24, 25].map((p) => ({ ttft_p50: p, region: 'r4' })),
    ),
  );
  remember(
    B,
    await contribute(t, B, [
      { ttft_p50: 26, region: 'r4' },
      { ttft_p50: 27, region: 'r4' },
    ]),
  );
  remember(
    C,
    await contribute(t, C, [
      { ttft_p50: 28, region: 'r4' },
      { ttft_p50: 29, region: 'r4' },
    ]),
  );
  const concentration = await query(B.token, { context_filters: { client_region: 'r4' } });
  assert.equal(concentration.status, 'suppressed');
  assert.deepEqual(concentration.suppression_reasons, ['concentration']);
  assert.equal(concentration.cohort.orgs, '3-5');
  assert.equal(concentration.cohort.runs, '5-10');
  assert.deepEqual(Object.keys(concentration.result ?? {}), ['own_evidence']);

  // suppressed cohorts are never recorded as releases
  const releases = await t.app.iwik.pool.query(`SELECT 1 FROM evidence.cohort_releases`);
  assert.equal(releases.rows.length, 1);
});

test('differencing: a narrowed re-query whose cohort drops one organization is suppressed; a filter key outside required_context is 422 not_indexed', async () => {
  // r5: six organizations, one run each; D's run used a different retry policy.
  for (const org of [A, B, C, E, F]) {
    remember(org, await contribute(t, org, [{ ttft_p50: 20 + runsOf.size, region: 'r5' }]));
  }
  remember(
    D,
    await contribute(t, D, [{ ttft_p50: 40, region: 'r5', retry_policy: 'exponential' }]),
  );
  const wide = await query(Z.token, { context_filters: { client_region: 'r5' } });
  assert.equal(wide.status, 'released', JSON.stringify(wide.suppression_reasons));
  assert.equal(wide.cohort.orgs, '6-10');
  assert.equal(wide.cohort.runs, '5-10');
  // {A,B,C,E,F} differs from {A..F} by one organization (and from {A,B,C} by two)
  const narrowed = await query(Z.token, {
    context_filters: { client_region: 'r5', retry_policy: 'none' },
  });
  assert.equal(narrowed.status, 'suppressed');
  assert.deepEqual(narrowed.suppression_reasons, ['differencing']);
  assert.equal(narrowed.cohort.orgs, '3-5');
  assert.equal(narrowed.cohort.runs, '5-10');
  assert.equal(narrowed.result, undefined);
  // the same narrowed query again is the same answer (cached at this revision), still no release row
  const again = await query(Z.token, {
    context_filters: { retry_policy: 'none', client_region: 'r5' },
  });
  assert.equal(again.status, 'suppressed');
  assert.equal(again.query_digest, narrowed.query_digest);
  const releases = await t.app.iwik.pool.query(`SELECT 1 FROM evidence.cohort_releases`);
  assert.equal(releases.rows.length, 2);

  const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const bad = await queryEvidence(t, Z.token, {
    context_filters: { client_region: 'r5', max_tokens: 64, hostname: secret },
  });
  assert.equal(bad.statusCode, 422);
  assert.deepEqual(bad.json<{ error: { details: unknown } }>().error.details, [
    { path: '/context_filters/max_tokens', rule: 'not_indexed' },
    { path: '/context_filters/hostname', rule: 'not_indexed' },
  ]);
  assert.ok(!bad.body.includes(secret));
});

test('withdrawal: the prior receipt reads stale, the re-query is recomputed; a pin never readmits a withdrawn run and says the release is no longer reproducible', async () => {
  // r6: A 20 and 40, B 22 and 28, C 24 and 26 -> p50 spread max 40; after A withdraws the 40 run, max 28.
  const aRuns = remember(
    A,
    await contribute(t, A, [
      { ttft_p50: 20, region: 'r6' },
      { ttft_p50: 40, region: 'r6' },
    ]),
  );
  remember(
    B,
    await contribute(t, B, [
      { ttft_p50: 22, region: 'r6' },
      { ttft_p50: 28, region: 'r6' },
    ]),
  );
  remember(
    C,
    await contribute(t, C, [
      { ttft_p50: 24, region: 'r6' },
      { ttft_p50: 26, region: 'r6' },
    ]),
  );
  const before = await query(B.token, { context_filters: { client_region: 'r6' } });
  assert.equal(before.status, 'released');
  const pinned = before.evidence_revision;
  assert.equal(pinned, await currentRevision(t.app.iwik.pool));
  assert.equal(spreadOf(before, 'latency_distribution', 'ttft_ms', 'p50')?.max, 40);
  assert.equal(spreadOf(before, 'latency_distribution', 'ttft_ms', 'p50')?.p50, 24);
  // while nothing has changed, a pin at that revision reproduces the release exactly
  const intact = await query(B.token, {
    context_filters: { client_region: 'r6' },
    as_of_revision: pinned,
  });
  assert.equal(intact.status, 'released');
  assert.deepEqual(intact.result?.distributions, before.result?.distributions);
  assert.ok(!intact.result?.limitations?.includes(PINNED_NOT_REPRODUCIBLE));
  assert.notEqual(intact.query_digest, before.query_digest, 'the pin is part of the query');

  const withdrawn = await t.app.inject({
    method: 'POST',
    url: '/v1/withdrawals',
    headers: authHeader(A.token),
    payload: { run_ids: [aRuns[1]], reason_code: 'data_error' },
  });
  assert.equal(withdrawn.statusCode, 201, withdrawn.body);
  const stale = await readReceipt(B.token, before.receipt_id);
  assert.equal(stale['status'], 'stale');
  assert.ok(!JSON.stringify(stale).includes(aRuns[1] as string), 'stale says nothing');

  const afterwards = await query(B.token, { context_filters: { client_region: 'r6' } });
  assert.equal(afterwards.status, 'released', JSON.stringify(afterwards.suppression_reasons));
  assert.equal(afterwards.evidence_revision, pinned + 1);
  // [20,22,24,26,28]: p50 -> rank 3 = 24, max 28
  assert.deepEqual(spreadOf(afterwards, 'latency_distribution', 'ttft_ms', 'p50'), {
    n: '5-10',
    min: 20,
    p50: 24,
    p90: 28,
    p95: 28,
    p99: 28,
    max: 28,
  });
  assert.equal(afterwards.cohort.runs, '5-10');

  // ADR-0002 §6: a withdrawn run never re-enters a newly issued receipt, pin
  // or no pin. The pinned cohort is now the five remaining runs, so the
  // answer is released (same three organizations) with the fixed limitation
  // that the pinned release is no longer reproducible; nothing says what changed.
  const repinned = await query(B.token, {
    context_filters: { client_region: 'r6' },
    as_of_revision: pinned,
  });
  assert.equal(repinned.status, 'released');
  assert.equal(repinned.evidence_revision, pinned);
  assert.equal(repinned.query_digest, intact.query_digest);
  assert.deepEqual(
    repinned.result?.distributions,
    afterwards.result?.distributions,
    'the withdrawn run is gone from the pinned cohort too',
  );
  assert.notDeepEqual(repinned.result?.distributions, before.result?.distributions);
  assert.equal(repinned.result?.limitations?.[0], PINNED_NOT_REPRODUCIBLE);
  assert.ok(!JSON.stringify(repinned).includes(aRuns[1] as string));
  assert.doesNotMatch(PINNED_NOT_REPRODUCIBLE, CAUSAL_WORDS);
  // A sees its withdrawn run as withdrawn under the pin as well, out of the cohort
  const asAPinned = await query(A.token, {
    context_filters: { client_region: 'r6' },
    as_of_revision: pinned,
  });
  const withdrawnUnderPin = asAPinned.result?.own_evidence?.runs.find((r) => r.run_id === aRuns[1]);
  assert.deepEqual(withdrawnUnderPin?.reasons, ['withdrawn']);
  assert.equal(withdrawnUnderPin?.in_cohort, false);
  assert.equal(asAPinned.result?.own_evidence?.in_cohort, 1);
  const asANow = await query(A.token, { context_filters: { client_region: 'r6' } });
  assert.deepEqual(asANow.result?.own_evidence?.runs.find((r) => r.run_id === aRuns[1])?.reasons, [
    'withdrawn',
  ]);
  // a pin in the future is refused
  const future = await queryEvidence(t, B.token, {
    context_filters: { client_region: 'r6' },
    as_of_revision: (await currentRevision(t.app.iwik.pool)) + 1,
  });
  assert.equal(future.statusCode, 422);
  assert.deepEqual(future.json<{ error: { details: unknown } }>().error.details, [
    { path: '/as_of_revision', rule: 'maximum' },
  ]);
});

test('contradiction (brief demonstration 3): two organizations with disjoint p50 IQRs are flagged; the text names nobody and no cause', async () => {
  remember(
    A,
    await contribute(
      t,
      A,
      [20, 21, 22].map((p) => ({ ttft_p50: p, region: 'r7' })),
    ),
  );
  remember(
    B,
    await contribute(
      t,
      B,
      [60, 61, 62].map((p) => ({ ttft_p50: p, region: 'r7' })),
    ),
  );
  remember(
    C,
    await contribute(
      t,
      C,
      [40, 41, 42].map((p) => ({ ttft_p50: p, region: 'r7' })),
    ),
  );
  const receipt = await query(Z.token, { context_filters: { client_region: 'r7' } });
  assert.equal(receipt.status, 'released');
  const contradictions = receipt.result?.contradictions ?? [];
  assert.deepEqual(
    contradictions.map((c) => `${c.kind} ${c.claim} ${c.metric} ${c.statistic}`),
    [
      'org_level_iqr_disjoint latency_distribution ttft_ms p50',
      'org_level_iqr_disjoint latency_distribution total_ms p50',
    ],
  );
  for (const c of contradictions) {
    assert.doesNotMatch(c.text, CAUSAL_WORDS);
    assert.equal(c.text, contradictionText(c.metric, c.statistic));
    assert.deepEqual(Object.keys(c).sort(), ['claim', 'kind', 'metric', 'statistic', 'text']);
  }
  assert.doesNotMatch(JSON.stringify(receipt), CAUSAL_WORDS);
  assert.ok(receipt.result?.limitations?.some((l) => /disagree/.test(l)));
  // the disagreeing runs are still in the spread, not averaged away: min 20, max 62
  assert.equal(spreadOf(receipt, 'latency_distribution', 'ttft_ms', 'p50')?.min, 20);
  assert.equal(spreadOf(receipt, 'latency_distribution', 'ttft_ms', 'p50')?.max, 62);
  assertReceiptPrivate(receipt as unknown as Record<string, unknown>, {
    forbidden: [...secrets, ...allRunIds()],
  });
});

test('cache: keyed by (query_digest, revision); a hit decrypts nothing; a row behind the latest revision is invalid regardless of eviction', async () => {
  const filters = { client_region: 'r7' };
  const revision = await currentRevision(t.app.iwik.pool);
  const digest = (await query(Z.token, { context_filters: filters })).query_digest;
  const key = cacheKey(digest, revision);
  const row = await t.app.iwik.pool.query<{ revision: string; payload: Record<string, unknown> }>(
    `SELECT revision, payload FROM evidence.cache WHERE key = $1`,
    [key],
  );
  assert.equal(Number(row.rows[0]?.revision), revision);
  assert.equal(row.rows[0]?.payload['status'], 'released');
  assert.ok(!JSON.stringify(row.rows[0]?.payload).includes(Z.org_ref));

  // a hit: no decryption, same digest, a fresh receipt
  let hit: AnswerReceipt | undefined;
  const opened = await opens(t, async () => {
    hit = await query(A.token, { context_filters: filters });
  });
  assert.equal(opened, 0);
  assert.equal(hit?.query_digest, digest);
  assert.equal(hit?.status, 'released');
  assert.ok(hit?.result?.own_evidence, 'own evidence is computed per caller, cache or not');

  // stage 7 carry-forward: a row whose revision is behind the latest for the
  // protocol is not trusted even though nothing evicted it
  await t.app.iwik.pool.query(`UPDATE evidence.cache SET revision = revision - 1 WHERE key = $1`, [
    key,
  ]);
  const recomputed = await opens(t, async () => {
    const r = await query(Z.token, { context_filters: filters });
    assert.equal(r.status, 'released');
  });
  assert.equal(recomputed, 9, 'exactly the cohort was decrypted');
  const rewritten = await t.app.iwik.pool.query<{ revision: string }>(
    `SELECT revision FROM evidence.cache WHERE key = $1`,
    [key],
  );
  assert.equal(Number(rewritten.rows[0]?.revision), revision);

  // a new intake bumps the revision: the next query is a miss at the new key
  remember(D, await contribute(t, D, [{ ttft_p50: 50, region: 'r7-other' }]));
  const missed = await opens(t, async () => {
    const r = await query(Z.token, { context_filters: filters });
    assert.equal(r.evidence_revision, revision + 1);
  });
  assert.equal(missed, 9);
});

test('decrypt scope: a cohort above IWIK_QUERY_COHORT_CAP is suppressed with cohort_too_large before any body is opened', async () => {
  const capped = await bootApp({
    reset: false,
    nodeKey: t.nodeKey,
    env: { IWIK_FEATURE_COOPERATIVE_QUERY: 'on', IWIK_QUERY_COHORT_CAP: '4' },
  });
  try {
    let receipt: AnswerReceipt | undefined;
    const opened = await opens(capped, async () => {
      const res = await queryEvidence(capped, C.token, {
        context_filters: { client_region: 'r1' },
      });
      assert.equal(res.statusCode, 200, res.body);
      receipt = res.json<AnswerReceipt>();
    });
    assert.equal(opened, 0);
    assert.equal(receipt?.status, 'suppressed');
    assert.deepEqual(receipt?.suppression_reasons, ['cohort_too_large']);
    assert.equal(receipt?.cohort.orgs, '3-5');
    assert.equal(receipt?.cohort.runs, '5-10');
    assert.deepEqual(Object.keys(receipt?.result ?? {}), ['own_evidence']);
    assert.equal(receipt?.result?.own_evidence?.in_cohort, 0, 'no cohort was formed');
    // r3 has four runs: under the cap, computed as usual
    const small = await queryEvidence(capped, C.token, {
      context_filters: { client_region: 'r3' },
    });
    assert.deepEqual(small.json<AnswerReceipt>().suppression_reasons, ['min_runs']);
  } finally {
    await capped.app.close();
  }
});

test('no candidates at all: insufficient_evidence with no_cooperative_evidence, <3 / <5, no result', async () => {
  const receipt = await query(Z.token, { context_filters: { client_region: 'nowhere' } });
  assert.equal(receipt.status, 'insufficient_evidence');
  assert.deepEqual(receipt.suppression_reasons, ['no_cooperative_evidence']);
  assert.deepEqual(receipt.cohort, {
    protocol_ref: PROTOCOL,
    filters: { client_region: 'nowhere' },
    orgs: '<3',
    runs: '<5',
  });
  assert.equal(receipt.result, undefined);
  assert.equal(receipt.calculation_version, 'latency-v1');
});

test('MCP query_evidence end-to-end over stdio: a released receipt, a suppressed answer with a next step, and iwik report --cooperative', async () => {
  const serviceUrl = await t.app.listen({ port: 0, host: '127.0.0.1' });
  const base = mkdtempSync(join(tmpdir(), 'iwik-coop-'));
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
  const client = new Client({ name: 'iwik-cooperative-test', version: '0.0.0' });
  await client.connect(transport);
  interface Envelope {
    ok: boolean;
    data?: { receipt?: AnswerReceipt };
    error?: { code: string; message: string; next_step?: string };
  }
  const call = async (args: Record<string, unknown>): Promise<Envelope> => {
    const result = await client.callTool({ name: 'query_evidence', arguments: args });
    return result.structuredContent as Envelope;
  };
  try {
    const released = await call({
      protocol_ref: PROTOCOL,
      context_filters: { client_region: 'r1' },
    });
    assert.equal(released.ok, true, JSON.stringify(released));
    const receipt = released.data?.receipt;
    assert.ok(receipt);
    assert.equal(receipt.status, 'released');
    assert.equal(receipt.cohort.orgs, '3-5');
    assert.deepEqual(
      receipt.result?.own_evidence?.runs.map((r) => r.run_id).sort(),
      [...(runsOf.get(C.org_ref) ?? [])].sort(),
    );
    assertReceiptPrivate(receipt as unknown as Record<string, unknown>, {
      forbidden: [
        ...secrets,
        ...allRunIds().filter((id) => !(runsOf.get(C.org_ref) ?? []).includes(id)),
      ],
      own: runsOf.get(C.org_ref) ?? [],
    });

    const suppressed = await call({
      protocol_ref: PROTOCOL,
      context_filters: { client_region: 'r2' },
    });
    assert.equal(suppressed.ok, false);
    assert.equal(suppressed.error?.code, 'suppressed');
    assert.match(suppressed.error?.message ?? '', /min_orgs/);
    assert.match(suppressed.error?.message ?? '', /orgs <3, runs 5-10/);
    assert.match(suppressed.error?.next_step ?? '', /more organizations contribute|wait/i);
    assert.match(suppressed.error?.next_step ?? '', /plan_test/);
    assert.doesNotMatch(JSON.stringify(suppressed), CAUSAL_WORDS);
    for (const s of secrets) assert.ok(!JSON.stringify(suppressed).includes(s));

    // the CLI renders the same released receipt as Markdown with every section
    const cli = await iwik(home, [
      'report',
      '--cooperative',
      '--protocol',
      PROTOCOL,
      '--context',
      'client_region=r1',
    ]);
    assert.equal(cli.code, 0, cli.stdout + cli.stderr);
    for (const heading of [
      '# Cooperative evidence',
      'released',
      '## Applicability',
      '## Distributions',
      '## Uncertainty',
      '## Freshness',
      '## Contradictions',
      '## Missing-data accounting',
      '## Limitations',
      '## Your own evidence',
      '3-5 organizations',
    ]) {
      assert.ok(cli.stdout.includes(heading), `${heading}\n${cli.stdout}`);
    }
    for (const s of secrets) assert.ok(!cli.stdout.includes(s));
    const suppressedCli = await iwik(home, [
      'report',
      '--cooperative',
      '--protocol',
      PROTOCOL,
      '--context',
      'client_region=r2',
      '--json',
    ]);
    assert.equal(suppressedCli.code, 0, suppressedCli.stdout + suppressedCli.stderr);
    const parsed = JSON.parse(suppressedCli.stdout) as AnswerReceipt;
    assert.equal(parsed.status, 'suppressed');
    assert.match(suppressedCli.stderr, /min_orgs/);
  } finally {
    await client.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('console: /receipts/<id> renders the signed-in organization’s receipt section by section; foreign or unknown ids are a 404 page; signed out redirects', async () => {
  const receipt = await query(A.token, { context_filters: { client_region: 'r7' } });
  assert.equal(receipt.status, 'released');
  const page = await browse(t, A.jar, `/receipts/${receipt.receipt_id}`);
  assert.equal(page.statusCode, 200, page.body);
  assert.match(page.headers['content-type'] ?? '', /text\/html/);
  assert.match(page.body, /id="org-name">Alpha Org</);
  assert.match(page.body, /id="receipt-status"[^>]*>\s*Status: <strong>released</);
  assert.match(page.body, /id="cohort-orgs">3-5</);
  assert.match(page.body, /id="cohort-runs">5-10</);
  for (const id of [
    'findings',
    'applicability',
    'distributions',
    'missingness',
    'contradictions',
    'uncertainty',
    'freshness',
    'limitations',
    'own-evidence',
    'receipt-json',
  ]) {
    assert.ok(page.body.includes(`id="${id}"`), id);
  }
  assert.match(page.body, /id="contradiction-0"/);
  assert.doesNotMatch(page.body, CAUSAL_WORDS);
  const ownRows = [...page.body.matchAll(/id="own-run-([0-9A-HJKMNP-TV-Z]{26})"/g)].map(
    (m) => m[1],
  );
  assert.ok(ownRows.length > 0);
  for (const id of ownRows) assert.ok((runsOf.get(A.org_ref) ?? []).includes(id as string));
  for (const s of secrets.filter((x) => x !== 'Alpha Org')) assert.ok(!page.body.includes(s));

  // the /org page lists it with a link
  const org = await browse(t, A.jar, '/org');
  assert.equal(org.statusCode, 200);
  assert.ok(org.body.includes(`href="/receipts/${receipt.receipt_id}"`));
  const listed = await listOwnQueryReceipts(t.app.iwik.pool, A.org_ref);
  assert.ok(listed.some((r) => r.receipt_id === receipt.receipt_id && r.protocol_ref === PROTOCOL));

  // stale reads stale on the page too
  await contribute(t, D, [{ ttft_p50: 50, region: 'r7-other' }]);
  const stale = await browse(t, A.jar, `/receipts/${receipt.receipt_id}`);
  assert.match(stale.body, /Status: <strong>stale</);

  // another organization's receipt: a 404 page, and an intake receipt is not a query receipt
  const theirs = await query(B.token, { context_filters: { client_region: 'r7' } });
  const foreign = await browse(t, A.jar, `/receipts/${theirs.receipt_id}`);
  assert.equal(foreign.statusCode, 404);
  assert.match(foreign.body, /Receipt not found/);
  const garbage = await browse(t, A.jar, '/receipts/not-a-ulid');
  assert.equal(garbage.statusCode, 404);
  const anon = await browse(t, new CookieJar(), `/receipts/${receipt.receipt_id}`);
  assert.equal(anon.statusCode, 303);
  assert.equal(anon.headers.location, '/');
});

test('flag off: the stage 5 stub answer continues unchanged over the same evidence', async () => {
  const off = await bootApp({ reset: false, nodeKey: t.nodeKey });
  try {
    const home = await off.app.inject({ method: 'GET', url: '/' });
    assert.match(
      home.body,
      /id="cooperative-query-state">disabled \(IWIK_FEATURE_COOPERATIVE_QUERY=off\)</,
    );
    const res = await queryEvidence(off, C.token, { context_filters: { client_region: 'r1' } });
    assert.equal(res.statusCode, 200);
    const receipt = res.json<AnswerReceipt>();
    assert.equal(receipt.status, 'insufficient_evidence');
    assert.deepEqual(receipt.suppression_reasons, ['no_cooperative_evidence']);
    assert.equal(receipt.calculation_version, STUB_CALCULATION_VERSION);
    assert.equal(receipt.result, undefined);
    assert.deepEqual(receipt.cohort, {
      protocol_ref: PROTOCOL,
      filters: { client_region: 'r1' },
      orgs: '<3',
      runs: '<5',
    });
  } finally {
    await off.app.close();
  }
  const on = await t.app.inject({ method: 'GET', url: '/' });
  assert.match(on.body, /id="cooperative-query-state">enabled</);
});

// ---------------------------------------------------------------------------
// pure functions

test('calc: nearest-rank percentiles and quartiles by hand', () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(nearestRank(ten, 50), 5);
  assert.equal(nearestRank(ten, 90), 9);
  assert.equal(nearestRank(ten, 95), 10);
  assert.equal(nearestRank(ten, 99), 10);
  assert.equal(nearestRank([7], 50), 7);
  assert.equal(nearestRank([3, 9], 50), 3);
  assert.equal(nearestRank([3, 9], 51), 9);
  assert.throws(() => nearestRank([], 50), RangeError);
  assert.throws(() => nearestRank(ten, 0), RangeError);
  assert.deepEqual(exactSpread([30, 10, 20]), {
    n: 3,
    min: 10,
    p50: 20,
    p90: 30,
    p95: 30,
    p99: 30,
    max: 30,
  });
  assert.equal(exactSpread([]), undefined);
  assert.deepEqual(quartiles([20, 21, 22]), { q1: 20, q3: 22 });
  assert.deepEqual(quartiles([1, 2, 3, 4]), { q1: 1, q3: 3 });
  assert.equal(iqrDisjoint({ q1: 20, q3: 22 }, { q1: 23, q3: 25 }), true);
  assert.equal(iqrDisjoint({ q1: 20, q3: 22 }, { q1: 22, q3: 25 }), false);
  assert.equal(iqrDisjoint({ q1: 23, q3: 25 }, { q1: 20, q3: 22 }), true);
  assert.deepEqual([0, 5, 10, 11, 120].map(releasedCount), ['<11', '<11', '<11', 11, 120]);
});

function sample(
  org: string,
  p50: number,
  extra: {
    failed?: number;
    succeeded?: number;
    origins?: Record<string, Sample['context_origin'][string]>;
  } = {},
): Sample {
  const failed = extra.failed ?? 2;
  const succeeded = extra.succeeded ?? 20 - failed;
  return {
    org_ref: org,
    contributor: org,
    received_at: new Date('2026-09-06T10:00:00Z'),
    execution_status: 'succeeded',
    accounting: {
      planned: succeeded + failed,
      attempted: succeeded + failed,
      succeeded,
      failed,
      excluded: 0,
      unobserved: 0,
    },
    result: {
      summary: {
        error_rate: failed / (succeeded + failed),
        ttft_ms: { p50, p90: p50 + 3, p95: p50 + 4, p99: p50 + 5 },
        total_ms: { p50: p50 + 10, p90: p50 + 13, p95: p50 + 14, p99: p50 + 15 },
      },
    },
    context_origin: {
      'model.requested': 'operator_reported',
      'model.reported': 'measured',
      concurrency: 'measured',
      retry_policy: 'measured',
      cache_disabled: 'operator_reported',
      client_region: 'operator_reported',
      ...(extra.origins ?? {}),
    },
  };
}

test('calc: compute over synthetic samples matches the claims.json derivation; a claim below its minimum is withheld', () => {
  const pack = claimsJson;
  const claims = parseClaims(pack, ['latency_distribution', 'error_rate']);
  assert.deepEqual(
    claims.map((c) => `${c.name}:${c.metrics.map((m) => m.name).join('+')}`),
    ['latency_distribution:ttft_ms+total_ms', 'error_rate:error_rate'],
  );
  assert.equal(claims[0]?.minimum_succeeded, 10);
  assert.equal(claims[1]?.minimum_attempted, 10);
  assert.deepEqual(
    parseClaims(pack, ['error_rate']).map((c) => c.name),
    ['error_rate'],
  );

  const samples = [
    sample('a', 20, { failed: 1 }),
    sample('a', 30, { failed: 6 }),
    sample('b', 22, { failed: 2 }),
    sample('b', 28, { failed: 5 }),
    sample('c', 24, { failed: 3, origins: { 'model.reported': 'unknown' } }),
    sample('c', 26, { failed: 4 }),
    // a short run: 4 succeeded of 12 attempted -> below the latency minimum, fine for error_rate
    sample('c', 99, { failed: 8, succeeded: 4 }),
  ];
  const c = compute(samples, claims, REQUIRED, ['client_region']);
  assert.equal(c.runs, 7);
  assert.equal(c.orgs, 3);
  assert.equal(c.max_org_share, 3 / 7);
  assert.deepEqual(c.attempts, {
    planned: 132,
    attempted: 132,
    succeeded: 103,
    failed: 29,
    excluded: 0,
    unobserved: 0,
  });
  assert.equal(c.runs_with_unknown_context, 1);
  assert.equal(c.context_known['model.reported'], 6);
  assert.equal(c.context_known['concurrency'], 7);
  assert.equal('client_region' in c.context_known, false);
  const latency = c.claims[0];
  assert.ok(latency);
  assert.equal(latency.eligible, 6);
  assert.equal(latency.below_minimum, 1);
  assert.deepEqual(latency.metrics['ttft_ms']?.statistics?.['p50'], {
    n: 6,
    min: 20,
    p50: 24,
    p90: 30,
    p95: 30,
    p99: 30,
    max: 30,
  });
  assert.deepEqual(latency.metrics['total_ms']?.statistics?.['p99'], {
    n: 6,
    min: 35,
    p50: 39,
    p90: 45,
    p95: 45,
    p99: 45,
    max: 45,
  });
  assert.deepEqual(latency.contradictions, []);
  const rate = c.claims[1];
  assert.ok(rate);
  assert.equal(rate.eligible, 7);
  assert.deepEqual(rate.metrics['error_rate']?.values, {
    n: 7,
    min: 0.05,
    p50: 0.2,
    p90: 8 / 12,
    p95: 8 / 12,
    p99: 8 / 12,
    max: 8 / 12,
  });

  const released = releaseSections({
    computation: c,
    requiredContext: REQUIRED,
    filterKeys: ['client_region'],
  });
  assert.equal(released.findings?.[0]?.status, 'released');
  assert.deepEqual(released.missingness?.attempts, {
    planned: 132,
    attempted: 132,
    succeeded: 103,
    failed: 29,
    excluded: '<11',
    unobserved: '<11',
  });
  assert.deepEqual(released.missingness?.runs_below_claim_minimum, {
    latency_distribution: '<5',
    error_rate: '<5',
  });
  assert.equal(released.applicability?.context_known?.['model.reported'], '5-10');
  assert.ok(
    released.limitations?.some((l) =>
      l.startsWith('<5 runs carry at least one required context field'),
    ),
  );
  assert.deepEqual(released.freshness, {
    oldest_received_on: '2026-09-06',
    newest_received_on: '2026-09-06',
  });

  // only two organizations meet the latency minimum: that claim is withheld, error_rate released
  const thin = compute(
    [
      sample('a', 20),
      sample('a', 21),
      sample('b', 22),
      sample('b', 23),
      sample('c', 24, { succeeded: 4, failed: 8 }),
      sample('c', 25, { succeeded: 4, failed: 8 }),
    ],
    claims,
    REQUIRED,
    [],
  );
  assert.deepEqual(claimReasons(thin.claims[0]!), ['min_orgs', 'min_runs']);
  assert.deepEqual(claimReasons(thin.claims[1]!), []);
  const thinReleased = releaseSections({
    computation: thin,
    requiredContext: REQUIRED,
    filterKeys: [],
  });
  assert.equal(thinReleased.findings?.[0]?.status, 'withheld');
  assert.deepEqual(thinReleased.findings?.[0]?.reasons, ['min_orgs', 'min_runs']);
  assert.equal(thinReleased.distributions?.claims?.['latency_distribution'], undefined);
  assert.ok(thinReleased.distributions?.claims?.['error_rate']);
  assert.doesNotMatch(JSON.stringify(thinReleased), CAUSAL_WORDS);
});

test('calc: contradictions need two runs per organization and disjoint IQRs; the template has no causal language', () => {
  const claims = parseClaims(claimsJson, ['latency_distribution']);
  const disjoint = compute(
    [
      sample('a', 20),
      sample('a', 21),
      sample('a', 22),
      sample('b', 60),
      sample('b', 61),
      sample('b', 62),
      sample('c', 40),
      sample('c', 41),
    ],
    claims,
    REQUIRED,
    [],
  );
  assert.deepEqual(disjoint.claims[0]?.contradictions, [
    { claim: 'latency_distribution', metric: 'ttft_ms', statistic: 'p50' },
    { claim: 'latency_distribution', metric: 'total_ms', statistic: 'p50' },
  ]);
  // a single outlying run is not an organization-level distribution; a and b overlap
  const single = compute(
    [sample('a', 20), sample('a', 23), sample('b', 21), sample('b', 24), sample('c', 99)],
    claims,
    REQUIRED,
    [],
  );
  assert.deepEqual(single.claims[0]?.contradictions, []);
  const text = contradictionText('ttft_ms', 'p50');
  assert.doesNotMatch(text, CAUSAL_WORDS);
  assert.match(text, /does not identify why they differ/);
  const sections = releaseSections({
    computation: disjoint,
    requiredContext: REQUIRED,
    filterKeys: [],
  });
  assert.equal(sections.contradictions?.length, 2);
  assert.equal(sections.contradictions?.[0]?.text, text);
});

test('policy: thresholds in contract order; differencing on symmetric difference below 3, identical sets are a repeat', () => {
  assert.deepEqual(thresholdReasons({ orgs: 3, runs: 5, max_org_share: 0.5 }), []);
  assert.deepEqual(thresholdReasons({ orgs: 2, runs: 6, max_org_share: 0.5 }), ['min_orgs']);
  assert.deepEqual(thresholdReasons({ orgs: 3, runs: 4, max_org_share: 0.5 }), ['min_runs']);
  assert.deepEqual(thresholdReasons({ orgs: 3, runs: 10, max_org_share: 0.6 }), ['concentration']);
  assert.deepEqual(thresholdReasons({ orgs: 1, runs: 1, max_org_share: 1 }), [
    'min_orgs',
    'min_runs',
    'concentration',
  ]);
  const s = (...xs: string[]) => new Set(xs);
  assert.equal(symmetricDifference(s('a', 'b', 'c'), s('a', 'b', 'c', 'd')), 1);
  assert.equal(symmetricDifference(s('a', 'b', 'c'), s('d', 'e', 'f')), 6);
  assert.equal(MIN_ORG_DIFFERENCE, 3);
  assert.equal(differencingConflict([], s('a', 'b', 'c')), false);
  assert.equal(differencingConflict([s('a', 'b', 'c')], s('a', 'b', 'c')), false, 'repeat');
  assert.equal(differencingConflict([s('a', 'b', 'c')], s('a', 'b', 'c', 'd')), true);
  assert.equal(differencingConflict([s('a', 'b', 'c', 'd')], s('a', 'b', 'c')), true);
  assert.equal(
    differencingConflict([s('a', 'b', 'c')], s('a', 'b', 'd', 'e')),
    false,
    'one out, two in: 3',
  );
  assert.equal(
    differencingConflict([s('a', 'b', 'c')], s('a', 'b', 'd')),
    true,
    'one out, one in: 2',
  );
  assert.equal(differencingConflict([s('a', 'b', 'c')], s('a', 'b', 'c', 'd', 'e', 'f')), false);
  assert.equal(
    differencingConflict([s('a', 'b', 'c'), s('x', 'y', 'z')], s('x', 'y', 'z', 'w')),
    true,
  );
  const key = cohortHashKey(Buffer.alloc(32, 1));
  const other = cohortHashKey(Buffer.alloc(32, 2));
  assert.match(orgHash(key, 'org-1'), /^[0-9a-f]{64}$/);
  assert.equal(orgHash(key, 'org-1'), orgHash(key, 'org-1'));
  assert.notEqual(orgHash(key, 'org-1'), orgHash(other, 'org-1'), 'keyed');
  assert.notEqual(orgHash(key, 'org-1'), orgHash(key, 'org-2'));
  assert.equal(membersHash(['b', 'a']), membersHash(['a', 'b']));
  assert.notEqual(membersHash(['a']), membersHash(['a', 'b']));
});

test('matching: filters outside required_context are refused; ranking orders by origin and never changes the set', () => {
  const protocol = t.app.iwik.registry.get(PROTOCOL)?.protocol;
  assert.ok(protocol);
  assert.doesNotThrow(() => checkFilterKeys({ concurrency: 1, client_region: 'x' }, protocol));
  assert.throws(
    () => checkFilterKeys({ max_tokens: 64 }, protocol),
    (e: unknown) =>
      e instanceof ApiError &&
      e.status === 422 &&
      JSON.stringify(e.details) ===
        JSON.stringify([{ path: '/context_filters/max_tokens', rule: 'not_indexed' }]),
  );
  const ctx = (
    origins: Record<string, 'measured' | 'provider_reported' | 'unknown'>,
  ): IndexContext => {
    const out: IndexContext = {};
    for (const key of REQUIRED) {
      out[key] = {
        value: origins[key] === 'unknown' ? null : 'v',
        origin: origins[key] ?? 'measured',
      };
    }
    return out;
  };
  const measured = {
    index_context: ctx({}),
    received_at: new Date('2026-09-06T02:00:00Z'),
    id: 'm',
  };
  const reported = {
    index_context: ctx({ 'model.reported': 'provider_reported' }),
    received_at: new Date('2026-09-06T01:00:00Z'),
    id: 'r',
  };
  const unknown = {
    index_context: ctx({ 'model.reported': 'unknown', retry_policy: 'unknown' }),
    received_at: new Date('2026-09-06T00:00:00Z'),
    id: 'u',
  };
  const ranked = rankCandidates([unknown, reported, measured], REQUIRED, { client_region: 'x' });
  assert.deepEqual(
    ranked.map((r) => r.id),
    ['m', 'r', 'u'],
  );
  assert.equal(ranked.length, 3, 'ranking never drops a compatible run');
  assert.equal(rankScore(measured.index_context, REQUIRED, { client_region: 'x' }), 10);
  assert.equal(rankScore(reported.index_context, REQUIRED, { client_region: 'x' }), 9);
  assert.equal(rankScore(unknown.index_context, REQUIRED, { client_region: 'x' }), 6);
  assert.deepEqual(unknownKeys(unknown.index_context, REQUIRED), [
    'model.reported',
    'retry_policy',
  ]);
  assert.deepEqual(unknownKeys(null, ['a']), ['a']);
  assert.equal(matchesFilters(measured.index_context, { client_region: 'v' }), true);
  assert.equal(matchesFilters(measured.index_context, { client_region: 'w' }), false);
  assert.equal(matchesFilters(measured.index_context, { missing: 'v' }), false);
});
