// Shared test scaffolding: a fresh schema per boot (drop + migrate), an
// env-seeded organization and node with a generated Ed25519 key, the
// conformance fixture patched to the live registry and signed, and (stage 6)
// a cookie jar plus form helpers that drive the enrollment console the way a
// browser would: CSRF cookie, hidden field, redirects.
import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import type { Run } from '@iwik/contracts';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrateUp } from '../src/migrate.js';
import { createNode, createOrganization, issueToken } from '../src/modules/identity/index.js';
import type { Scope } from '../src/modules/identity/index.js';
import { signingPayload } from '../src/modules/intake/index.js';
import type { HandlerDeps } from '../src/modules/jobs/handlers.js';
import { ulid } from '../src/ulid.js';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');

export const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error(
    'service tests need DATABASE_URL (see docker-compose.yml / .github/workflows/ci.yml)',
  );
}
export const TEST_KEK = process.env['IWIK_KEK'] ?? 'test-only-not-a-secret-000000000000000';

export const SEED_ORG = 'Example Org';
export const SEED_NODE_TOKEN = 'test-only-' + 'a'.repeat(24);
/** The node_id carried by contracts/fixtures/v1/run.valid.json. */
export const SEED_NODE_ID = '01ARZ3NDEKTSV4RRFFQ69G5N0D';
/** Stage 6 operator bootstrap token (test only). */
export const OPERATOR_TOKEN = 'test-only-operator-' + 'b'.repeat(24);

export interface NodeKey {
  privateKey: KeyObject;
  /** base64 of the raw 32-byte public key, the form IWIK_SEED_NODE_PUBKEY takes. */
  pubkey: string;
}

export function generateNodeKey(): NodeKey {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { privateKey, pubkey: der.subarray(der.length - 32).toString('base64') };
}

/** The same key as a PEM SPKI block: accepted at registration, though `iwik init` prints only the base64 raw key. */
export function pubkeyPem(key: NodeKey): string {
  const spki = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(key.pubkey, 'base64'),
  ]);
  const b64 = spki.toString('base64');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

/** Drop everything the migrations create and re-apply them. */
export async function resetDatabase(databaseUrl: string = DATABASE_URL as string): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS evidence CASCADE');
    await client.query('DROP SCHEMA IF EXISTS identity CASCADE');
    await client.query('DROP TABLE IF EXISTS public.jobs');
    await client.query('DROP TABLE IF EXISTS public.pgmigrations');
  } finally {
    await client.end();
  }
  await migrateUp(databaseUrl);
}

export interface BootOptions {
  reset?: boolean;
  env?: Record<string, string | undefined>;
  nodeKey?: NodeKey;
}

export interface TestApp {
  app: FastifyInstance;
  nodeKey: NodeKey;
  token: string;
}

export async function bootApp(options: BootOptions = {}): Promise<TestApp> {
  if (options.reset ?? true) await resetDatabase();
  const nodeKey = options.nodeKey ?? generateNodeKey();
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    DATABASE_URL,
    IWIK_KEK: TEST_KEK,
    IWIK_SEED_ORG: SEED_ORG,
    IWIK_SEED_NODE_TOKEN: SEED_NODE_TOKEN,
    IWIK_SEED_NODE_PUBKEY: nodeKey.pubkey,
    IWIK_SEED_NODE_ID: SEED_NODE_ID,
    IWIK_OPERATOR_TOKEN: OPERATOR_TOKEN,
    IWIK_LOG_LEVEL: process.env['IWIK_LOG_LEVEL'] ?? 'silent',
    ...options.env,
  };
  const app = await buildApp(loadConfig(env));
  await app.ready();
  return { app, nodeKey, token: SEED_NODE_TOKEN };
}

/** Boot with IWIK_FEATURE_ENROLLMENT=on (the stage-6 surface). */
export async function bootEnrollmentApp(options: BootOptions = {}): Promise<TestApp> {
  return bootApp({ ...options, env: { IWIK_FEATURE_ENROLLMENT: 'on', ...options.env } });
}

/** Boot with IWIK_FEATURE_DEDUPE=on (the stage-8 surface). */
export async function bootDedupeApp(options: BootOptions = {}): Promise<TestApp> {
  return bootApp({ ...options, env: { IWIK_FEATURE_DEDUPE: 'on', ...options.env } });
}

/**
 * Boot with the stage 9 surface: IWIK_FEATURE_COOPERATIVE_QUERY on, plus
 * withdrawal, dedupe, and enrollment so the whole loop can be driven.
 */
export async function bootCooperativeApp(options: BootOptions = {}): Promise<TestApp> {
  return bootApp({
    ...options,
    env: {
      IWIK_FEATURE_COOPERATIVE_QUERY: 'on',
      IWIK_FEATURE_WITHDRAWAL: 'on',
      IWIK_FEATURE_DEDUPE: 'on',
      IWIK_FEATURE_ENROLLMENT: 'on',
      ...options.env,
    },
  });
}

/** What `buildHandlers` needs, taken from a booted app (the worker builds the same from config). */
export function handlerDeps(t: TestApp): HandlerDeps {
  return {
    envelope: t.app.iwik.envelope,
    registry: t.app.iwik.registry,
    config: t.app.iwik.config,
  };
}

/** The fixture with a fresh run_id and attempt_id so several runs can be accepted. */
export async function freshRun(
  t: TestApp,
  identity: RunIdentity = {},
  patch: (run: Run) => void = () => {},
): Promise<Run> {
  const run = await prepareRun(t, identity);
  run.run_id = ulid();
  run.attempt_id = ulid();
  patch(run);
  return run;
}

export interface OrgWithNode {
  org_id: string;
  org_ref: string;
  node_id: string;
  key: NodeKey;
  token: string;
}

/** A second organization with one node and one token, straight through the identity module. */
export async function createOrgWithNode(
  t: TestApp,
  name: string,
  scopes: readonly Scope[] = ['query', 'submit', 'publish'],
): Promise<OrgWithNode> {
  const { pool } = t.app.iwik;
  const key = generateNodeKey();
  const org = await createOrganization(pool, name);
  const node_id = await createNode(pool, org.org_id, key.pubkey);
  const token = await issueToken(pool, node_id, scopes);
  return { org_id: org.org_id, org_ref: org.org_ref, node_id, key, token };
}

/** Another node (and token) inside an existing organization. */
export async function addNode(
  t: TestApp,
  orgId: string,
  scopes: readonly Scope[] = ['query', 'submit', 'publish'],
): Promise<{ node_id: string; key: NodeKey; token: string }> {
  const { pool } = t.app.iwik;
  const key = generateNodeKey();
  const node_id = await createNode(pool, orgId, key.pubkey);
  const token = await issueToken(pool, node_id, scopes);
  return { node_id, key, token };
}

/** Preview + submit one fresh run as the given node; returns the raw submit response. */
export async function submitFresh(
  t: TestApp,
  who: { node_id: string; key: NodeKey; token: string },
  patch: (run: Run) => void = () => {},
): Promise<{ res: LightMyRequestResponse; run: Run }> {
  const run = await freshRun(t, { nodeId: who.node_id, token: who.token }, patch);
  const p = await preview(t, run, who.token);
  if (p.statusCode !== 200) throw new Error(`preview failed: ${p.statusCode} ${p.body}`);
  const signed = signRun(run, who.key);
  const res = await submit(t, p.json<{ preview_id: string }>().preview_id, signed, who.token);
  return { res, run: signed };
}

export interface IndexRow {
  run_id: string;
  org_ref: string;
  measurement_digest: string | null;
  node_id: string | null;
  index_context: Record<string, { value: unknown; origin: string }> | null;
  is_fixture: boolean;
  index_version: number | null;
  shared_source_suspect: boolean;
  duplicate_of: string | null;
  withdrawn_at: Date | null;
}

/** The stage 8 plaintext columns of one run row. */
export async function indexRow(t: TestApp, runId: string): Promise<IndexRow | undefined> {
  const res = await t.app.iwik.pool.query<IndexRow>(
    `SELECT run_id, org_ref, measurement_digest, node_id, index_context, is_fixture, index_version,
            shared_source_suspect, duplicate_of, withdrawn_at
       FROM evidence.runs WHERE run_id = $1`,
    [runId],
  );
  return res.rows[0];
}

export function loadFixtureRun(): Run {
  const file = resolve(repoRoot, 'contracts', 'fixtures', 'v1', 'run.valid.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Run;
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

export interface RunIdentity {
  nodeId?: string;
  token?: string;
}

/** The fixture with the live registry's digests and the seeded (or given) node id. */
export async function prepareRun(t: TestApp, identity: RunIdentity = {}): Promise<Run> {
  const res = await t.app.inject({
    method: 'GET',
    url: '/v1/protocols/inference-api/latency@1',
    headers: authHeader(identity.token ?? t.token),
  });
  if (res.statusCode !== 200) throw new Error(`registry lookup failed: ${res.statusCode}`);
  const protocol = res.json<{
    protocol_digest: string;
    harness_digest: string;
    result_schema_digest: string;
  }>();
  const run = loadFixtureRun();
  run.node_id = identity.nodeId ?? SEED_NODE_ID;
  run.protocol_digest = protocol.protocol_digest;
  run.harness_digest = protocol.harness_digest;
  run.result_schema_digest = protocol.result_schema_digest;
  return run;
}

export function signRun(run: Run, key: NodeKey): Run {
  const signature = sign(null, Buffer.from(signingPayload(run), 'utf8'), key.privateKey);
  return { ...run, submission: { ...run.submission, signature: signature.toString('base64') } };
}

export async function preview(t: TestApp, run: Run, token: string = t.token) {
  return t.app.inject({
    method: 'POST',
    url: '/v1/contributions/preview',
    headers: authHeader(token),
    payload: { run },
  });
}

export async function submit(t: TestApp, previewId: string, run: Run, token: string = t.token) {
  return t.app.inject({
    method: 'POST',
    url: '/v1/runs',
    headers: authHeader(token),
    payload: { preview_id: previewId, run },
  });
}

export interface Submitter {
  token: string;
  key: NodeKey;
}

/** Preview, sign, submit; returns the receipt and the signed run. */
export async function submitRun(
  t: TestApp,
  run?: Run,
  as: Submitter = { token: t.token, key: t.nodeKey },
): Promise<{ receipt: Record<string, unknown>; run: Run; preview_id: string }> {
  const prepared = run ?? (await prepareRun(t));
  const p = await preview(t, prepared, as.token);
  if (p.statusCode !== 200) throw new Error(`preview failed: ${p.statusCode} ${p.body}`);
  const previewId = p.json<{ preview_id: string }>().preview_id;
  const signed = signRun(prepared, as.key);
  const s = await submit(t, previewId, signed, as.token);
  if (s.statusCode !== 201) throw new Error(`submit failed: ${s.statusCode} ${s.body}`);
  return { receipt: s.json<Record<string, unknown>>(), run: signed, preview_id: previewId };
}

/** Every string value in a JSON value (object keys are schema vocabulary, not member data). */
export function collectStringValues(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    out.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStringValues(item, out);
  } else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStringValues(item, out);
    }
  }
  return out;
}

/** No submitted string value (4+ chars) may appear anywhere in an error body. */
export function assertNoEcho(errorBody: string, submitted: unknown): void {
  for (const s of collectStringValues(submitted)) {
    if (s.length < 4) continue;
    if (errorBody.includes(s)) {
      throw new Error(`error body echoes submitted string (${s.length} chars): ${errorBody}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Stage 6: a browser-shaped client for the console.

/** Minimal cookie jar: keeps the latest value per cookie name, drops cleared ones. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();
  /** Client address presented to the app (rate limits key on it). */
  remoteAddress: string;
  /** Extra headers on every request, e.g. X-Forwarded-For behind IWIK_TRUST_PROXY. */
  headers: Record<string, string>;

  constructor(remoteAddress = '127.0.0.1', headers: Record<string, string> = {}) {
    this.remoteAddress = remoteAddress;
    this.headers = headers;
  }

  absorb(res: LightMyRequestResponse): void {
    const raw = res.headers['set-cookie'];
    const list = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
    for (const line of list) {
      const first = line.split(';')[0] ?? '';
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq);
      const value = first.slice(eq + 1);
      if (value === '' || /Max-Age=0|Expires=Thu, 01 Jan 1970/.test(line)) {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  header(): Record<string, string> {
    if (this.cookies.size === 0) return { ...this.headers };
    return {
      ...this.headers,
      cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    };
  }

  /** The CSRF nonce the app expects in `_csrf` (the signed cookie's first segment). */
  csrf(): string | undefined {
    return this.get('iwik_csrf')?.split('.')[0];
  }
}

export async function browse(
  t: TestApp,
  jar: CookieJar,
  url: string,
  options: Partial<InjectOptions> = {},
): Promise<LightMyRequestResponse> {
  const res = await t.app.inject({
    method: 'GET',
    url,
    remoteAddress: jar.remoteAddress,
    ...options,
    headers: { ...jar.header(), ...(options.headers as Record<string, string> | undefined) },
  } as InjectOptions);
  jar.absorb(res);
  return res;
}

/** POST a form the way a rendered page would: cookies plus the hidden `_csrf`. */
export async function postForm(
  t: TestApp,
  jar: CookieJar,
  url: string,
  fields: Record<string, string>,
  options: { csrf?: string | null } = {},
): Promise<LightMyRequestResponse> {
  if (jar.csrf() === undefined && options.csrf === undefined) await browse(t, jar, '/');
  const body = new URLSearchParams(fields);
  const csrf = options.csrf === undefined ? jar.csrf() : options.csrf;
  if (csrf !== null && csrf !== undefined) body.set('_csrf', csrf);
  const res = await t.app.inject({
    method: 'POST',
    url,
    remoteAddress: jar.remoteAddress,
    headers: { ...jar.header(), 'content-type': 'application/x-www-form-urlencoded' },
    payload: body.toString(),
  });
  jar.absorb(res);
  return res;
}

/** Operator bootstrap: create an organization and return its one-time invite path. */
export async function createInvite(
  t: TestApp,
  name: string,
  operatorToken: string = OPERATOR_TOKEN,
): Promise<{ org_id: string; invite_url: string; invite_path: string }> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/organizations',
    headers: authHeader(operatorToken),
    payload: { name },
  });
  if (res.statusCode !== 201) throw new Error(`invite failed: ${res.statusCode} ${res.body}`);
  const body = res.json<{ org_id: string; invite_url: string }>();
  const path = body.invite_url.replace(/^https?:\/\/[^/]+/, '');
  return { ...body, invite_path: path };
}

/** Stage 11 operator re-invite: the raw response, so callers can assert on 401/404/409. */
export async function reinvite(
  t: TestApp,
  orgId: string,
  operatorToken: string = OPERATOR_TOKEN,
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: `/v1/admin/organizations/${orgId}/invites`,
    headers: authHeader(operatorToken),
  });
}

/** Re-invite an existing organization and return its one-time invite path. */
export async function createResetInvite(
  t: TestApp,
  orgId: string,
): Promise<{ org_id: string; kind: 'enroll' | 'reset'; invite_url: string; invite_path: string }> {
  const res = await reinvite(t, orgId);
  if (res.statusCode !== 201) throw new Error(`re-invite failed: ${res.statusCode} ${res.body}`);
  const body = res.json<{ org_id: string; kind: 'enroll' | 'reset'; invite_url: string }>();
  const path = body.invite_url.replace(/^https?:\/\/[^/]+/, '');
  return { ...body, invite_path: path };
}

/** Accept a reset invite: new password (and the clauses, harmless when not asked); leaves the jar signed in. */
export async function resetPassword(
  t: TestApp,
  jar: CookieJar,
  invitePath: string,
  password: string,
): Promise<LightMyRequestResponse> {
  const page = await browse(t, jar, invitePath);
  if (page.statusCode !== 200) throw new Error(`reset page: ${page.statusCode}`);
  return postForm(t, jar, invitePath, {
    password,
    password_confirm: password,
    agree_terms: 'on',
    agree_trust_boundary: 'on',
    agree_reciprocity: 'on',
  });
}

export interface EnrolledOrg {
  jar: CookieJar;
  org_id: string;
  name: string;
  password: string;
}

/** Invite + accept: display name, password, every clause; leaves the jar signed in. */
export async function enrollOrganization(
  t: TestApp,
  name: string,
  password = 'correct horse battery staple ' + name,
  jar: CookieJar = new CookieJar(),
): Promise<EnrolledOrg> {
  const invite = await createInvite(t, name);
  const page = await browse(t, jar, invite.invite_path);
  if (page.statusCode !== 200) throw new Error(`enroll page: ${page.statusCode}`);
  const res = await postForm(t, jar, invite.invite_path, {
    display_name: name,
    password,
    password_confirm: password,
    agree_terms: 'on',
    agree_trust_boundary: 'on',
    agree_reciprocity: 'on',
  });
  if (res.statusCode !== 303 || !String(res.headers.location).startsWith('/org')) {
    throw new Error(`enroll failed: ${res.statusCode} ${res.headers.location ?? ''} ${res.body}`);
  }
  return { jar, org_id: invite.org_id, name, password };
}

export async function loginOrganization(
  t: TestApp,
  jar: CookieJar,
  organization: string,
  password: string,
): Promise<LightMyRequestResponse> {
  await browse(t, jar, '/console/login');
  return postForm(t, jar, '/console/login', { organization, password });
}

const NODE_ID_RE = /id="node-([0-9A-HJKMNP-TV-Z]{26})"/g;

/** Register a node from the console and return its id (the newest on the page). */
export async function registerNode(t: TestApp, org: EnrolledOrg, pubkey: string): Promise<string> {
  const res = await postForm(t, org.jar, '/org/nodes', { pubkey });
  if (res.statusCode !== 303 || res.headers.location !== '/org?notice=node_registered') {
    throw new Error(`register node: ${res.statusCode} ${res.headers.location ?? ''}`);
  }
  const page = await browse(t, org.jar, '/org');
  const ids = [...page.body.matchAll(NODE_ID_RE)].map((m) => m[1] as string);
  const id = ids[ids.length - 1];
  if (id === undefined) throw new Error('registered node not on the page');
  return id;
}

/** Issue a token from the console; the plaintext appears in that response only. */
export async function issueTokenViaConsole(
  t: TestApp,
  org: EnrolledOrg,
  nodeId: string,
  scopes: readonly Scope[],
): Promise<{ token: string; token_id: string; page: LightMyRequestResponse }> {
  const fields: Record<string, string> = {};
  for (const s of scopes) fields[`scope_${s}`] = 'on';
  const page = await postForm(t, org.jar, `/org/nodes/${nodeId}/tokens`, fields);
  if (page.statusCode !== 200) throw new Error(`issue token: ${page.statusCode} ${page.body}`);
  const token = /id="issued-token-value">([^<]+)</.exec(page.body)?.[1];
  const tokenId = /id="issued-token-id">([^<]+)</.exec(page.body)?.[1];
  if (token === undefined || tokenId === undefined) throw new Error('issued token not on page');
  return { token, token_id: tokenId, page };
}

/** A fully enrolled organization with one registered node and one token. */
export async function enrollWithNode(
  t: TestApp,
  name: string,
  scopes: readonly Scope[] = ['query', 'submit', 'publish'],
): Promise<EnrolledOrg & { node_id: string; key: NodeKey; token: string; token_id: string }> {
  const org = await enrollOrganization(t, name);
  const key = generateNodeKey();
  const node_id = await registerNode(t, org, key.pubkey);
  const issued = await issueTokenViaConsole(t, org, node_id, scopes);
  return { ...org, node_id, key, token: issued.token, token_id: issued.token_id };
}

// ---------------------------------------------------------------------------
// Stage 9: a fixture cohort. Organizations are created straight through the
// identity module (or enrolled through the console by the caller); every run
// goes through the real intake (preview, sign, submit), so digests, the
// index projection, and the contributions ledger are all real.

/** The env-seeded organization as an OrgWithNode (the seed node, key, and token). */
export async function seededOrg(t: TestApp): Promise<OrgWithNode> {
  const res = await t.app.iwik.pool.query<{ org_id: string; org_ref: string }>(
    `SELECT o.org_id, r.org_ref FROM identity.organizations o
       JOIN identity.org_refs r ON r.org_id = o.org_id WHERE o.name = $1`,
    [SEED_ORG],
  );
  const row = res.rows[0];
  if (row === undefined) throw new Error('seed organization missing');
  return { ...row, node_id: SEED_NODE_ID, key: t.nodeKey, token: t.token };
}

export interface SeededRun {
  /** Per-run ttft p50 in ms; p90/p95/p99 are +3/+4/+5, total_ms is +10 throughout. */
  ttft_p50: number;
  /** The `client_region` context value: one per scenario, so cohorts do not overlap. */
  region: string;
  /** Failed attempts out of `attempted` (default 20). */
  failed?: number;
  attempted?: number;
  retry_policy?: string;
  target_kind?: Run['target']['kind'];
  sharing_policy?: Run['submission']['sharing_policy'];
}

/** Patch the fixture into one seeded measurement (service target, distinct result, seeded latencies). */
export function seededRun(seed: SeededRun): (run: Run) => void {
  return (run) => {
    const attempted = seed.attempted ?? 20;
    const failed = seed.failed ?? 2;
    run.target = { kind: seed.target_kind ?? 'service', label_digest: 'sha256:' + 'a'.repeat(64) };
    run.submission = { ...run.submission, sharing_policy: seed.sharing_policy ?? 'cooperative' };
    for (const field of run.context) {
      if (field.key === 'client_region') field.value = seed.region;
      if (field.key === 'retry_policy' && seed.retry_policy !== undefined) {
        field.value = seed.retry_policy;
      }
    }
    run.accounting = {
      planned: attempted,
      attempted,
      succeeded: attempted - failed,
      failed,
      excluded: 0,
      unobserved: 0,
    };
    const p = seed.ttft_p50;
    run.result = {
      protocol_ref: run.protocol_ref,
      summary: {
        attempted,
        succeeded: attempted - failed,
        failed,
        error_rate: failed / attempted,
        ttft_ms: { p50: p, p90: p + 3, p95: p + 4, p99: p + 5 },
        total_ms: { p50: p + 10, p90: p + 13, p95: p + 14, p99: p + 15 },
        // Every seeded measurement is distinct (dedupe keys on the result).
        nonce: ulid(),
      },
    };
  };
}

/** Submit seeded runs as one organization through the real intake; returns the run ids in order. */
export async function contribute(
  t: TestApp,
  who: OrgWithNode,
  seeds: readonly SeededRun[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const seed of seeds) {
    const { res, run } = await submitFresh(t, who, seededRun(seed));
    if (res.statusCode !== 201) throw new Error(`contribute failed: ${res.statusCode} ${res.body}`);
    const receipt = res.json<{ status: string }>();
    if (receipt.status !== 'accepted') throw new Error(`contribute: receipt ${receipt.status}`);
    ids.push(run.run_id);
  }
  return ids;
}

export interface QueryBody {
  protocol_ref?: string;
  context_filters?: Record<string, unknown>;
  as_of_revision?: number;
  investigation_id?: string;
}

/** POST /v1/evidence/query as the given token; the raw response. */
export async function queryEvidence(
  t: TestApp,
  token: string,
  body: QueryBody,
): Promise<LightMyRequestResponse> {
  return t.app.inject({
    method: 'POST',
    url: '/v1/evidence/query',
    headers: authHeader(token),
    payload: { protocol_ref: 'inference-api/latency@1', ...body },
  });
}

export interface PrivacyExpectations {
  /** Strings that must appear nowhere in the receipt (other organizations' ids, refs, names). */
  forbidden: readonly string[];
  /** The caller's own ids: allowed under result.own_evidence only. */
  own?: readonly string[];
}

/** Keys whose values are counts of runs or organizations: bands on the wire, never numbers. */
const COUNT_KEYS = /^(n|runs|orgs|count|.*_count|.*_runs|.*_orgs)$/;

/**
 * Brief demonstration 5: nothing private in a released receipt. No foreign
 * run_id / node_id / org_ref / name anywhere; own ids only under
 * own_evidence; every count key a band; no exact integer between 2 and 10
 * outside own_evidence (the revision and the tail-claim minimum excepted).
 */
export function assertReceiptPrivate(
  receipt: Record<string, unknown>,
  expectations: PrivacyExpectations,
): void {
  const text = JSON.stringify(receipt);
  for (const s of expectations.forbidden) {
    if (text.includes(s)) throw new Error(`receipt carries a private string (${s.length} chars)`);
  }
  const outside: Record<string, unknown> = structuredClone(receipt);
  const result = outside['result'];
  if (typeof result === 'object' && result !== null) {
    delete (result as Record<string, unknown>)['own_evidence'];
  }
  delete outside['cohort'];
  const outsideText = JSON.stringify(outside);
  for (const s of expectations.own ?? []) {
    if (outsideText.includes(s)) throw new Error('own id appears outside own_evidence');
  }
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}/${i}`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        const here = `${path}/${key}`;
        // `minimum_runs` is the policy constant (20), not a count of anything.
        if (COUNT_KEYS.test(key) && key !== 'minimum_runs' && typeof v !== 'string') {
          throw new Error(`count at ${here} is not a band`);
        }
        walk(v, here);
      }
      return;
    }
    if (typeof value === 'number' && Number.isInteger(value) && value >= 2 && value <= 10) {
      if (path === '/evidence_revision' || path.endsWith('/minimum_runs')) return;
      throw new Error(`exact small count at ${path}`);
    }
  };
  walk(outside, '');
}
