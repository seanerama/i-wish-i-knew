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
import type { Scope } from '../src/modules/identity/index.js';
import { signingPayload } from '../src/modules/intake/index.js';

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

  constructor(remoteAddress = '127.0.0.1') {
    this.remoteAddress = remoteAddress;
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
    if (this.cookies.size === 0) return {};
    return { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
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
