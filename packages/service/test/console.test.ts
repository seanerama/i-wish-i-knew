// Console page: trust-boundary statement and evidence revision for anyone;
// accepted-run count and last receipt for a node signed in with its token
// (the stage-2 path, unchanged with enrollment off). Forms carry a CSRF
// token; the session cookie is a signed payload that never holds the token.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { TRUST_BOUNDARY_STATEMENT } from '../src/modules/console/index.js';
import { CookieJar, bootApp, browse, postForm, submitRun } from './helpers.js';
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
  assert.match(res.body, /name="_csrf"/);
  assert.match(res.body, /id="enrollment-state">disabled \(IWIK_FEATURE_ENROLLMENT=off\)</);
  assert.ok(!res.body.includes('id="accepted-runs"'));
  assert.ok(!res.body.includes('id="console-login-link"'));
  // the CSRF cookie is set on the first render
  assert.match(String(res.headers['set-cookie']), /^iwik_csrf=/);
});

test('signed-in node sees its organization run count and last receipt id', async () => {
  const { receipt } = await submitRun(t);
  const jar = new CookieJar();

  // without the CSRF field the form is refused
  await browse(t, jar, '/');
  const noCsrf = await postForm(t, jar, '/console/session', { token: t.token }, { csrf: null });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json<{ error: { code: string } }>().error.code, 'csrf_failed');

  const bad = await postForm(t, jar, '/console/session', { token: 'not-the-token' });
  assert.equal(bad.statusCode, 303);
  assert.equal(bad.headers.location, '/?login=failed');
  assert.ok(!String(bad.headers['set-cookie'] ?? '').includes('iwik_session='));
  const failed = await browse(t, jar, '/?login=failed');
  assert.match(failed.body, /id="login-error"/);

  const login = await postForm(t, jar, '/console/session', { token: t.token });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, '/');
  const setCookie = String(login.headers['set-cookie']);
  assert.match(setCookie, /^iwik_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  // the cookie carries a signed payload with the token hash, never the token itself
  assert.ok(!setCookie.includes(t.token));
  const cookieValue = jar.get('iwik_session');
  assert.ok(cookieValue);

  const page = await browse(t, jar, '/');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /id="org-name">Example Org</);
  assert.match(page.body, /id="node-id">01ARZ3NDEKTSV4RRFFQ69G5N0D</);
  assert.match(page.body, /id="accepted-runs">1</);
  assert.ok(page.body.includes(`id="last-receipt-id">${String(receipt['receipt_id'])}<`));
  assert.match(page.body, /id="evidence-revision">1</);
  // a node session does not unlock organization management
  assert.ok(!page.body.includes('id="org-link"'));

  // a forged (unsigned) cookie value is ignored
  const forged = await t.app.inject({
    method: 'GET',
    url: '/',
    headers: { cookie: `iwik_session=${'0'.repeat(64)}` },
  });
  assert.ok(!forged.body.includes('id="accepted-runs"'));
  // ... and so is a payload re-signed with the wrong key
  const [payload] = cookieValue.split('.');
  const resigned = await t.app.inject({
    method: 'GET',
    url: '/',
    headers: { cookie: `iwik_session=${payload}.${'A'.repeat(43)}` },
  });
  assert.ok(!resigned.body.includes('id="accepted-runs"'));

  const logout = await postForm(t, jar, '/console/logout', {});
  assert.equal(logout.statusCode, 303);
  assert.match(String(logout.headers['set-cookie']), /iwik_session=;/);
  assert.equal(jar.get('iwik_session'), undefined);
  const out = await browse(t, jar, '/');
  assert.ok(!out.body.includes('id="accepted-runs"'));
});
