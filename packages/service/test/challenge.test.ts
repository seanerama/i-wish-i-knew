// Stage 10: the challenge and outcome ledger behind IWIK_FEATURE_CHALLENGE.
// A three-organization cohort (through the real intake) releases an answer;
// its findings become Claim rows; a member challenges the receipt or a claim
// with structured grounds; the operator resolves it (API and console),
// which records a Relationship per claim and bumps the evidence revision so
// the earlier receipt reads stale; the sixth challenge in a day is 429; a
// prediction is registered before its outcome and can never be altered by
// the observation; nothing in any challenge, claim, prediction, or outcome
// names another organization's runs; the MCP tools and the CLI end-to-end;
// and everything is 404 feature_disabled with the flag off.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { AnswerReceipt, Challenge, Outcome, Prediction } from '@iwik/contracts';
import { validate } from '@iwik/contracts';
import { init as runnerInit } from '@iwik/runner';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import {
  CHALLENGE_RATE_LIMIT,
  RESOLUTION_RELATIONSHIP,
  claimsOfReceipt,
  ensureClaimsForReceipt,
  findChallenge,
  parseChallengeBody,
  parseOutcomeBody,
  parseResolveBody,
  receiptForClaims,
  relationshipsOfChallenge,
  toChallenge,
  toClaim,
  toRelationship,
} from '../src/modules/challenge/index.js';
import { OPERATOR_COOKIE } from '../src/modules/challenge/operator.js';
import { currentRevision, findReceipt } from '../src/modules/intake/index.js';
import {
  DATABASE_URL,
  OPERATOR_TOKEN,
  SEED_NODE_ID,
  SEED_NODE_TOKEN,
  SEED_ORG,
  assertNoEcho,
  assertReceiptPrivate,
  authHeader,
  bootApp,
  bootCooperativeApp,
  browse,
  CookieJar,
  contribute,
  createOrgWithNode,
  postForm,
  queryEvidence,
  repoRoot,
  seededOrg,
} from './helpers.js';
import type { OrgWithNode, TestApp } from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';
const REGION = 'ledger-1';
const cliPath = resolve(repoRoot, 'packages', 'runner', 'bin', 'iwik.cjs');
const FUTURE = '2099-01-01';

let t: TestApp;
let A: OrgWithNode;
let B: OrgWithNode;
let C: OrgWithNode;
let D: OrgWithNode;
let Z: OrgWithNode;
const runsOf = new Map<string, string[]>();
/** Every id and name that must never appear in another organization's responses. */
let secrets: string[] = [];
/** A's released receipt, issued in `before`. */
let receiptA: AnswerReceipt;

interface Envelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code: string; message: string; next_step?: string };
}

before(async () => {
  t = await bootCooperativeApp({ env: { IWIK_FEATURE_CHALLENGE: 'on' } });
  A = await createOrgWithNode(t, 'Ledger Alpha');
  B = await createOrgWithNode(t, 'Ledger Beta');
  C = await seededOrg(t);
  D = await createOrgWithNode(t, 'Ledger Delta');
  Z = await createOrgWithNode(t, 'Ledger Zeta', ['query']);
  for (const org of [A, B, C]) {
    runsOf.set(
      org.org_ref,
      await contribute(t, org, [
        { ttft_p50: 20 + runsOf.size * 2, failed: 1, region: REGION },
        { ttft_p50: 30 - runsOf.size * 2, failed: 4, region: REGION },
      ]),
    );
  }
  secrets = [A, B, C, D, Z].flatMap((o) => [o.org_ref, o.node_id, o.org_id]);
  secrets.push('Ledger Alpha', 'Ledger Beta', SEED_ORG, 'Ledger Delta', 'Ledger Zeta');
  receiptA = await query(A.token);
  assert.equal(receiptA.status, 'released');
});

after(async () => {
  await t.app.close();
});

async function query(token: string, region = REGION): Promise<AnswerReceipt> {
  const res = await queryEvidence(t, token, { context_filters: { client_region: region } });
  assert.equal(res.statusCode, 200, res.body);
  const receipt = res.json<AnswerReceipt>();
  assert.deepEqual(validate('AnswerReceipt', receipt), { ok: true, errors: [] });
  return receipt;
}

function foreignTo(org: OrgWithNode): string[] {
  const own = new Set([org.org_ref, org.node_id, org.org_id, ...(runsOf.get(org.org_ref) ?? [])]);
  return [...secrets, ...[...runsOf.values()].flat()].filter((s) => !own.has(s));
}

/** Nothing of anyone else's in a response body meant for `org`. */
function assertPrivateFor(body: unknown, org: OrgWithNode): void {
  const text = JSON.stringify(body);
  for (const s of foreignTo(org)) {
    assert.ok(!text.includes(s), `response for ${org.org_id} carries a foreign string`);
  }
}

async function post(token: string, url: string, payload: object) {
  return t.app.inject({ method: 'POST', url, headers: authHeader(token), payload });
}

async function file(
  token: string,
  target: { kind: 'receipt' | 'claim'; id: string },
  grounds = 'data_error',
  statement: Record<string, unknown> = {},
) {
  return post(token, '/v1/challenges', { target, grounds, statement });
}

async function fileOk(
  token: string,
  target: { kind: 'receipt' | 'claim'; id: string },
  grounds = 'data_error',
  statement: Record<string, unknown> = {},
): Promise<Challenge> {
  const res = await file(token, target, grounds, statement);
  assert.equal(res.statusCode, 201, res.body);
  const challenge = res.json<Challenge>();
  assert.deepEqual(validate('Challenge', challenge), { ok: true, errors: [] });
  return challenge;
}

async function getChallenge(token: string, id: string) {
  return t.app.inject({ method: 'GET', url: `/v1/challenges/${id}`, headers: authHeader(token) });
}

async function resolveApi(
  id: string,
  resolution: 'upheld' | 'rejected' | 'superseded',
  rationale = 'data_error',
  token = OPERATOR_TOKEN,
) {
  return t.app.inject({
    method: 'POST',
    url: `/v1/admin/challenges/${id}/resolve`,
    headers: authHeader(token),
    payload: { resolution, relationship: { kind: RESOLUTION_RELATIONSHIP[resolution], rationale } },
  });
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

function claimIds(receipt: AnswerReceipt): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of receipt.result?.findings ?? []) {
    const id = (f as Record<string, unknown>)['claim_id'];
    if (typeof id === 'string') out[f.claim] = id;
  }
  return out;
}

function errorCode(res: { json: <T>() => T }): string {
  return res.json<{ error: { code: string } }>().error.code;
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

test('flag default: IWIK_FEATURE_CHALLENGE is off in every environment', () => {
  const base = { DATABASE_URL, IWIK_KEK: '0'.repeat(64) };
  for (const NODE_ENV of ['production', 'development', 'test']) {
    assert.equal(loadConfig({ ...base, NODE_ENV }).featureChallenge, false, NODE_ENV);
  }
  assert.equal(loadConfig({ ...base, IWIK_FEATURE_CHALLENGE: 'on' }).featureChallenge, true);
});

test('claims: every released finding carries a claim_id and has one Claim row (measured, unreplicated, supported); idempotent on (receipt, claim)', async () => {
  const ids = claimIds(receiptA);
  const released = (receiptA.result?.findings ?? []).filter((f) => f.status === 'released');
  assert.ok(released.length >= 1, 'the cohort released at least one finding');
  assert.equal(Object.keys(ids).length, released.length);
  for (const id of Object.values(ids)) assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  // the privacy scan of stage 9 still passes with claim ids on the findings
  assertReceiptPrivate(receiptA as unknown as Record<string, unknown>, {
    forbidden: foreignTo(A),
    own: runsOf.get(A.org_ref) ?? [],
  });

  const rows = await claimsOfReceipt(t.app.iwik.pool, receiptA.receipt_id);
  assert.deepEqual(rows.map((r) => r.claim_key).sort(), released.map((f) => f.claim).sort());
  for (const row of rows) {
    assert.equal(row.claim_id, ids[row.claim_key]);
    assert.equal(row.org_ref, A.org_ref);
    assert.equal(row.status, 'supported');
    assert.equal(row.origin, 'measured');
    assert.equal(row.corroboration, 'unreplicated');
    const claim = toClaim(row);
    assert.equal(claim.derivation.method, 'cooperative_release');
    assert.equal(claim.derivation.evidence_revision, receiptA.evidence_revision);
    assert.equal(claim.derivation.orgs, receiptA.cohort.orgs);
    assert.equal(claim.supporting_runs, receiptA.cohort.runs);
    assert.equal(claim.receipt_id, receiptA.receipt_id);
    // a claim names its evidence as bands only, never as runs
    assertPrivateFor(claim, A);
    for (const runId of runsOf.get(A.org_ref) ?? []) {
      assert.ok(!JSON.stringify(claim).includes(runId), 'no run id in a claim');
    }
  }

  // idempotent: the same receipt again creates nothing and returns the same ids
  const stored = await findReceipt(t.app.iwik.pool, receiptA.receipt_id, A.org_ref);
  assert.ok(stored);
  const view = receiptForClaims(stored, A.org_ref);
  assert.ok(view);
  const again = await ensureClaimsForReceipt(t.app.iwik.pool, view);
  assert.deepEqual(again, ids);
  assert.equal((await claimsOfReceipt(t.app.iwik.pool, receiptA.receipt_id)).length, rows.length);

  // the re-read receipt carries the same claim ids; a second query (a cache
  // hit) is a new receipt with claim rows of its own
  const reread = (await readReceipt(A.token, receiptA.receipt_id)) as unknown as AnswerReceipt;
  assert.deepEqual(claimIds(reread), ids);
  const second = await query(A.token);
  assert.notEqual(second.receipt_id, receiptA.receipt_id);
  const secondIds = claimIds(second);
  assert.equal(Object.keys(secondIds).length, released.length);
  for (const key of Object.keys(ids)) assert.notEqual(secondIds[key], ids[key]);
  assert.equal((await claimsOfReceipt(t.app.iwik.pool, second.receipt_id)).length, released.length);
});

test('lifecycle: file against a receipt -> open; visible to the filer only; operator resolves upheld -> contradicts relationship per claim, claims contradicted/disputed, revision bumped (kind challenge), the receipt reads stale; resolving again is 409', async () => {
  const revisionBefore = await currentRevision(t.app.iwik.pool);
  const filed = await fileOk(A.token, { kind: 'receipt', id: receiptA.receipt_id }, 'method', {
    claim: 'latency_distribution',
    metric: 'ttft_ms',
    statistic: 'p50',
    note: 'The p50 spread looks pooled rather than per-run.',
  });
  assert.equal(filed.status, 'open');
  assert.equal(filed.grounds, 'method');
  assert.deepEqual(filed.target, { kind: 'receipt', id: receiptA.receipt_id });
  assert.equal(filed.protocol_ref, PROTOCOL);
  assert.equal(filed.evaluation_method, 'operator_review');
  assert.equal(filed.resolution, undefined);
  assertPrivateFor(filed, A);
  // filing changes no evidence: no revision moved
  assert.equal(await currentRevision(t.app.iwik.pool), revisionBefore);

  // visible to the filer; 404 for anyone else (B, and the query-only Z)
  const mine = await getChallenge(A.token, filed.challenge_id);
  assert.equal(mine.statusCode, 200);
  assert.deepEqual(mine.json(), filed);
  for (const other of [B, Z, D]) {
    const res = await getChallenge(other.token, filed.challenge_id);
    assert.equal(res.statusCode, 404, other.org_id);
    assert.equal(errorCode(res), 'not_found');
    assert.ok(!res.body.includes(filed.challenge_id));
  }
  // the audit row names ids only
  const audit = await t.app.iwik.pool.query<{ actor: string; target: string }>(
    `SELECT actor, target FROM identity.audit WHERE event = 'challenge.filed' AND target = $1`,
    [`challenge:${filed.challenge_id}`],
  );
  assert.deepEqual(audit.rows, [
    { actor: `node:${A.node_id}`, target: `challenge:${filed.challenge_id}` },
  ]);

  // the operator resolves: wrong token 401, kind that contradicts the resolution 422
  const wrongToken = await resolveApi(
    filed.challenge_id,
    'upheld',
    'method_error',
    'not-the-operator-token-000000',
  );
  assert.equal(wrongToken.statusCode, 401);
  const nodeToken = await resolveApi(filed.challenge_id, 'upheld', 'method_error', A.token);
  assert.equal(nodeToken.statusCode, 401, 'a node token is not an operator token');
  const wrongKind = await t.app.inject({
    method: 'POST',
    url: `/v1/admin/challenges/${filed.challenge_id}/resolve`,
    headers: authHeader(OPERATOR_TOKEN),
    payload: {
      resolution: 'upheld',
      relationship: { kind: 'supersedes', rationale: 'method_error' },
    },
  });
  assert.equal(wrongKind.statusCode, 422);
  assert.deepEqual(wrongKind.json<{ error: { details: unknown } }>().error.details, [
    { path: '/relationship/kind', rule: 'resolution_kind' },
  ]);
  const freeText = await t.app.inject({
    method: 'POST',
    url: `/v1/admin/challenges/${filed.challenge_id}/resolve`,
    headers: authHeader(OPERATOR_TOKEN),
    payload: {
      resolution: 'upheld',
      relationship: { kind: 'contradicts', rationale: 'because Ledger Beta cheated' },
    },
  });
  assert.equal(freeText.statusCode, 422);
  assertNoEcho(freeText.body, { rationale: 'because Ledger Beta cheated' });
  assert.equal((await findChallenge(t.app.iwik.pool, filed.challenge_id))?.status, 'open');

  const resolved = await resolveApi(filed.challenge_id, 'upheld', 'method_error');
  assert.equal(resolved.statusCode, 200, resolved.body);
  const outcome = resolved.json<{
    challenge_id: string;
    status: string;
    resolution: string;
    relationship_id: string;
    relationships: number;
    resolved_revision: number;
  }>();
  assert.equal(outcome.status, 'resolved');
  assert.equal(outcome.resolution, 'upheld');
  assert.equal(outcome.resolved_revision, revisionBefore + 1);
  assert.equal(await currentRevision(t.app.iwik.pool), revisionBefore + 1);
  const claims = await claimsOfReceipt(t.app.iwik.pool, receiptA.receipt_id);
  assert.equal(outcome.relationships, claims.length);

  // one relationship per claim of the receipt, from the challenge's own
  // counter-claim (reported, not measured) to each released claim
  const relationships = await relationshipsOfChallenge(t.app.iwik.pool, filed.challenge_id);
  assert.equal(relationships.length, claims.length);
  assert.ok(relationships.some((r) => r.relationship_id === outcome.relationship_id));
  const counterIds = new Set(relationships.map((r) => r.source_claim_id));
  assert.equal(counterIds.size, 1);
  const counter = await t.app.iwik.pool.query<{
    origin: string;
    status: string;
    receipt_id: string | null;
    org_ref: string;
    payload: { derivation: Record<string, unknown> };
  }>(
    `SELECT origin, status, receipt_id, org_ref, payload FROM evidence.claims WHERE claim_id = $1`,
    [[...counterIds][0]],
  );
  assert.equal(counter.rows[0]?.origin, 'reported');
  assert.equal(counter.rows[0]?.status, 'supported');
  assert.equal(counter.rows[0]?.receipt_id, null);
  assert.equal(counter.rows[0]?.org_ref, A.org_ref);
  assert.deepEqual(counter.rows[0]?.payload.derivation, {
    method: 'challenge',
    challenge_id: filed.challenge_id,
    grounds: 'method',
  });
  for (const r of relationships) {
    const entity = toRelationship(r);
    assert.equal(entity.kind, 'contradicts');
    assert.equal(entity.rationale, 'method_error');
    assert.equal(entity.revision, revisionBefore + 1);
    assert.equal(entity.challenge_id, filed.challenge_id);
    assert.ok(claims.some((c) => c.claim_id === entity.target_claim_id));
  }
  for (const c of claims) {
    assert.equal(c.status, 'contradicted');
    assert.equal(c.corroboration, 'disputed');
    assert.equal(validate('Claim', toClaim(c)).ok, true);
  }

  // the revision log says a challenge touched the protocol; the earlier
  // receipt reads stale on re-read and nothing else about it changes
  const log = await t.app.iwik.pool.query<{ kind: string }>(
    `SELECT kind FROM evidence.revision_log WHERE revision = $1 AND protocol_ref = $2`,
    [revisionBefore + 1, PROTOCOL],
  );
  assert.deepEqual(log.rows, [{ kind: 'challenge' }]);
  const stale = await readReceipt(A.token, receiptA.receipt_id);
  assert.equal(stale['status'], 'stale');
  const restored: Record<string, unknown> = { ...stale, status: 'released' };
  delete restored['kind'];
  assert.deepEqual(restored, receiptA);
  assert.ok(
    !JSON.stringify(stale).includes(filed.challenge_id),
    'the receipt says nothing about why',
  );
  // the cached outcome for the protocol is gone and a fresh query recomputes at the new revision
  const cache = await t.app.iwik.pool.query(
    `SELECT 1 FROM evidence.cache WHERE protocol_ref = $1`,
    [PROTOCOL],
  );
  assert.equal(cache.rows.length, 0);
  const fresh = await query(A.token);
  assert.equal(fresh.evidence_revision, revisionBefore + 1);
  assert.equal(fresh.status, 'released');

  // the filer sees the resolution; a second resolution is refused
  const after = await getChallenge(A.token, filed.challenge_id);
  const done = after.json<Challenge>();
  assert.equal(done.status, 'resolved');
  assert.equal(done.resolution, 'upheld');
  assert.equal(done.relationship_id, outcome.relationship_id);
  assert.equal(done.resolved_revision, revisionBefore + 1);
  assert.ok(done.resolved_at && done.acknowledged_at);
  assert.deepEqual(validate('Challenge', done), { ok: true, errors: [] });
  assertPrivateFor(done, A);
  const again = await resolveApi(filed.challenge_id, 'rejected', 'insufficient_grounds');
  assert.equal(again.statusCode, 409);
  assert.equal(errorCode(again), 'challenge_resolved');
  assert.equal(await currentRevision(t.app.iwik.pool), revisionBefore + 1, 'no second bump');
  const unknown = await resolveApi('01ARZ3NDEKTSV4RRFFQ69G5ZZZ', 'upheld', 'method_error');
  assert.equal(unknown.statusCode, 404);
});

test('claim target and the other resolutions: rejected narrows (claim untouched), superseded supersedes (claim rejected); every resolution bumps the revision', async () => {
  const receipt = await query(B.token);
  const ids = claimIds(receipt);
  const [key, claimId] = Object.entries(ids)[0] as [string, string];

  const rejected = await fileOk(B.token, { kind: 'claim', id: claimId }, 'context_mismatch', {
    context_key: 'retry_policy',
  });
  assert.deepEqual(rejected.target, { kind: 'claim', id: claimId });
  const before = await currentRevision(t.app.iwik.pool);
  const r1 = await resolveApi(rejected.challenge_id, 'rejected', 'insufficient_grounds');
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json<{ relationships: number }>().relationships, 1);
  const rels1 = await relationshipsOfChallenge(t.app.iwik.pool, rejected.challenge_id);
  assert.equal(rels1.length, 1);
  assert.equal(rels1[0]?.kind, 'narrows');
  assert.equal(rels1[0]?.target_claim_id, claimId);
  const untouched = (await claimsOfReceipt(t.app.iwik.pool, receipt.receipt_id)).find(
    (c) => c.claim_id === claimId,
  );
  assert.equal(untouched?.status, 'supported');
  assert.equal(untouched?.corroboration, 'unreplicated');
  const counter1 = await t.app.iwik.pool.query<{ status: string; claim_key: string }>(
    `SELECT status, claim_key FROM evidence.claims WHERE claim_id = $1`,
    [rels1[0]?.source_claim_id],
  );
  assert.equal(counter1.rows[0]?.status, 'rejected');
  assert.equal(counter1.rows[0]?.claim_key, key);
  assert.equal(await currentRevision(t.app.iwik.pool), before + 1);

  const superseded = await fileOk(B.token, { kind: 'claim', id: claimId }, 'affiliation');
  const r2 = await resolveApi(superseded.challenge_id, 'superseded', 'protocol_superseded');
  assert.equal(r2.statusCode, 200, r2.body);
  const rels2 = await relationshipsOfChallenge(t.app.iwik.pool, superseded.challenge_id);
  assert.equal(rels2[0]?.kind, 'supersedes');
  const gone = (await claimsOfReceipt(t.app.iwik.pool, receipt.receipt_id)).find(
    (c) => c.claim_id === claimId,
  );
  assert.equal(gone?.status, 'rejected');
  assert.equal(gone?.corroboration, 'disputed');
  assert.equal(await currentRevision(t.app.iwik.pool), before + 2);
  assert.equal((await readReceipt(B.token, receipt.receipt_id))['status'], 'stale');
});

test('refusals: foreign or unknown targets are 404 with nothing named, unreleased receipts 422, free-text grounds 422, note bounded and secret-scanned, scope enforced, error bodies never echo', async () => {
  const receiptB = await query(B.token);
  const claimB = Object.values(claimIds(receiptB))[0] as string;

  // A against B's receipt or claim: 404, and the id is not confirmed
  for (const target of [
    { kind: 'receipt' as const, id: receiptB.receipt_id },
    { kind: 'claim' as const, id: claimB },
    { kind: 'receipt' as const, id: '01ARZ3NDEKTSV4RRFFQ69G5ZZZ' },
    { kind: 'claim' as const, id: '01ARZ3NDEKTSV4RRFFQ69G5ZZZ' },
  ]) {
    const res = await file(A.token, target);
    assert.equal(res.statusCode, 404, JSON.stringify(target));
    assert.equal(errorCode(res), 'not_found');
    assert.ok(!res.body.includes(target.id));
  }
  // a replication run that is not the filer's: 404 as a whole
  const foreignRun = (runsOf.get(B.org_ref) ?? [])[0] as string;
  const notMine = await file(
    A.token,
    { kind: 'receipt', id: receiptA.receipt_id },
    'replication_failed',
    {
      replication_run_id: foreignRun,
    },
  );
  assert.equal(notMine.statusCode, 404);
  assert.ok(!notMine.body.includes(foreignRun));
  // the filer's own run is fine
  const ownRun = (runsOf.get(A.org_ref) ?? [])[0] as string;
  const mine = await fileOk(
    A.token,
    { kind: 'receipt', id: receiptA.receipt_id },
    'replication_failed',
    {
      replication_run_id: ownRun,
      direction: 'higher',
    },
  );
  assert.equal(mine.statement.replication_run_id, ownRun);

  // a receipt whose answer was not released (an empty region): 422 not_released
  const empty = await query(A.token, 'nowhere');
  assert.equal(empty.status, 'insufficient_evidence');
  const unreleased = await file(A.token, { kind: 'receipt', id: empty.receipt_id });
  assert.equal(unreleased.statusCode, 422);
  assert.deepEqual(unreleased.json<{ error: { details: unknown } }>().error.details, [
    { path: '/target/id', rule: 'not_released' },
  ]);

  // shape: free-text grounds, an unknown statement member, a note beyond the
  // bound, a secret in the note; the value is never echoed
  const secret = 'AKIA' + 'IOSFODNN7EXAMPLE';
  const cases: Array<[object, Array<{ path: string; rule: string }>]> = [
    [
      { target: { kind: 'receipt', id: receiptA.receipt_id }, grounds: 'the numbers look wrong' },
      [{ path: '/grounds', rule: 'enum' }],
    ],
    [
      {
        target: { kind: 'receipt', id: receiptA.receipt_id },
        grounds: 'method',
        statement: { objection: 'x' },
      },
      [{ path: '/statement', rule: 'additionalProperties' }],
    ],
    [
      {
        target: { kind: 'receipt', id: receiptA.receipt_id },
        grounds: 'method',
        statement: { note: 'n'.repeat(501) },
      },
      [{ path: '/statement/note', rule: 'maxLength' }],
    ],
    [
      {
        target: { kind: 'receipt', id: receiptA.receipt_id },
        grounds: 'method',
        statement: { note: `key ${secret}` },
      },
      [{ path: '/statement/note', rule: 'secret_pattern' }],
    ],
    [
      {
        target: { kind: 'receipt', id: receiptA.receipt_id },
        grounds: 'method',
        statement: { claim: 'Latency Distribution' },
      },
      [{ path: '/statement/claim', rule: 'pattern' }],
    ],
    [
      { target: { kind: 'thing', id: 'x' }, grounds: 'method' },
      [
        { path: '/target/kind', rule: 'enum' },
        { path: '/target/id', rule: 'pattern' },
      ],
    ],
    [{ grounds: 'method' }, [{ path: '/target', rule: 'required' }]],
  ];
  for (const [payload, expected] of cases) {
    const res = await post(A.token, '/v1/challenges', payload);
    assert.equal(res.statusCode, 422, JSON.stringify(payload));
    const details = res.json<{ error: { details: Array<{ path: string; rule: string }> } }>().error
      .details;
    for (const e of expected) {
      assert.ok(
        details.some((d) => d.path === e.path && d.rule === e.rule),
        `${JSON.stringify(e)} in ${JSON.stringify(details)}`,
      );
    }
    assertNoEcho(res.body, payload);
    assert.ok(!res.body.includes(secret));
  }
  // nothing above was stored; the secret is nowhere in the database
  const notes = await t.app.iwik.pool.query<{ statement: { note?: string } }>(
    `SELECT statement FROM evidence.challenges WHERE org_ref = $1`,
    [A.org_ref],
  );
  for (const row of notes.rows) assert.ok(!(row.statement.note ?? '').includes(secret));

  // scope and auth
  const queryOnly = await file(Z.token, { kind: 'receipt', id: receiptA.receipt_id });
  assert.equal(queryOnly.statusCode, 403);
  assert.equal(errorCode(queryOnly), 'scope_required');
  const anon = await t.app.inject({ method: 'POST', url: '/v1/challenges', payload: {} });
  assert.equal(anon.statusCode, 401);
  const badId = await getChallenge(A.token, 'not-a-ulid');
  assert.equal(badId.statusCode, 404);

  // pure parsers
  assert.throws(() => parseChallengeBody('x', t.app.iwik.config), ApiError);
  assert.throws(() => parseResolveBody({ resolution: 'maybe' }), ApiError);
});

test('rate limit: the sixth challenge in a rolling day is 429 with Retry-After; the earlier five stand; another organization is unaffected', async () => {
  const receipt = await query(D.token);
  assert.equal(receipt.status, 'released');
  const filed: Challenge[] = [];
  for (let i = 0; i < CHALLENGE_RATE_LIMIT.max; i++) {
    filed.push(await fileOk(D.token, { kind: 'receipt', id: receipt.receipt_id }, 'data_error'));
  }
  const sixth = await file(D.token, { kind: 'receipt', id: receipt.receipt_id });
  assert.equal(sixth.statusCode, 429);
  assert.equal(errorCode(sixth), 'rate_limited');
  const retryAfter = Number(sixth.headers['retry-after']);
  assert.ok(
    Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 24 * 60 * 60,
    String(retryAfter),
  );
  assert.equal(
    (
      await t.app.iwik.pool.query(`SELECT 1 FROM evidence.challenges WHERE org_ref = $1`, [
        D.org_ref,
      ])
    ).rows.length,
    CHALLENGE_RATE_LIMIT.max,
  );
  for (const c of filed) {
    const res = await getChallenge(D.token, c.challenge_id);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json<Challenge>().status, 'open');
  }
  // a different organization files freely
  const other = await file(B.token, { kind: 'receipt', id: (await query(B.token)).receipt_id });
  assert.equal(other.statusCode, 201);
  // the window is rolling: a challenge older than a day no longer counts
  await t.app.iwik.pool.query(
    `UPDATE evidence.challenges SET filed_at = now() - interval '25 hours' WHERE challenge_id = $1`,
    [filed[0]?.challenge_id],
  );
  const afterWindow = await file(D.token, { kind: 'receipt', id: receipt.receipt_id });
  assert.equal(afterWindow.statusCode, 201);
});

test('predictions: registered before the outcome; the observation is recorded once, never alters the prediction, restated targets must match, environment_changed is separate from the result', async () => {
  const receipt = receiptA;
  const register = {
    prediction: {
      based_on_receipt_id: receipt.receipt_id,
      target: {
        claim: 'latency_distribution',
        metric: 'ttft_ms',
        statistic: 'p95',
        comparator: 'below',
        value: 300,
        unit: 'ms',
      },
      horizon: FUTURE,
      probability: 0.7,
      evaluation_rule: 'own_measurement',
    },
  };
  const registered = await post(A.token, '/v1/outcomes', register);
  assert.equal(registered.statusCode, 201, registered.body);
  const prediction = registered.json<Prediction>();
  assert.deepEqual(validate('Prediction', prediction), { ok: true, errors: [] });
  assert.equal(prediction.based_on_receipt_id, receipt.receipt_id);
  assert.equal(prediction.protocol_ref, PROTOCOL);
  assert.deepEqual(prediction.target, register.prediction.target);
  assert.equal(prediction.horizon, FUTURE);
  assert.equal(prediction.probability, 0.7);
  assert.equal(prediction.evaluation_rule, 'own_measurement');
  assert.ok(Date.parse(prediction.registered_at) <= Date.now());
  assertPrivateFor(prediction, A);
  const snapshot = await t.app.iwik.pool.query(
    `SELECT * FROM evidence.predictions WHERE prediction_id = $1`,
    [prediction.prediction_id],
  );
  assert.equal(snapshot.rows.length, 1);

  // refusals before any observation: a restated prediction, a mismatched
  // target, a mismatched receipt, someone else's prediction
  const immutable = await post(A.token, '/v1/outcomes', {
    prediction_id: prediction.prediction_id,
    prediction: { ...register.prediction, target: { claim: 'error_rate' } },
    observed: { observed_at: new Date().toISOString(), result: 'met', environment_changed: false },
  });
  assert.equal(immutable.statusCode, 409);
  assert.equal(errorCode(immutable), 'prediction_immutable');
  const mismatch = await post(A.token, '/v1/outcomes', {
    prediction_id: prediction.prediction_id,
    target: { ...register.prediction.target, value: 900 },
    observed: {
      observed_at: new Date().toISOString(),
      result: 'not_met',
      environment_changed: false,
    },
  });
  assert.equal(mismatch.statusCode, 409);
  assert.equal(errorCode(mismatch), 'target_mismatch');
  const wrongReceipt = await post(A.token, '/v1/outcomes', {
    prediction_id: prediction.prediction_id,
    based_on_receipt_id: '01ARZ3NDEKTSV4RRFFQ69G5ZZZ',
    observed: {
      observed_at: new Date().toISOString(),
      result: 'not_met',
      environment_changed: false,
    },
  });
  assert.equal(wrongReceipt.statusCode, 409);
  assert.equal(errorCode(wrongReceipt), 'target_mismatch');
  const notOwner = await post(B.token, '/v1/outcomes', {
    prediction_id: prediction.prediction_id,
    observed: { observed_at: new Date().toISOString(), result: 'met', environment_changed: false },
  });
  assert.equal(notOwner.statusCode, 404);
  assert.ok(!notOwner.body.includes(prediction.prediction_id));
  const tooEarly = await post(A.token, '/v1/outcomes', {
    prediction_id: prediction.prediction_id,
    observed: { observed_at: '2020-01-01T00:00:00Z', result: 'met', environment_changed: false },
  });
  assert.equal(tooEarly.statusCode, 422);
  assert.equal(
    (
      await t.app.iwik.pool.query(`SELECT 1 FROM evidence.outcomes WHERE prediction_id = $1`, [
        prediction.prediction_id,
      ])
    ).rows.length,
    0,
  );

  // the observation, with the environment flag set and the result not_met:
  // stored in separate columns, returned separately
  const observedAt = new Date().toISOString();
  const observed = await post(A.token, '/v1/outcomes', {
    prediction_id: prediction.prediction_id,
    based_on_receipt_id: receipt.receipt_id,
    target: register.prediction.target,
    observed: { observed_at: observedAt, result: 'not_met', environment_changed: true },
  });
  assert.equal(observed.statusCode, 201, observed.body);
  const outcome = observed.json<Outcome>();
  assert.deepEqual(validate('Outcome', outcome), { ok: true, errors: [] });
  assert.deepEqual(
    outcome.prediction,
    prediction,
    'the prediction comes back exactly as registered',
  );
  assert.equal(outcome.observed.result, 'not_met');
  assert.equal(outcome.observed.environment_changed, true);
  assert.equal(outcome.observed.observed_at, observedAt);
  assertPrivateFor(outcome, A);
  const row = await t.app.iwik.pool.query<{ result: string; environment_changed: boolean }>(
    `SELECT result, environment_changed FROM evidence.outcomes WHERE prediction_id = $1`,
    [prediction.prediction_id],
  );
  assert.deepEqual(row.rows, [{ result: 'not_met', environment_changed: true }]);

  // exactly one observation
  const second = await post(A.token, '/v1/outcomes', {
    prediction_id: prediction.prediction_id,
    observed: { observed_at: new Date().toISOString(), result: 'met', environment_changed: false },
  });
  assert.equal(second.statusCode, 409);
  assert.equal(errorCode(second), 'outcome_exists');

  // the prediction row is byte-for-byte what it was, and the database itself
  // refuses to change it
  const after = await t.app.iwik.pool.query(
    `SELECT * FROM evidence.predictions WHERE prediction_id = $1`,
    [prediction.prediction_id],
  );
  assert.deepEqual(after.rows, snapshot.rows);
  await assert.rejects(
    t.app.iwik.pool.query(
      `UPDATE evidence.predictions SET probability = 0.1 WHERE prediction_id = $1`,
      [prediction.prediction_id],
    ),
    /immutable/,
  );

  // registration refusals: a foreign receipt, a claim the protocol does not
  // permit, a horizon in the past, a probability outside [0, 1], shape
  const foreign = await post(A.token, '/v1/outcomes', {
    prediction: { ...register.prediction, based_on_receipt_id: (await query(B.token)).receipt_id },
  });
  assert.equal(foreign.statusCode, 404);
  const badClaim = await post(A.token, '/v1/outcomes', {
    prediction: { ...register.prediction, target: { claim: 'throughput' } },
  });
  assert.equal(badClaim.statusCode, 422);
  assert.deepEqual(badClaim.json<{ error: { details: unknown } }>().error.details, [
    { path: '/prediction/target/claim', rule: 'claim_unknown' },
  ]);
  const past = await post(A.token, '/v1/outcomes', {
    prediction: { ...register.prediction, horizon: '2020-01-01' },
  });
  assert.equal(past.statusCode, 422);
  assert.ok(
    past
      .json<{ error: { details: Array<{ path: string; rule: string }> } }>()
      .error.details.some((d) => d.path === '/prediction/horizon' && d.rule === 'minimum'),
  );
  const badProbability = await post(A.token, '/v1/outcomes', {
    prediction: { ...register.prediction, probability: 1.5 },
  });
  assert.equal(badProbability.statusCode, 422);
  const both = await post(A.token, '/v1/outcomes', {
    prediction: register.prediction,
    observed: { observed_at: observedAt, result: 'met', environment_changed: false },
  });
  assert.equal(both.statusCode, 422);
  const neither = await post(A.token, '/v1/outcomes', {});
  assert.equal(neither.statusCode, 422);
  const queryOnly = await post(Z.token, '/v1/outcomes', register);
  assert.equal(queryOnly.statusCode, 403);
  assert.throws(() => parseOutcomeBody([]), ApiError);
});

test('console: operator sign-in (CSRF, rate limited, constant-time hash), open challenges listed with grounds and target kind only, acknowledge and resolve forms; nothing of any member on the page', async () => {
  const filed = await fileOk(A.token, { kind: 'receipt', id: receiptA.receipt_id }, 'affiliation', {
    note: 'A note only the operator may read: mentions Ledger Alpha itself.',
  });
  const jar = new CookieJar('10.7.7.7');

  // signed out: the list redirects to the login page
  const anon = await browse(t, jar, '/admin/challenges');
  assert.equal(anon.statusCode, 303);
  assert.equal(anon.headers.location, '/admin/login');
  const page = await browse(t, jar, '/admin/login');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /name="token" type="password"/);

  // CSRF: a login without the nonce is 403 and sets no session
  const noCsrf = await postForm(t, jar, '/admin/login', { token: OPERATOR_TOKEN }, { csrf: null });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(jar.get(OPERATOR_COOKIE), undefined);

  // wrong token: failed; five failures then 429 from that address
  const wrong = await postForm(t, jar, '/admin/login', { token: 'not-the-operator-token-000000' });
  assert.equal(wrong.statusCode, 303);
  assert.equal(wrong.headers.location, '/admin/login?login=failed');
  assert.equal(jar.get(OPERATOR_COOKIE), undefined);
  const failed = await browse(t, jar, '/admin/login?login=failed');
  assert.match(failed.body, /id="login-error"/);
  const attacker = new CookieJar('10.8.8.8');
  for (let i = 0; i < 5; i++) {
    const res = await postForm(t, attacker, '/admin/login', {
      token: `guess-${i}-000000000000000000`,
    });
    assert.equal(res.statusCode, 303);
  }
  const limited = await postForm(t, attacker, '/admin/login', { token: OPERATOR_TOKEN });
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers['retry-after']) >= 1);
  assert.equal(
    attacker.get(OPERATOR_COOKIE),
    undefined,
    'even the right token is refused while limited',
  );

  // the right token: a session cookie carrying a hash, never the token
  const ok = await postForm(t, jar, '/admin/login', { token: OPERATOR_TOKEN });
  assert.equal(ok.statusCode, 303, ok.body);
  assert.equal(ok.headers.location, '/admin/challenges');
  const cookie = jar.get(OPERATOR_COOKIE);
  assert.ok(cookie);
  assert.ok(!cookie.includes(OPERATOR_TOKEN));
  assert.ok(
    !Buffer.from(cookie.split('.')[0] ?? '', 'base64url')
      .toString('utf8')
      .includes(OPERATOR_TOKEN),
  );
  const audit = await t.app.iwik.pool.query(
    `SELECT 1 FROM identity.audit WHERE event = 'console.operator_login'`,
  );
  assert.ok(audit.rows.length >= 1);
  // a forged cookie (wrong signature) is not a session
  const forged = new CookieJar('10.7.7.8');
  forged.absorb({
    headers: { 'set-cookie': `${OPERATOR_COOKIE}=${cookie.slice(0, -4)}AAAA` },
  } as never);
  const forgedList = await browse(t, forged, '/admin/challenges');
  assert.equal(forgedList.headers.location, '/admin/login');

  // the list: the challenge with its grounds and target kind; no note, no
  // target id, no organization name, no run id, no org_ref
  const list = await browse(t, jar, '/admin/challenges');
  assert.equal(list.statusCode, 200);
  assert.match(list.body, new RegExp(`id="challenge-${filed.challenge_id}"`));
  assert.match(list.body, /<code class="grounds">affiliation<\/code>/);
  assert.match(list.body, /<td>receipt<\/td>/);
  assert.ok(!list.body.includes('only the operator may read'), 'the note is not listed');
  assert.ok(!list.body.includes(receiptA.receipt_id), 'the target id is not listed');
  for (const s of [...secrets, ...[...runsOf.values()].flat()]) {
    assert.ok(!list.body.includes(s), 'no member identifier on the operator page');
  }
  // the signed-in member console knows nothing of the operator cookie
  const memberPage = await browse(t, jar, '/org');
  assert.equal(memberPage.statusCode, 303, 'an operator session is not a member session');

  // acknowledge, then resolve through the form; each needs the nonce
  const ack = await postForm(t, jar, `/admin/challenges/${filed.challenge_id}/resolve`, {
    action: 'acknowledge',
  });
  assert.equal(ack.headers.location, '/admin/challenges?notice=acknowledged');
  assert.equal((await findChallenge(t.app.iwik.pool, filed.challenge_id))?.status, 'acknowledged');
  const acked = await browse(t, jar, '/admin/challenges?notice=acknowledged');
  assert.match(acked.body, /id="notice">[\s\S]*Challenge acknowledged/);
  assert.match(acked.body, /<td>acknowledged<\/td>/);
  const unconfirmed = await postForm(t, jar, `/admin/challenges/${filed.challenge_id}/resolve`, {
    action: 'resolve',
    resolution: 'rejected',
    rationale: 'insufficient_grounds',
  });
  assert.equal(unconfirmed.headers.location, '/admin/challenges?error=confirm');
  const badRationale = await postForm(t, jar, `/admin/challenges/${filed.challenge_id}/resolve`, {
    action: 'resolve',
    resolution: 'rejected',
    rationale: 'because',
    confirm: 'on',
  });
  assert.equal(badRationale.headers.location, '/admin/challenges?error=rationale');
  const csrfLess = await postForm(
    t,
    jar,
    `/admin/challenges/${filed.challenge_id}/resolve`,
    { action: 'resolve', resolution: 'rejected', rationale: 'insufficient_grounds', confirm: 'on' },
    { csrf: null },
  );
  assert.equal(csrfLess.statusCode, 403);
  const before = await currentRevision(t.app.iwik.pool);
  const resolved = await postForm(t, jar, `/admin/challenges/${filed.challenge_id}/resolve`, {
    action: 'resolve',
    resolution: 'rejected',
    rationale: 'insufficient_grounds',
    confirm: 'on',
  });
  assert.equal(resolved.headers.location, '/admin/challenges?notice=resolved');
  assert.equal(await currentRevision(t.app.iwik.pool), before + 1);
  const done = toChallenge((await findChallenge(t.app.iwik.pool, filed.challenge_id)) as never);
  assert.equal(done.status, 'resolved');
  assert.equal(done.resolution, 'rejected');
  const afterList = await browse(t, jar, '/admin/challenges?notice=resolved');
  assert.match(afterList.body, /id="notice">[\s\S]*Challenge resolved/);
  assert.ok(
    !afterList.body.includes(`id="challenge-${filed.challenge_id}"`),
    'resolved ones drop off',
  );
  const twice = await postForm(t, jar, `/admin/challenges/${filed.challenge_id}/resolve`, {
    action: 'resolve',
    resolution: 'upheld',
    rationale: 'affiliation',
    confirm: 'on',
  });
  assert.equal(twice.headers.location, '/admin/challenges?error=already_resolved');

  // sign out ends the session
  const out = await postForm(t, jar, '/admin/logout', {});
  assert.equal(out.headers.location, '/admin/login');
  assert.equal(jar.get(OPERATOR_COOKIE), undefined);
  const gone = await browse(t, jar, '/admin/challenges');
  assert.equal(gone.headers.location, '/admin/login');
});

test('MCP and CLI end-to-end: challenge_finding, register_prediction, report_outcome over stdio, then iwik challenge / predict / outcome, against this service', async () => {
  const serviceUrl = await t.app.listen({ port: 0, host: '127.0.0.1' });
  const base = mkdtempSync(join(tmpdir(), 'iwik-ledger-'));
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
  const client = new Client({ name: 'iwik-ledger-test', version: '0.0.0' });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>): Promise<Envelope> => {
    const result = await client.callTool({ name, arguments: args });
    return result.structuredContent as Envelope;
  };
  try {
    // C (the seeded organization) holds a released receipt of its own
    const receiptC = await query(C.token);
    assert.equal(receiptC.status, 'released');
    const claimC = Object.values(claimIds(receiptC))[0] as string;

    const filed = await call('challenge_finding', {
      receipt_id: receiptC.receipt_id,
      claim_id: claimC,
      grounds: { kind: 'replication_failed', rationale: 'our node measured a higher p95' },
      statement: {
        claim: 'latency_distribution',
        metric: 'ttft_ms',
        statistic: 'p95',
        direction: 'higher',
        replication_run_id: (runsOf.get(C.org_ref) ?? [])[0],
      },
    });
    assert.equal(filed.ok, true, JSON.stringify(filed));
    const challengeId = String(filed.data?.['challenge_id']);
    assert.equal(filed.data?.['status'], 'open');
    assert.equal(filed.data?.['grounds'], 'replication_failed');
    const stored = await findChallenge(t.app.iwik.pool, challengeId, C.org_ref);
    assert.equal(stored?.target_kind, 'claim');
    assert.equal(stored?.target_id, claimC);
    assert.equal(stored?.statement.note, 'our node measured a higher p95');
    assertPrivateFor(filed, C);

    // a receipt of another organization: not_found with a next step, nothing named
    const foreign = await call('challenge_finding', {
      receipt_id: receiptA.receipt_id,
      grounds: { kind: 'method', rationale: 'no' },
    });
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error?.code, 'not_found');
    assert.ok(!JSON.stringify(foreign).includes(receiptA.receipt_id));

    const registered = await call('register_prediction', {
      receipt_id: receiptC.receipt_id,
      target: { claim: 'error_rate', comparator: 'below', value: 0.1 },
      horizon: FUTURE,
      evaluation_rule: 'operational_observation',
    });
    assert.equal(registered.ok, true, JSON.stringify(registered));
    const predictionId = String(registered.data?.['prediction_id']);
    const reported = await call('report_outcome', {
      receipt_id: receiptC.receipt_id,
      prediction_id: predictionId,
      observation: { note_for_humans_is_ignored: true },
      result: 'met',
      environment_changed: false,
      observed_at: new Date().toISOString(),
    });
    assert.equal(reported.ok, true, JSON.stringify(reported));
    assert.equal(reported.data?.['prediction_id'], predictionId);
    assert.equal(reported.data?.['result'], 'met');
    assert.equal(reported.data?.['environment_changed'], false);
    const twice = await call('report_outcome', {
      receipt_id: receiptC.receipt_id,
      prediction_id: predictionId,
      observation: {},
      result: 'met',
      observed_at: new Date().toISOString(),
    });
    assert.equal(twice.error?.code, 'outcome_exists');

    // the operator resolves; the filer sees it through get_receipt going stale
    const resolved = await resolveApi(challengeId, 'upheld', 'replication_failed');
    assert.equal(resolved.statusCode, 200, resolved.body);
    const stale = await t.app.inject({
      method: 'GET',
      url: `/v1/receipts/${receiptC.receipt_id}`,
      headers: authHeader(C.token),
    });
    assert.equal(stale.json<{ status: string }>().status, 'stale');

    // the CLI: challenge, predict, outcome print ids and never the token
    const cliChallenge = await iwik(home, [
      'challenge',
      receiptC.receipt_id,
      '--grounds',
      'context_mismatch',
      '--context-key',
      'retry_policy',
      '--note',
      'retry policy differs',
    ]);
    assert.equal(cliChallenge.code, 0, cliChallenge.stderr);
    const cliChallengeId = cliChallenge.stdout.trim();
    assert.match(cliChallengeId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(
      cliChallenge.stderr,
      /challenge filed: open, grounds context_mismatch, target receipt/,
    );
    assert.ok(!cliChallenge.stderr.includes(SEED_NODE_TOKEN));
    assert.equal(
      (await findChallenge(t.app.iwik.pool, cliChallengeId, C.org_ref))?.statement.context_key,
      'retry_policy',
    );

    const cliPredict = await iwik(home, [
      'predict',
      '--receipt',
      receiptC.receipt_id,
      '--target',
      'latency_distribution.ttft_ms.p95',
      '--horizon',
      FUTURE,
      '--rule',
      'own_measurement',
      '--below',
      '300',
      '--unit',
      'ms',
      '--probability',
      '0.6',
    ]);
    assert.equal(cliPredict.code, 0, cliPredict.stderr);
    const cliPredictionId = cliPredict.stdout.trim();
    assert.match(cliPredictionId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
    const cliOutcome = await iwik(home, [
      'outcome',
      cliPredictionId,
      '--result',
      'indeterminate',
      '--environment-changed',
      '--receipt',
      receiptC.receipt_id,
    ]);
    assert.equal(cliOutcome.code, 0, cliOutcome.stderr);
    assert.match(cliOutcome.stdout.trim(), /^[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(cliOutcome.stderr, /outcome recorded: indeterminate \(environment changed\)/);
    const rows = await t.app.iwik.pool.query<{ result: string; environment_changed: boolean }>(
      `SELECT result, environment_changed FROM evidence.outcomes WHERE prediction_id = $1`,
      [cliPredictionId],
    );
    assert.deepEqual(rows.rows, [{ result: 'indeterminate', environment_changed: true }]);
    const mismatch = await iwik(home, [
      'outcome',
      cliPredictionId,
      '--result',
      'met',
      '--receipt',
      receiptA.receipt_id,
    ]);
    assert.equal(mismatch.code, 5);
    assert.match(mismatch.stderr, /target_mismatch|outcome_exists/);
  } finally {
    await client.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('flag off (default): the endpoints answer 404 feature_disabled before authentication, the console pages 404, the tools feature_disabled with a next step; claims are still written on release', async () => {
  const off = await bootApp({
    reset: false,
    nodeKey: t.nodeKey,
    env: {
      IWIK_FEATURE_COOPERATIVE_QUERY: 'on',
      IWIK_FEATURE_DEDUPE: 'on',
      IWIK_FEATURE_ENROLLMENT: 'on',
    },
  });
  try {
    assert.equal(off.app.iwik.config.featureChallenge, false);
    const page = await off.app.inject({ method: 'GET', url: '/' });
    assert.match(page.body, /id="challenge-state">disabled \(IWIK_FEATURE_CHALLENGE=off\)</);
    for (const [method, url, token] of [
      ['POST', '/v1/challenges', A.token],
      ['POST', '/v1/challenges', undefined],
      ['GET', '/v1/challenges/01ARZ3NDEKTSV4RRFFQ69G5ZZZ', A.token],
      ['POST', '/v1/admin/challenges/01ARZ3NDEKTSV4RRFFQ69G5ZZZ/resolve', OPERATOR_TOKEN],
      ['POST', '/v1/outcomes', A.token],
      ['POST', '/v1/outcomes', undefined],
    ] as const) {
      const res = await off.app.inject({
        method,
        url,
        ...(token !== undefined ? { headers: authHeader(token) } : {}),
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      assert.equal(res.statusCode, 404, `${method} ${url}`);
      assert.equal(errorCode(res), 'feature_disabled');
    }
    for (const url of ['/admin/login', '/admin/challenges']) {
      const res = await off.app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 404, url);
      assert.equal(errorCode(res), 'not_found');
    }
    const login = await off.app.inject({
      method: 'POST',
      url: '/admin/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: `token=${OPERATOR_TOKEN}`,
    });
    assert.equal(login.statusCode, 404);

    // a release still writes its claim rows, so turning the flag on needs no backfill
    const receipt = (
      await off.app.inject({
        method: 'POST',
        url: '/v1/evidence/query',
        headers: authHeader(A.token),
        payload: { protocol_ref: PROTOCOL, context_filters: { client_region: REGION } },
      })
    ).json<AnswerReceipt>();
    assert.equal(receipt.status, 'released');
    assert.ok(Object.keys(claimIds(receipt)).length >= 1);
    assert.ok((await claimsOfReceipt(off.app.iwik.pool, receipt.receipt_id)).length >= 1);

    // the MCP tools against the flag-off service
    const serviceUrl = await off.app.listen({ port: 0, host: '127.0.0.1' });
    const base = mkdtempSync(join(tmpdir(), 'iwik-ledger-off-'));
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
    const client = new Client({ name: 'iwik-ledger-off-test', version: '0.0.0' });
    await client.connect(transport);
    try {
      for (const [name, args] of [
        [
          'challenge_finding',
          { receipt_id: receipt.receipt_id, grounds: { kind: 'method', rationale: 'x' } },
        ],
        [
          'register_prediction',
          {
            receipt_id: receipt.receipt_id,
            target: { claim: 'error_rate' },
            horizon: FUTURE,
            evaluation_rule: 'own_measurement',
          },
        ],
        [
          'report_outcome',
          {
            receipt_id: receipt.receipt_id,
            prediction_id: '01ARZ3NDEKTSV4RRFFQ69G5ZZZ',
            observation: {},
            result: 'met',
            observed_at: new Date().toISOString(),
          },
        ],
      ] as const) {
        const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
        const envelope = result.structuredContent as Envelope;
        assert.equal(envelope.ok, false, name);
        assert.equal(envelope.error?.code, 'feature_disabled', name);
        assert.match(envelope.error?.next_step ?? '', /IWIK_FEATURE_CHALLENGE/);
        assert.match(envelope.error?.next_step ?? '', /nothing was sent/);
      }
    } finally {
      await client.close();
      rmSync(base, { recursive: true, force: true });
    }
  } finally {
    await off.app.close();
  }
});
