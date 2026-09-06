// IWIK_FEATURE_INTAKE: default off in production, on elsewhere; when off,
// preview and submit answer 503 feature_disabled while /healthz and /readyz
// keep working and the console still renders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { authHeader, bootApp, loadFixtureRun, DATABASE_URL, SEED_NODE_ID } from './helpers.js';

test('flag default: off in production, on in development and test', () => {
  const base = { DATABASE_URL, IWIK_KEK: '0'.repeat(64) };
  assert.equal(loadConfig({ ...base, NODE_ENV: 'production' }).featureIntake, false);
  assert.equal(loadConfig({ ...base, NODE_ENV: 'development' }).featureIntake, true);
  assert.equal(loadConfig({ ...base, NODE_ENV: 'test' }).featureIntake, true);
  assert.equal(
    loadConfig({ ...base, NODE_ENV: 'production', IWIK_FEATURE_INTAKE: 'on' }).featureIntake,
    true,
  );
  assert.equal(
    loadConfig({ ...base, NODE_ENV: 'test', IWIK_FEATURE_INTAKE: 'off' }).featureIntake,
    false,
  );
  assert.throws(() => loadConfig({ ...base, IWIK_FEATURE_INTAKE: 'maybe' }), /on\/off/);
});

test('IWIK_FEATURE_INTAKE=off: POST /v1/runs and preview 503, /healthz 200', async () => {
  const t = await bootApp({ env: { IWIK_FEATURE_INTAKE: 'off' } });
  try {
    const run = { ...loadFixtureRun(), node_id: SEED_NODE_ID };
    const submit = await t.app.inject({
      method: 'POST',
      url: '/v1/runs',
      headers: authHeader(t.token),
      payload: { preview_id: '01ARZ3NDEKTSV4RRFFQ69G5PRV', run },
    });
    assert.equal(submit.statusCode, 503);
    assert.deepEqual(submit.json(), {
      error: { code: 'feature_disabled', message: 'this feature is disabled on this deployment' },
    });

    const preview = await t.app.inject({
      method: 'POST',
      url: '/v1/contributions/preview',
      headers: authHeader(t.token),
      payload: { run },
    });
    assert.equal(preview.statusCode, 503);
    assert.equal(preview.json<{ error: { code: string } }>().error.code, 'feature_disabled');

    // Disabled even before authentication, so an anonymous probe learns nothing else.
    const anon = await t.app.inject({ method: 'POST', url: '/v1/runs', payload: {} });
    assert.equal(anon.statusCode, 503);

    const health = await t.app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
    assert.deepEqual(health.json(), { ok: true });
    const ready = await t.app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(ready.statusCode, 200);

    // Reads and the console stay available.
    const protocols = await t.app.inject({
      method: 'GET',
      url: '/v1/protocols',
      headers: authHeader(t.token),
    });
    assert.equal(protocols.statusCode, 200);
    const page = await t.app.inject({ method: 'GET', url: '/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /disabled \(IWIK_FEATURE_INTAKE=off\)/);
  } finally {
    await t.app.close();
  }
});
