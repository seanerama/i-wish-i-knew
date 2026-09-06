// Console page: trust-boundary statement and evidence revision for anyone;
// accepted-run count and last receipt for a node signed in with its token.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { TRUST_BOUNDARY_STATEMENT } from '../src/modules/console/index.js';
import { bootApp, submitRun } from './helpers.js';
import type { TestApp } from './helpers.js';

let t: TestApp;

before(async () => {
  t = await bootApp();
});

after(async () => {
  await t.app.close();
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

test('GET / renders the product, the ADR-0002 trust statement, and the evidence revision', async () => {
  const res = await t.app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] ?? '', /text\/html/);
  assert.match(res.body, /<h1>I Wish I Knew<\/h1>/);
  assert.ok(res.body.includes(escapeHtml(TRUST_BOUNDARY_STATEMENT)));
  assert.match(res.body, /operators are inside the trust boundary/);
  assert.match(res.body, /id="evidence-revision">0</);
  assert.match(res.body, /inference-api\/latency@1/);
  assert.match(res.body, /name="token"/);
  assert.ok(!res.body.includes('id="accepted-runs"'));
});

test('signed-in node sees its organization run count and last receipt id', async () => {
  const { receipt } = await submitRun(t);

  const bad = await t.app.inject({
    method: 'POST',
    url: '/console/session',
    payload: 'token=not-the-token',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(bad.statusCode, 303);
  assert.equal(bad.headers.location, '/?login=failed');
  assert.equal(bad.headers['set-cookie'], undefined);
  const failed = await t.app.inject({ method: 'GET', url: '/?login=failed' });
  assert.match(failed.body, /id="login-error"/);

  const login = await t.app.inject({
    method: 'POST',
    url: '/console/session',
    payload: `token=${encodeURIComponent(t.token)}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, '/');
  const setCookie = String(login.headers['set-cookie']);
  assert.match(setCookie, /^iwik_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  // the cookie carries a signed token hash, never the token itself
  assert.ok(!setCookie.includes(t.token));
  const cookieValue = setCookie.split(';')[0]?.split('=').slice(1).join('=') ?? '';

  const page = await t.app.inject({
    method: 'GET',
    url: '/',
    headers: { cookie: `iwik_session=${cookieValue}` },
  });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /id="org-name">Example Org</);
  assert.match(page.body, /id="accepted-runs">1</);
  assert.ok(page.body.includes(`id="last-receipt-id">${String(receipt['receipt_id'])}<`));
  assert.match(page.body, /id="evidence-revision">1</);

  // a forged (unsigned) cookie value is ignored
  const forged = await t.app.inject({
    method: 'GET',
    url: '/',
    headers: { cookie: `iwik_session=${'0'.repeat(64)}` },
  });
  assert.ok(!forged.body.includes('id="accepted-runs"'));

  const logout = await t.app.inject({
    method: 'POST',
    url: '/console/logout',
    headers: { cookie: `iwik_session=${cookieValue}` },
  });
  assert.equal(logout.statusCode, 303);
  assert.match(String(logout.headers['set-cookie']), /iwik_session=;/);
});
