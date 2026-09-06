// Shared test scaffolding: a fresh schema per boot (drop + migrate), an
// env-seeded organization and node with a generated Ed25519 key, and the
// conformance fixture patched to the live registry and signed.
import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import type { Run } from '@iwik/contracts';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { migrateUp } from '../src/migrate.js';
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
    IWIK_LOG_LEVEL: process.env['IWIK_LOG_LEVEL'] ?? 'silent',
    ...options.env,
  };
  const app = await buildApp(loadConfig(env));
  await app.ready();
  return { app, nodeKey, token: SEED_NODE_TOKEN };
}

export function loadFixtureRun(): Run {
  const file = resolve(repoRoot, 'contracts', 'fixtures', 'v1', 'run.valid.json');
  return JSON.parse(readFileSync(file, 'utf8')) as Run;
}

export function authHeader(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** The fixture with the live registry's digests and the seeded node id. */
export async function prepareRun(t: TestApp): Promise<Run> {
  const res = await t.app.inject({
    method: 'GET',
    url: '/v1/protocols/inference-api/latency@1',
    headers: authHeader(t.token),
  });
  if (res.statusCode !== 200) throw new Error(`registry lookup failed: ${res.statusCode}`);
  const protocol = res.json<{
    protocol_digest: string;
    harness_digest: string;
    result_schema_digest: string;
  }>();
  const run = loadFixtureRun();
  run.node_id = SEED_NODE_ID;
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

/** Preview, sign, submit; returns the receipt and the signed run. */
export async function submitRun(
  t: TestApp,
  run?: Run,
): Promise<{ receipt: Record<string, unknown>; run: Run; preview_id: string }> {
  const prepared = run ?? (await prepareRun(t));
  const p = await preview(t, prepared);
  if (p.statusCode !== 200) throw new Error(`preview failed: ${p.statusCode} ${p.body}`);
  const previewId = p.json<{ preview_id: string }>().preview_id;
  const signed = signRun(prepared, t.nodeKey);
  const s = await submit(t, previewId, signed);
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
