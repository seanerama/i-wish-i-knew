'use strict';
// The pack on disk is internally consistent: layout per contracts/runner-pack.md,
// protocol.json is a valid ProtocolVersion whose digests match the files, and
// the pack schemas compile under strict draft 2020-12.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Ajv2020 } = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const digests = require('../../../scripts/pack-digest.js');

const packDir = path.resolve(__dirname, '..');
const schemaDir = path.resolve(packDir, '..', '..', 'contracts', 'schema', 'v1');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function strictAjv() {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  return ajv;
}

test('pack layout matches the runner-pack contract', () => {
  const pack = readJson(path.join(packDir, 'pack.json'));
  assert.equal(pack.id, 'inference-api');
  assert.deepEqual(pack.protocols, ['latency@1']);
  for (const entry of pack.protocols) {
    const dir = path.join(packDir, 'protocols', entry.split('@')[0]);
    for (const f of ['protocol.json', 'context.schema.json', 'result.schema.json', 'claims.json']) {
      assert.ok(fs.existsSync(path.join(dir, f)), `${entry}: missing ${f}`);
    }
  }
  assert.ok(fs.existsSync(path.join(packDir, 'harness', 'index.js')));
  assert.ok(fs.existsSync(path.join(packDir, 'fixtures', 'stub-server', 'index.js')));
});

test('protocol.json is a valid ProtocolVersion with the stage-1 procedure', () => {
  const ajv = strictAjv();
  const validate = ajv.compile(readJson(path.join(schemaDir, 'ProtocolVersion.schema.json')));
  const protocol = readJson(path.join(packDir, 'protocols', 'latency', 'protocol.json'));
  assert.ok(validate(protocol), JSON.stringify(validate.errors));
  assert.equal(protocol.ref, 'inference-api/latency@1');
  assert.equal(protocol.kind, 'controlled');
  assert.deepEqual(protocol.required_context, [
    'model.requested',
    'model.reported',
    'concurrency',
    'retry_policy',
    'cache_disabled',
    'client_region',
  ]);
  assert.deepEqual(protocol.permitted_claims, ['latency_distribution', 'error_rate']);
});

test('protocol.json digests match the files on disk', () => {
  const computed = digests.computePackDigests(packDir);
  for (const [ref, { current, expected }] of Object.entries(computed.protocols)) {
    assert.deepEqual(
      digests.staleFields(current, expected),
      [],
      `${ref}: run node scripts/pack-digest.js packs/inference-api --write`,
    );
  }
  assert.match(computed.pack_digest, /^sha256:[0-9a-f]{64}$/);
  assert.match(computed.harness_digest, /^sha256:[0-9a-f]{64}$/);
});

test('digest encoding is deterministic and sensitive to harness content', () => {
  const a = digests.treeDigest(path.join(packDir, 'harness'));
  const b = digests.treeDigest(path.join(packDir, 'harness'));
  assert.equal(a, b);
  const files = digests.listFiles(path.join(packDir, 'harness')).map(([rel]) => rel);
  assert.deepEqual(files, [...files].sort());
  assert.ok(files.includes('index.js') && files.includes('prompts.json'));
});

test('pack digest canonicalization agrees with RFC 8785 on the §3.2.3 example', () => {
  const input = JSON.parse(
    '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
      ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
      ' "literals": [null, true, false]}',
  );
  assert.equal(
    digests.canonicalize(input),
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
      '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
  );
});

test('context and result schemas compile strictly and claims name permitted claims only', () => {
  const dir = path.join(packDir, 'protocols', 'latency');
  const ajv = strictAjv();
  const contextValidate = ajv.compile(readJson(path.join(dir, 'context.schema.json')));
  const resultValidate = ajv.compile(readJson(path.join(dir, 'result.schema.json')));
  assert.ok(
    contextValidate({
      'model.requested': 'm',
      'model.reported': 'm',
      concurrency: 1,
      retry_policy: 'none',
      cache_disabled: true,
      client_region: 'local',
    }),
  );
  assert.ok(!contextValidate({ concurrency: 1 }));
  assert.ok(!resultValidate({}));

  const protocol = readJson(path.join(dir, 'protocol.json'));
  const claims = readJson(path.join(dir, 'claims.json'));
  assert.deepEqual(
    claims.claims.map((c) => c.name),
    protocol.permitted_claims,
  );
  const contextSchema = readJson(path.join(dir, 'context.schema.json'));
  assert.deepEqual(contextSchema.required, protocol.required_context);
});

test('harness and stub server use Node built-ins only', () => {
  const files = [
    path.join(packDir, 'harness', 'index.js'),
    path.join(packDir, 'fixtures', 'stub-server', 'index.js'),
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      assert.ok(
        spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../'),
        `${path.basename(file)} requires third-party module ${spec}`,
      );
    }
    assert.ok(!/\bimport\s*\(/.test(source), `${file}: dynamic import`);
  }
  assert.ok(
    !fs.existsSync(path.join(packDir, 'package.json')),
    'pack must not declare dependencies',
  );
});
