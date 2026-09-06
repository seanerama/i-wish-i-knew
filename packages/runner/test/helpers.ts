// Runner test scaffolding: a temporary IWIK_HOME per test file, pack copies
// that can be tampered with (digests rewritten or deliberately left stale),
// a stub target from the inference-api pack, and a small in-process mirror
// of the member-api (registry, whoami, preview, runs, receipts, and the
// stage 5 evidence/query stub) for preview/submit and MCP flows.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Run } from '@iwik/contracts';
import { computePackDigests, validate } from '@iwik/contracts';
import { contentDigest, init, savePolicy, signingPayload } from '../src/index.js';
import type { Policy } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');
export const packsDir = join(repoRoot, 'packs');
export const packDir = join(packsDir, 'inference-api');
export const cliPath = join(repoRoot, 'packages', 'runner', 'bin', 'iwik.cjs');
export const toolSchemaDir = join(repoRoot, 'contracts', 'schema', 'v1', 'tools');

export const NODE_ID = '01ARZ3NDEKTSV4RRFFQ69G5N0D';
export const TEST_TOKEN = 'test-only-node-token-' + 'b'.repeat(24);

const require = createRequire(import.meta.url);
interface StubHandle {
  url: string;
  port: number;
  host: string;
  stub: { stats: { errors: number; completions: number; requests: number } };
  close: () => Promise<void>;
}
const stubModule = require(join(packDir, 'fixtures', 'stub-server', 'index.js')) as {
  startStub: (options?: Record<string, unknown>) => Promise<StubHandle>;
};
export const startStub = stubModule.startStub;

/**
 * The stub as a separate process, for tests that drive the CLI with
 * spawnSync (which blocks this process's event loop, so an in-process stub
 * could not answer the harness).
 */
export function startStubProcess(
  args: string[] = [],
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(packDir, 'fixtures', 'stub-server', 'index.js'), '--port', '0', ...args],
      { stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let text = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      text += chunk;
      const nl = text.indexOf('\n');
      if (nl === -1) return;
      const { port } = JSON.parse(text.slice(0, nl)) as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
          }),
      });
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`stub exited early (${code})`)));
  });
}

const created: string[] = [];

export function tempDir(prefix = 'iwik-runner-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTemp(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface TestHome {
  home: string;
  pubkey: string;
  tokenFile: string;
}

/** A fresh home: initialised with a token file and node id, execution still denied. */
export function makeHome(serviceUrl = 'http://127.0.0.1:1'): TestHome {
  const base = tempDir();
  const tokenFile = join(base, 'token.txt');
  writeFileSync(tokenFile, TEST_TOKEN + '\n', { mode: 0o600 });
  const home = join(base, 'home');
  const result = init({ home, serviceUrl, tokenFile, nodeId: NODE_ID });
  return { home, pubkey: result.pubkey, tokenFile };
}

export function allow(home: string, ...targets: string[]): void {
  allowWithBudget(home, 0, ...targets);
}

export function allowWithBudget(home: string, budgetUsd: number, ...targets: string[]): void {
  const policy: Policy = {
    allow_execution: true,
    allowed_targets: targets,
    budget_per_plan_usd: budgetUsd,
    allow_disruptive: false,
  };
  savePolicy(home, policy);
}

/** Copy the inference-api pack into a temp packs dir; returns that packs dir. */
export function copyPack(): { packsDir: string; packDir: string } {
  const dir = tempDir('iwik-packs-');
  const dst = join(dir, 'inference-api');
  cpSync(packDir, dst, {
    recursive: true,
    filter: (src) => !src.includes(`${join(packDir, 'test')}`),
  });
  return { packsDir: dir, packDir: dst };
}

/** Rewrite every protocol.json digest field of a (modified) pack copy so it is self-consistent. */
export function rewriteDigests(dir: string): void {
  const digests = computePackDigests(dir);
  for (const { file, expected } of Object.values(digests.protocols)) {
    writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
  }
}

/** The real harness source with a snippet prepended (digests rewritten so the copy verifies). */
export function naughtyPack(prelude: string): { packsDir: string; packDir: string } {
  const copy = copyPack();
  const original = readFileSync(join(copy.packDir, 'harness', 'index.js'), 'utf8').replace(
    /^#!.*\n/,
    '',
  );
  writeFileSync(join(copy.packDir, 'harness', 'index.js'), prelude + original);
  rewriteDigests(copy.packDir);
  return copy;
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export const OPERATOR_CONTEXT = {
  'model.requested': 'stub-model',
  concurrency: 1,
  cache_disabled: true,
  client_region: 'local',
};

/** Prices that make a `service` target cost nothing under the latency cost model. */
export const FREE_PRICES = { usd_per_1m_prompt_tokens: 0, usd_per_1m_completion_tokens: 0 };

// ---------------------------------------------------------------------------
// A small in-process mirror of the member-api.

export interface FakeService {
  server: Server;
  url: string;
  previews: Map<string, string>;
  runs: Map<string, { digest: string; receipt: Record<string, unknown> }>;
  receipts: Map<string, Record<string, unknown>>;
  queries: unknown[];
  /** Stage 7: withdrawals recorded, keyed by the sorted run id set. */
  withdrawals: Map<
    string,
    { withdrawal_id: string; effective_revision: number; reason_code: string }
  >;
  /** Stage 7: when false the withdrawal endpoint answers 404 feature_disabled. */
  withdrawalEnabled: boolean;
  pubkey: string;
  lastBody: unknown;
  close: () => Promise<void>;
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (text += c));
    req.on('end', () => resolve(text));
  });
}

export function fakeService(): Promise<FakeService> {
  const protocol = readJson<Record<string, unknown>>(
    join(packsDir, 'inference-api', 'protocols', 'latency', 'protocol.json'),
  );
  const state: FakeService = {
    server: createServer(),
    url: '',
    previews: new Map(),
    runs: new Map(),
    receipts: new Map(),
    queries: [],
    withdrawals: new Map(),
    withdrawalEnabled: true,
    pubkey: '',
    lastBody: undefined,
    close: () => new Promise<void>((resolve) => state.server.close(() => resolve())),
  };
  let counter = 0;
  const id = (): string =>
    '01ARZ3NDEKTSV4RRFFQ69G5' +
    String(counter++)
      .padStart(3, '0')
      .replace(/[ILOU]/g, 'A');
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const error = (res: ServerResponse, status: number, code: string, details?: unknown[]): void =>
    json(res, status, { error: { code, message: code, ...(details ? { details } : {}) } });

  state.server.on('request', async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`)
      return error(res, 401, 'unauthorized');
    const url = req.url ?? '/';
    if (req.method === 'GET' && url === '/v1/whoami') {
      return json(res, 200, {
        node_id: NODE_ID,
        org_display_name: 'Fake Org',
        scopes: ['query', 'submit', 'publish'],
      });
    }
    if (req.method === 'GET' && url.startsWith('/v1/protocols/')) {
      return json(res, 200, { ...protocol, pack: { id: 'inference-api', version: '0.1.0' } });
    }
    if (req.method === 'GET' && url.startsWith('/v1/receipts/')) {
      const found = state.receipts.get(decodeURIComponent(url.slice('/v1/receipts/'.length)));
      return found ? json(res, 200, found) : error(res, 404, 'not_found');
    }
    const text = await readBody(req);
    let body: {
      run?: Run;
      preview_id?: string;
      protocol_ref?: string;
      context_filters?: unknown;
      run_ids?: unknown;
      reason_code?: unknown;
    };
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      return error(res, 400, 'bad_json');
    }
    state.lastBody = body;
    if (req.method === 'POST' && url === '/v1/withdrawals') {
      if (!state.withdrawalEnabled) return error(res, 404, 'feature_disabled');
      const ids = body.run_ids;
      const details: unknown[] = [];
      if (!Array.isArray(ids) || ids.length === 0)
        details.push({ path: '/run_ids', rule: 'minItems' });
      if (!['member_request', 'data_error', 'policy_change'].includes(String(body.reason_code)))
        details.push({ path: '/reason_code', rule: 'enum' });
      if (details.length > 0) return error(res, 422, 'validation_failed', details);
      const set = [...new Set(ids as string[])].sort();
      if (!set.every((id) => state.runs.has(id))) return error(res, 404, 'not_found');
      const key = set.join(',');
      const prior = state.withdrawals.get(key);
      if (prior !== undefined) {
        return json(res, 200, {
          withdrawal_id: prior.withdrawal_id,
          effective_revision: prior.effective_revision,
        });
      }
      const recorded = {
        withdrawal_id: id(),
        effective_revision: state.runs.size + state.withdrawals.size + 1,
        reason_code: String(body.reason_code),
      };
      state.withdrawals.set(key, recorded);
      return json(res, 201, {
        withdrawal_id: recorded.withdrawal_id,
        effective_revision: recorded.effective_revision,
      });
    }
    if (req.method === 'POST' && url === '/v1/evidence/query') {
      if (typeof body.protocol_ref !== 'string')
        return error(res, 422, 'validation_failed', [{ path: '/protocol_ref', rule: 'required' }]);
      state.queries.push(body);
      const receiptId = id();
      const receipt = {
        receipt_id: receiptId,
        query_digest: 'sha256:' + 'c'.repeat(64),
        status: 'insufficient_evidence',
        cohort: {
          protocol_ref: body.protocol_ref,
          filters: body.context_filters ?? {},
          orgs: '<3',
          runs: '<5',
        },
        calculation_version: 'no-cooperative-evidence/0',
        policy_version: 'pilot-disclosure/1',
        evidence_revision: state.runs.size,
        suppression_reasons: ['no_cooperative_evidence'],
        issued_at: new Date().toISOString(),
      };
      state.receipts.set(receiptId, { ...receipt, kind: 'query' });
      return json(res, 200, receipt);
    }
    const candidate = body.run;
    const validation = validate('Run', candidate);
    if (!validation.ok) return error(res, 422, 'validation_failed', validation.errors);
    const r = candidate as Run;
    if ('org_ref' in r)
      return error(res, 422, 'validation_failed', [{ path: '/org_ref', rule: 'server_assigned' }]);
    const leaky = JSON.stringify(r.context).includes('AKIA');
    if (leaky) {
      const index = r.context.findIndex((f) => String(f.value).includes('AKIA'));
      return error(res, 422, 'validation_failed', [
        { path: `/context/${index}/value`, rule: 'secret_pattern' },
      ]);
    }
    const digest = contentDigest(r);
    if (req.method === 'POST' && url === '/v1/contributions/preview') {
      const previewId = id();
      state.previews.set(previewId, digest);
      return json(res, 200, {
        preview_id: previewId,
        content_digest: digest,
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        validation: { ok: true },
        sanitization: { strings_checked: 1, rules: ['secret_pattern', 'string_too_long'] },
        would_store: {
          run_id: r.run_id,
          sharing_policy: r.target.kind === 'fixture' ? 'private' : r.submission.sharing_policy,
        },
      });
    }
    if (req.method === 'POST' && url === '/v1/runs') {
      if (typeof body.preview_id !== 'string')
        return error(res, 422, 'validation_failed', [{ path: '/preview_id', rule: 'required' }]);
      const bound = state.previews.get(body.preview_id);
      if (bound === undefined) return error(res, 404, 'preview_not_found');
      if (bound !== digest) return error(res, 409, 'preview_mismatch');
      const key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(state.pubkey, 'base64')]),
        format: 'der',
        type: 'spki',
      });
      const ok = verify(
        null,
        Buffer.from(signingPayload(r), 'utf8'),
        key,
        Buffer.from(r.submission.signature, 'base64'),
      );
      if (!ok) return error(res, 401, 'bad_signature');
      const prior = state.runs.get(r.run_id);
      if (prior !== undefined) {
        if (prior.digest === digest) return json(res, 200, prior.receipt);
        return error(res, 409, 'run_conflict');
      }
      const receiptId = id();
      const issued = {
        receipt_id: receiptId,
        kind: 'intake',
        status: 'accepted',
        run_id: r.run_id,
        content_digest: digest,
        evidence_revision: state.runs.size + 1,
      };
      state.runs.set(r.run_id, { digest, receipt: issued });
      state.receipts.set(receiptId, issued);
      return json(res, 201, issued);
    }
    return error(res, 404, 'not_found');
  });
  return new Promise((resolve) => {
    state.server.listen(0, '127.0.0.1', () => {
      const address = state.server.address();
      state.url = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
      resolve(state);
    });
  });
}
