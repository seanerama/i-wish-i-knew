// preview / submit / receipt against a small in-process mirror of the
// member-api intake: preview binds a content digest, submit requires a
// stored preview, verifies the Ed25519 signature with the node's public key,
// is idempotent, and rejects a tampered body with 409 preview_mismatch.
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Run } from '@iwik/contracts';
import { validate } from '@iwik/contracts';
import {
  ApiError,
  contentDigest,
  preview,
  receipt,
  run,
  RunnerError,
  signingPayload,
  submit,
  vaultPaths,
} from '../src/index.js';
import type { RunDraft } from '../src/index.js';
import {
  allow,
  cleanupTemp,
  makeHome,
  OPERATOR_CONTEXT,
  packsDir,
  readJson,
  startStub,
  TEST_TOKEN,
} from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

interface FakeService {
  server: Server;
  url: string;
  previews: Map<string, string>;
  runs: Map<string, { digest: string; receipt: Record<string, unknown> }>;
  receipts: Map<string, Record<string, unknown>>;
  pubkey: string;
  lastBody: unknown;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (text += c));
    req.on('end', () => resolve(text));
  });
}

function fakeService(): Promise<FakeService> {
  const protocol = readJson<Record<string, unknown>>(
    join(packsDir, 'inference-api', 'protocols', 'latency', 'protocol.json'),
  );
  const state: FakeService = {
    server: createServer(),
    url: '',
    previews: new Map(),
    runs: new Map(),
    receipts: new Map(),
    pubkey: '',
    lastBody: undefined,
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
    if (req.method === 'GET' && url.startsWith('/v1/protocols/')) return json(res, 200, protocol);
    if (req.method === 'GET' && url.startsWith('/v1/receipts/')) {
      const found = state.receipts.get(decodeURIComponent(url.slice('/v1/receipts/'.length)));
      return found ? json(res, 200, found) : error(res, 404, 'not_found');
    }
    const body = JSON.parse(await readBody(req)) as { run?: Run; preview_id?: string };
    state.lastBody = body;
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

let service: FakeService;
let stub: Awaited<ReturnType<typeof startStub>>;
let home: string;

before(async () => {
  service = await fakeService();
  stub = await startStub({ delayMs: 2, errorRate: 0, seed: 3 });
  const made = makeHome(service.url);
  home = made.home;
  service.pubkey = made.pubkey;
  allow(home, `127.0.0.1:${stub.port}`);
});

after(async () => {
  await stub.close();
  await new Promise<void>((resolve) => service.server.close(() => resolve()));
  cleanupTemp();
});

test('submit refuses without a stored preview', async () => {
  const r = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 2,
    targetKind: 'fixture',
    context: OPERATOR_CONTEXT,
  });
  await assert.rejects(
    submit(r.run_id, { home }),
    (e: unknown) => e instanceof RunnerError && e.code === 'preview_required' && e.exitCode === 6,
  );
  await assert.rejects(
    submit('01ARZ3NDEKTSV4RRFFQ69G5ZZZ', { home }),
    (e: unknown) => e instanceof RunnerError && e.code === 'run_not_found',
  );
  assert.equal(service.runs.size, 0);
});

test('preview strips vault-only fields, signs, stores preview.json and run.json; submit 201 then 200; tamper 409; receipt re-reads', async () => {
  const r = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 3,
    targetKind: 'fixture',
    context: OPERATOR_CONTEXT,
  });
  const p = await preview(r.run_id, { home });
  assert.match(p.preview_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(p.content_digest, contentDigest(p.body.run));
  assert.ok(!('label' in p.body.run.target), 'target.label is vault-only');
  assert.ok(!('org_ref' in p.body.run));
  assert.equal(p.body.run.submission.sharing_policy, 'private');
  assert.match(p.body.run.submission.key_id, /^ed25519:[0-9a-f]{16}$/);
  assert.equal(validate('Run', p.body.run).ok, true);
  const paths = vaultPaths(home, r.run_id);
  assert.ok(existsSync(paths.preview));
  assert.ok(existsSync(paths.run));
  assert.deepEqual(readJson<Run>(paths.run), p.body.run);
  // what was sent is exactly what is stored
  assert.deepEqual((service.lastBody as { run: Run }).run, p.body.run);

  const s1 = await submit(r.run_id, { home });
  assert.equal(s1.status, 201);
  assert.equal(s1.receipt['run_id'], r.run_id);
  assert.ok(existsSync(paths.receipt));
  const s2 = await submit(r.run_id, { home });
  assert.equal(s2.status, 200);
  assert.deepEqual(s2.receipt, s1.receipt);
  assert.deepEqual(readJson(paths.receipt), s1.receipt);

  // tamper with the stored signed run: the server sees a digest that is not the preview's
  const signed = readJson<Run>(paths.run);
  const field = signed.context.find((f) => f.key === 'client_region');
  assert.ok(field);
  field.value = 'eu-west-1';
  writeFileSync(paths.run, JSON.stringify(signed));
  await assert.rejects(
    submit(r.run_id, { home }),
    (e: unknown) => e instanceof ApiError && e.status === 409 && e.apiCode === 'preview_mismatch',
  );

  // a fresh preview of the (untampered) draft re-signs with the original
  // signed_at, so the digest and signature are identical and the resubmission
  // is still the idempotent 200, not a run_conflict
  const again = await preview(r.run_id, { home });
  assert.notEqual(again.preview_id, p.preview_id);
  assert.equal(again.content_digest, p.content_digest);
  assert.equal(again.body.run.submission.signature, p.body.run.submission.signature);
  const s3 = await submit(r.run_id, { home });
  assert.equal(s3.status, 200);
  assert.deepEqual(s3.receipt, s1.receipt);

  const got = await receipt(String(s1.receipt['receipt_id']), { home });
  assert.deepEqual(got, s1.receipt);
  await assert.rejects(
    receipt('01ARZ3NDEKTSV4RRFFQ69G5ZZZ', { home }),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  );
});

test('a secret injected into the draft is refused by preview with path and rule, never the value', async () => {
  const r = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    targetKind: 'fixture',
    context: OPERATOR_CONTEXT,
  });
  const paths = vaultPaths(home, r.run_id);
  const draft = readJson<RunDraft>(paths.draft);
  const index = draft.context.findIndex((f) => f.key === 'model.requested');
  const fakeKey = 'AKIA' + 'IOSFODNN7EXAMPLE';
  (draft.context[index] as RunDraft['context'][number]).value = `model ${fakeKey}`;
  writeFileSync(paths.draft, JSON.stringify(draft));
  await assert.rejects(preview(r.run_id, { home }), (e: unknown) => {
    assert.ok(e instanceof ApiError);
    assert.equal(e.status, 422);
    assert.equal(e.apiCode, 'validation_failed');
    assert.deepEqual(e.details, [{ path: `/context/${index}/value`, rule: 'secret_pattern' }]);
    assert.ok(!e.body.includes(fakeKey));
    assert.ok(!e.message.includes(fakeKey));
    return true;
  });
  assert.ok(!existsSync(paths.preview), 'a failed preview stores nothing');
  assert.ok(!existsSync(paths.run));
});

test('the sharing policy chosen at run time travels to the wire, and preview can override it', async () => {
  const r = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    targetKind: 'service',
    sharingPolicy: 'cooperative',
    context: OPERATOR_CONTEXT,
  });
  const p = await preview(r.run_id, { home });
  assert.equal(p.body.run.submission.sharing_policy, 'cooperative');
  const q = await preview(r.run_id, { home, sharingPolicy: 'private' });
  assert.equal(q.body.run.submission.sharing_policy, 'private');
  assert.notEqual(p.content_digest, q.content_digest);
  assert.equal(
    readFileSync(vaultPaths(home, r.run_id).run, 'utf8').includes('"cooperative"'),
    false,
  );
});
