// IWIK_TRUST_PROXY (stage 4, from the stage 6 review): production runs behind
// Coolify's traefik (ADR-0004) and the console login rate limit keys on the
// client IP, so `request.ip` must come from X-Forwarded-For there (hops = 1)
// and must NOT be spoofable where no proxy exists (hops = 0, the default).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { DATABASE_URL, TEST_KEK, resetDatabase } from './helpers.js';

const base = { DATABASE_URL, IWIK_KEK: '0'.repeat(64) };

test('IWIK_TRUST_PROXY parses as a hop count, default 0', () => {
  assert.equal(loadConfig(base).trustProxy, 0);
  assert.equal(loadConfig({ ...base, IWIK_TRUST_PROXY: '' }).trustProxy, 0);
  assert.equal(loadConfig({ ...base, IWIK_TRUST_PROXY: '0' }).trustProxy, 0);
  assert.equal(loadConfig({ ...base, IWIK_TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ ...base, IWIK_TRUST_PROXY: '2' }).trustProxy, 2);
  assert.throws(() => loadConfig({ ...base, IWIK_TRUST_PROXY: '-1' }), /IWIK_TRUST_PROXY/);
  assert.throws(() => loadConfig({ ...base, IWIK_TRUST_PROXY: '1.5' }), /IWIK_TRUST_PROXY/);
  assert.throws(() => loadConfig({ ...base, IWIK_TRUST_PROXY: 'yes' }), /IWIK_TRUST_PROXY/);
});

/** Boot the app with a probe route that reports what Fastify believes the client IP is. */
async function bootWithProbe(trustProxy: string | undefined): Promise<FastifyInstance> {
  await resetDatabase();
  const env: Record<string, string | undefined> = {
    NODE_ENV: 'test',
    DATABASE_URL,
    IWIK_KEK: TEST_KEK,
    IWIK_LOG_LEVEL: 'silent',
  };
  if (trustProxy !== undefined) env['IWIK_TRUST_PROXY'] = trustProxy;
  const app = await buildApp(loadConfig(env));
  app.get('/__test/ip', async (request) => ({ ip: request.ip }));
  await app.ready();
  return app;
}

async function observedIp(app: FastifyInstance, forwardedFor?: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/__test/ip',
    remoteAddress: '10.0.0.9',
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
  });
  assert.equal(res.statusCode, 200);
  return (res.json() as { ip: string }).ip;
}

test('IWIK_TRUST_PROXY=1: request.ip comes from X-Forwarded-For', async () => {
  const app = await bootWithProbe('1');
  try {
    assert.equal(await observedIp(app, '203.0.113.7'), '203.0.113.7');
    // One hop trusted: with two proxies listed, the address the trusted hop
    // saw (the last one) is the client, not the far-left, spoofable entry.
    assert.equal(await observedIp(app, '198.51.100.1, 203.0.113.7'), '203.0.113.7');
    assert.equal(await observedIp(app), '10.0.0.9');
  } finally {
    await app.close();
  }
});

test('IWIK_TRUST_PROXY=0 (and unset): X-Forwarded-For is ignored', async () => {
  for (const value of ['0', undefined]) {
    const app = await bootWithProbe(value);
    try {
      assert.equal(await observedIp(app, '203.0.113.7'), '10.0.0.9');
      assert.equal(await observedIp(app), '10.0.0.9');
    } finally {
      await app.close();
    }
  }
});
