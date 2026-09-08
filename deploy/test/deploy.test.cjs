// Isolated orchestration tests: every external service command is a fake.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const image = 'ghcr.io/seanerama/i-wish-i-knew';
const oldRef = `v0.0.1@sha256:${'a'.repeat(64)}`;
const newRef = `v0.0.2@sha256:${'b'.repeat(64)}`;
const api = 'i-wish-i-knew';
const worker = `${api}-worker`;

function scenario(t, failure = '', options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'iwik-deploy-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const envfile = path.join(dir, 'env');
  const previous = options.first ? 'v0.0.0-placeholder' : options.legacy ? 'v0.0.1' : oldRef;
  const original = `IWIK_IMAGE_TAG=${previous}\nHOST=127.0.0.1\nPORT=3000\nDATABASE_URL=postgres://literal:$(touch NEVER_EXECUTE)@localhost/test\n`;
  fs.writeFileSync(envfile, original, { mode: 0o640 });
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      services: options.first
        ? {}
        : { [api]: previous, ...(!options.apiOnly && { [worker]: previous }) },
      events: [],
    }),
  );
  const fake = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_DIR;
const file = path.join(dir, 'state.json');
const s = JSON.parse(fs.readFileSync(file));
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
const failure = process.env.FAKE_FAILURE;
const ref = fs.readFileSync(path.join(dir, 'env'), 'utf8').match(/^IWIK_IMAGE_TAG=(.*)$/m)[1];
s.events.push({ command, args, ref });
let code = 0, output = '';
const image = ${JSON.stringify(image)};
const oldRef = ${JSON.stringify(oldRef)};
const newRef = ${JSON.stringify(newRef)};
if (command === 'docker') {
  if (args[0] === 'pull') { if (failure === 'pull') code = 1; }
  else if (args[0] === 'image') output = args[3] === '{{.Id}}' ? 'sha256:cached' : image + '@sha256:' + (args.at(-1).endsWith(':v0.0.1') ? 'a' : 'b').repeat(64);
  else if (args[0] === 'run') { if (failure === 'migration') code = 1; }
  else if (args[0] === 'inspect') {
    const unit = args.at(-1), current = s.services[unit];
    if (!current) code = 1;
    else if (args[2] === '{{.State.Running}} {{.Image}}') output = 'true sha256:' + (failure === 'legacy-drift' ? 'different' : 'cached');
    else if (args[2].startsWith('{{.State.Running}}')) output = 'true ' + image + ':' + current;
    else output = '/' + unit + ' running=true image=' + image + ':' + current + ' image_id=sha256:local';
  } else code = 90;
} else if (command === 'systemctl') {
  const unit = args.at(-1);
  if (args[0] === 'restart') {
    if ((ref === newRef && failure.startsWith('worker') && unit.endsWith('-worker')) ||
        (ref === newRef && failure === 'api' && !unit.endsWith('-worker')) ||
        (ref === oldRef && failure === 'worker-rollback' && unit.endsWith('-worker'))) {
      delete s.services[unit]; code = 1;
    } else s.services[unit] = failure === 'wrong-image' && ref === newRef && unit.endsWith('-worker') ? oldRef : ref;
  } else if (args[0] === 'stop') delete s.services[unit];
  else if (args[0] === 'is-active') { output = s.services[unit] ? 'active' : 'inactive'; code = s.services[unit] ? 0 : 3; }
  else code = 91;
} else if (command === 'curl') {
  const endpoint = args.at(-1);
  if (ref === newRef && ((failure === 'readyz' && endpoint.endsWith('/readyz')) ||
      (failure === 'healthz' && endpoint.endsWith('/healthz')))) code = 22;
  else if (ref === newRef && failure === 'bad-body') output = '{"ok":false}';
  else output = '{"ok":true}';
} else if (command !== 'sleep') code = 92;
fs.writeFileSync(file, JSON.stringify(s));
if (output) process.stdout.write(output + '\\n');
process.exit(code);
`;
  for (const name of ['docker', 'systemctl', 'curl', 'sleep']) {
    fs.writeFileSync(path.join(dir, name), fake, { mode: 0o755 });
  }
  if (options.duplicate) fs.appendFileSync(envfile, 'PORT=9999\n');
  const result = spawnSync(
    'bash',
    [path.resolve('deploy/staging/deploy.sh'), options.ref ?? 'v0.0.2', envfile],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FAKE_DIR: dir,
        FAKE_FAILURE: failure,
        IWIK_DEPLOY_VERIFY_ATTEMPTS: '1',
      },
    },
  );
  assert.ifError(result.error);
  assert.doesNotMatch(result.stdout + result.stderr, /NEVER_EXECUTE|postgres:\/\//);
  assert.equal(fs.existsSync(path.resolve('NEVER_EXECUTE')), false);
  return {
    ...result,
    original,
    env: fs.readFileSync(envfile, 'utf8'),
    state: JSON.parse(fs.readFileSync(path.join(dir, 'state.json'))),
    previous: fs.existsSync(`${envfile}.previous-image`)
      ? fs.readFileSync(`${envfile}.previous-image`, 'utf8').trim()
      : undefined,
    mode: fs.statSync(envfile).mode & 0o777,
  };
}

test('success migrates before pin, resolves one digest and restarts both', (t) => {
  const r = scenario(t);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.state.services, { [api]: newRef, [worker]: newRef });
  assert.equal(r.previous, oldRef);
  assert.equal(r.mode, 0o640);
  assert.equal(
    r.state.events.find((e) => e.command === 'docker' && e.args[0] === 'run').ref,
    oldRef,
  );
  assert.equal(
    r.state.events.filter((e) => e.command === 'docker' && e.args[0] === 'image').length,
    1,
  );
});

test('accepts the full release artifact reference without resolving a tag', (t) => {
  const r = scenario(t, '', { ref: `${image}:${newRef}` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.state.events.some((e) => e.command === 'docker' && e.args[0] === 'image'),
    false,
  );
});

for (const failure of ['pull', 'migration']) {
  test(`${failure} failure preserves config and running processes without restart`, (t) => {
    const r = scenario(t, failure);
    assert.equal(r.status, 1);
    assert.equal(r.env, r.original);
    assert.equal(r.previous, undefined);
    assert.deepEqual(r.state.services, { [api]: oldRef, [worker]: oldRef });
    assert.equal(
      r.state.events.some((e) => e.args[0] === 'restart'),
      false,
    );
    assert.match(r.stderr, /were not changed/);
  });
}
for (const failure of ['api', 'worker', 'readyz', 'healthz', 'bad-body', 'wrong-image']) {
  test(`${failure} failure restores and verifies both previous images, exits nonzero`, (t) => {
    const r = scenario(t, failure);
    assert.equal(r.status, 1);
    assert.equal(r.env, r.original);
    assert.deepEqual(r.state.services, { [api]: oldRef, [worker]: oldRef });
    assert.match(r.stderr, /paired rollback verified/);
    assert.equal(r.previous, oldRef);
  });
}
test('rollback failure reports incomplete recovery and actual remaining pair', (t) => {
  const r = scenario(t, 'worker-rollback');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ROLLBACK INCOMPLETE/);
  assert.doesNotMatch(r.stderr, /paired rollback verified/);
  assert.deepEqual(r.state.services, { [api]: oldRef });
  assert.match(r.stdout, /i-wish-i-knew-worker: inactive/);
});
test('first deployment adds both processes', (t) => {
  const r = scenario(t, '', { first: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.state.services, { [api]: newRef, [worker]: newRef });
  assert.equal(r.previous, '');
});
test('failed first deployment stops both and reports rollback unavailable', (t) => {
  const r = scenario(t, 'worker', { first: true });
  assert.equal(r.status, 1);
  assert.deepEqual(r.state.services, {});
  assert.equal(r.env, r.original);
  assert.match(r.stderr, /no previous release: rollback unavailable/);
  assert.doesNotMatch(r.stderr, /paired rollback verified/);
});
test('upgrade of a previous API-only release starts the existing worker entrypoint', (t) => {
  const r = scenario(t, '', { apiOnly: true });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.state.services, { [api]: newRef, [worker]: newRef });
});
test('duplicate environment keys and malformed image references fail before any service command', (t) => {
  for (const options of [{ duplicate: true }, { ref: 'v1@sha256:not-a-digest' }]) {
    const r = scenario(t, '', options);
    assert.equal(r.status, 1);
    assert.equal(r.state.events.length, 0);
  }
});

test('legacy tag pins cached digest for rollback only when running image IDs match', (t) => {
  const r = scenario(t, '', { legacy: true });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.previous, oldRef);
  const drift = scenario(t, 'legacy-drift', { legacy: true });
  assert.equal(drift.status, 1);
  assert.equal(drift.env, drift.original);
  assert.match(drift.stderr, /legacy tag cache differs/);
  assert.equal(
    drift.state.events.some((e) => e.args[0] === 'restart' || e.args[0] === 'pull'),
    false,
  );
});
