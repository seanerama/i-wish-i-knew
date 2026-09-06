// preview / submit / receipt against a small in-process mirror of the
// member-api intake: preview binds a content digest, submit requires a
// stored preview, verifies the Ed25519 signature with the node's public key,
// is idempotent, rejects a tampered body with 409 preview_mismatch, and
// `signed_at` is reused only while the unsigned body is unchanged.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  submit,
  vaultPaths,
} from '../src/index.js';
import type { RunDraft } from '../src/index.js';
import {
  allow,
  allowWithBudget,
  cleanupTemp,
  fakeService,
  FREE_PRICES,
  makeHome,
  OPERATOR_CONTEXT,
  readJson,
  startStub,
} from './helpers.js';
import type { FakeService } from './helpers.js';

const PROTOCOL = 'inference-api/latency@1';

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
  await service.close();
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
  assert.equal(again.body.run.submission.signed_at, p.body.run.submission.signed_at);
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

test('signed_at is refreshed when the unsigned body changes, and reused when it does not', async () => {
  const r = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    targetKind: 'fixture',
    context: OPERATOR_CONTEXT,
  });
  const first = await preview(r.run_id, { home });
  await new Promise((resolve) => setTimeout(resolve, 5));
  // unchanged draft, unchanged policy: same signed_at, same digest
  const same = await preview(r.run_id, { home });
  assert.equal(same.body.run.submission.signed_at, first.body.run.submission.signed_at);
  assert.equal(same.content_digest, first.content_digest);

  // the draft changes (an operator edits context in the vault): fresh signed_at
  const paths = vaultPaths(home, r.run_id);
  const draft = readJson<RunDraft>(paths.draft);
  const region = draft.context.find((f) => f.key === 'client_region');
  assert.ok(region);
  region.value = 'eu-west-1';
  writeFileSync(paths.draft, JSON.stringify(draft));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const changed = await preview(r.run_id, { home });
  assert.notEqual(changed.content_digest, first.content_digest);
  assert.ok(
    Date.parse(changed.body.run.submission.signed_at) >
      Date.parse(first.body.run.submission.signed_at),
    'a changed body is signed at a later time',
  );
  // and the new body then keeps its own signed_at
  const kept = await preview(r.run_id, { home });
  assert.equal(kept.body.run.submission.signed_at, changed.body.run.submission.signed_at);
  assert.equal(kept.content_digest, changed.content_digest);
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
  // a service target needs a cost estimate: zero prices make the stub free
  allowWithBudget(home, 0, `127.0.0.1:${stub.port}`);
  const r = await run({
    home,
    protocol: PROTOCOL,
    target: stub.url,
    planned: 1,
    targetKind: 'service',
    sharingPolicy: 'cooperative',
    prices: FREE_PRICES,
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
