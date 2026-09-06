// Stage 6: identity and enrollment against a real PostgreSQL. Operator
// bootstrap, invite acceptance with recorded agreement, console login with
// rate limiting, node registration in both key formats, tokens shown once and
// stored hashed, two-organization isolation (404, never 403), revocation of
// tokens and nodes, the scope matrix, CSRF, audit hygiene, and the
// IWIK_FEATURE_ENROLLMENT kill switch. Stage 11: operator re-invite and the
// console password reset it unlocks, the per-IP login window, and CSRF nonce
// rotation on sign-in.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Run } from '@iwik/contracts';
import { loadConfig } from '../src/config.js';
import { PILOT_CLAUSES, PILOT_TERMS_VERSION } from '../src/modules/enrollment/index.js';
import { hashPassword, verifyPassword } from '../src/modules/identity/password.js';
import { FailureWindow } from '../src/modules/identity/ratelimit.js';
import {
  CookieJar,
  DATABASE_URL,
  OPERATOR_TOKEN,
  authHeader,
  bootEnrollmentApp,
  browse,
  createInvite,
  createResetInvite,
  enrollOrganization,
  enrollWithNode,
  generateNodeKey,
  issueTokenViaConsole,
  loginOrganization,
  postForm,
  prepareRun,
  preview,
  pubkeyPem,
  registerNode,
  reinvite,
  resetPassword,
  signRun,
  submit,
  submitRun,
} from './helpers.js';
import type { TestApp } from './helpers.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Pure units

test('password hashing: scrypt round trip, wrong password, malformed stored value', () => {
  const stored = hashPassword('correct horse battery staple');
  assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!stored.includes('correct horse'));
  assert.equal(verifyPassword('correct horse battery staple', stored), true);
  assert.equal(verifyPassword('correct horse battery stapl', stored), false);
  assert.equal(verifyPassword('anything', 'not-a-hash'), false);
  assert.equal(verifyPassword('anything', 'scrypt$1$1$1$AA==$AA=='), false);
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('login failure window: sixth attempt inside a minute is refused, others unaffected', () => {
  const w = new FailureWindow({ maxFailures: 5, windowMs: 60_000 });
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) {
    assert.equal(w.retryAfterSeconds('Org', '10.0.0.1', t0 + i * 1000), 0);
    w.recordFailure('Org', '10.0.0.1', t0 + i * 1000);
  }
  assert.ok(w.retryAfterSeconds('Org', '10.0.0.1', t0 + 5000) > 0);
  assert.equal(w.retryAfterSeconds('Org', '10.0.0.2', t0 + 5000), 0);
  assert.equal(w.retryAfterSeconds('Other', '10.0.0.1', t0 + 5000), 0);
  assert.equal(w.retryAfterSeconds('Org', '10.0.0.1', t0 + 61_000), 0);
  w.clear('Org', '10.0.0.1');
  assert.equal(w.retryAfterSeconds('Org', '10.0.0.1', t0 + 5000), 0);
});

test('flag default: IWIK_FEATURE_ENROLLMENT is off in every environment', () => {
  const base = { DATABASE_URL, IWIK_KEK: '0'.repeat(64) };
  assert.equal(loadConfig({ ...base, NODE_ENV: 'production' }).featureEnrollment, false);
  assert.equal(loadConfig({ ...base, NODE_ENV: 'development' }).featureEnrollment, false);
  assert.equal(loadConfig({ ...base, NODE_ENV: 'test' }).featureEnrollment, false);
  assert.equal(
    loadConfig({ ...base, NODE_ENV: 'production', IWIK_FEATURE_ENROLLMENT: 'on' })
      .featureEnrollment,
    true,
  );
  assert.equal(loadConfig(base).operatorTokenHash, undefined);
  assert.throws(() => loadConfig({ ...base, IWIK_OPERATOR_TOKEN: 'short' }), /16 characters/);
  assert.throws(() => loadConfig({ ...base, IWIK_PUBLIC_URL: 'example.org/x' }), /origin/);
  assert.equal(
    loadConfig({ ...base, IWIK_PUBLIC_URL: 'https://iwik.example/' }).publicUrl,
    'https://iwik.example',
  );
});

// ---------------------------------------------------------------------------
// Flag on

let t: TestApp;

before(async () => {
  t = await bootEnrollmentApp();
});

after(async () => {
  await t.app.close();
});

test('operator bootstrap: only the operator token creates an organization and a one-time invite', async () => {
  const anon = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/organizations',
    payload: { name: 'Nope' },
  });
  assert.equal(anon.statusCode, 401);
  const wrong = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/organizations',
    headers: authHeader(OPERATOR_TOKEN.slice(0, -1) + 'x'),
    payload: { name: 'Nope' },
  });
  assert.equal(wrong.statusCode, 401);
  // a node token, even with every scope, is not the operator
  const node = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/organizations',
    headers: authHeader(t.token),
    payload: { name: 'Nope' },
  });
  assert.equal(node.statusCode, 401);

  const bad = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/organizations',
    headers: authHeader(OPERATOR_TOKEN),
    payload: { name: 'x' },
  });
  assert.equal(bad.statusCode, 422);
  assert.deepEqual(bad.json<{ error: { details: unknown } }>().error.details, [
    { path: '/name', rule: 'format' },
  ]);

  const invite = await createInvite(t, 'Bootstrap Org');
  assert.match(invite.org_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(invite.invite_path, /^\/enroll\/[A-Za-z0-9_-]{43}$/);
  const inviteToken = invite.invite_path.slice('/enroll/'.length);
  const rows = await t.app.iwik.pool.query<{ invite_hash: string; accepted_at: Date | null }>(
    `SELECT invite_hash, accepted_at FROM identity.invites WHERE org_id = $1`,
    [invite.org_id],
  );
  assert.equal(rows.rows.length, 1);
  assert.notEqual(rows.rows[0]?.invite_hash, inviteToken);
  assert.match(rows.rows[0]?.invite_hash ?? '', /^[0-9a-f]{64}$/);
  assert.equal(rows.rows[0]?.accepted_at, null);

  const dup = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/organizations',
    headers: authHeader(OPERATOR_TOKEN),
    payload: { name: 'Bootstrap Org' },
  });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json<{ error: { code: string } }>().error.code, 'name_taken');
  assert.ok(!dup.body.includes('Bootstrap Org'));

  const audit = await t.app.iwik.pool.query<{ event: string; actor: string; target: string }>(
    `SELECT event, actor, target FROM identity.audit WHERE target = $1`,
    [`org:${invite.org_id}`],
  );
  assert.deepEqual(audit.rows, [
    { event: 'org.invited', actor: 'operator', target: `org:${invite.org_id}` },
  ]);
});

test('enrollment: invite page shows the terms, rejects incomplete forms, records the agreement, consumes the invite', async () => {
  const jar = new CookieJar();
  const unknown = await browse(t, jar, '/enroll/not-a-real-invite-value-0000000000');
  assert.equal(unknown.statusCode, 404);
  assert.match(unknown.body, /id="message-title">Invite not found</);

  const invite = await createInvite(t, 'Terms Org');
  const page = await browse(t, jar, invite.invite_path);
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes(`id="terms-version">${PILOT_TERMS_VERSION}<`));
  assert.ok(page.body.includes(escapeHtml(PILOT_CLAUSES.trust_boundary)));
  assert.ok(page.body.includes(escapeHtml(PILOT_CLAUSES.reciprocity)));
  assert.match(page.body, /name="agree_terms"/);
  assert.match(page.body, /name="agree_trust_boundary"/);
  assert.match(page.body, /name="agree_reciprocity"/);
  assert.match(page.body, /value="Terms Org"/);

  const password = 'a long enough console password';
  const base = {
    display_name: 'Terms Org Renamed',
    password,
    password_confirm: password,
    agree_terms: 'on',
    agree_trust_boundary: 'on',
    agree_reciprocity: 'on',
  };
  const missing = await postForm(t, jar, invite.invite_path, { ...base, agree_reciprocity: '' });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body, /id="enroll-error"/);
  assert.ok(!missing.body.includes(password));
  const short = await postForm(t, jar, invite.invite_path, {
    ...base,
    password: 'short',
    password_confirm: 'short',
  });
  assert.equal(short.statusCode, 400);
  const mismatch = await postForm(t, jar, invite.invite_path, {
    ...base,
    password_confirm: password + '!',
  });
  assert.equal(mismatch.statusCode, 400);
  const taken = await postForm(t, jar, invite.invite_path, {
    ...base,
    display_name: 'Bootstrap Org',
  });
  assert.equal(taken.statusCode, 400);
  assert.match(taken.body, /already in use/);
  const noCsrf = await postForm(t, jar, invite.invite_path, base, { csrf: null });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(noCsrf.json<{ error: { code: string } }>().error.code, 'csrf_failed');

  // still open after every rejected attempt
  const stillOpen = await t.app.iwik.pool.query(
    `SELECT 1 FROM identity.invites WHERE org_id = $1 AND accepted_at IS NULL`,
    [invite.org_id],
  );
  assert.equal(stillOpen.rows.length, 1);

  const ok = await postForm(t, jar, invite.invite_path, base);
  assert.equal(ok.statusCode, 303, ok.body);
  assert.equal(ok.headers.location, '/org?notice=enrolled');
  const setCookie = String(ok.headers['set-cookie']);
  assert.match(setCookie, /iwik_session=/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.ok(!setCookie.includes(password));

  const org = await browse(t, jar, String(ok.headers.location));
  assert.equal(org.statusCode, 200);
  assert.match(org.body, /id="org-name">Terms Org Renamed</);
  assert.match(org.body, /id="notice">/);
  assert.match(org.body, /Enrollment complete/);
  assert.match(org.body, /id="no-nodes"/);
  assert.match(org.body, /iwik init --service/);
  assert.match(org.body, /base64 raw key/);
  assert.match(org.body, /PEM SPKI block/);

  // invite consumed: the page and a second acceptance are gone
  const again = await browse(t, new CookieJar(), invite.invite_path);
  assert.equal(again.statusCode, 404);
  const reuse = await postForm(t, new CookieJar(), invite.invite_path, base);
  assert.equal(reuse.statusCode, 404);

  const { pool } = t.app.iwik;
  const agreement = await pool.query<{
    terms_version: string;
    clauses: string[];
    accepted_at: Date;
  }>(`SELECT terms_version, clauses, accepted_at FROM identity.agreements WHERE org_id = $1`, [
    invite.org_id,
  ]);
  assert.equal(agreement.rows.length, 1);
  assert.equal(agreement.rows[0]?.terms_version, PILOT_TERMS_VERSION);
  assert.deepEqual(agreement.rows[0]?.clauses, ['terms', 'trust_boundary', 'reciprocity']);
  assert.ok(Date.now() - (agreement.rows[0]?.accepted_at.getTime() ?? 0) < 60_000);
  const login = await pool.query<{ password_hash: string }>(
    `SELECT password_hash FROM identity.console_logins WHERE org_id = $1`,
    [invite.org_id],
  );
  assert.match(login.rows[0]?.password_hash ?? '', /^scrypt\$/);
  assert.ok(!(login.rows[0]?.password_hash ?? '').includes(password));
  const renamed = await pool.query<{ name: string; enrolled_at: Date | null }>(
    `SELECT name, enrolled_at FROM identity.organizations WHERE org_id = $1`,
    [invite.org_id],
  );
  assert.equal(renamed.rows[0]?.name, 'Terms Org Renamed');
  assert.ok(renamed.rows[0]?.enrolled_at);

  // the landing page reflects the org session and links to /org
  const home = await browse(t, jar, '/');
  assert.match(home.body, /id="org-name">Terms Org Renamed</);
  assert.match(home.body, /id="org-link"/);
  assert.match(home.body, /id="enrollment-state">enabled</);
  const anonHome = await browse(t, new CookieJar(), '/');
  assert.match(anonHome.body, /id="console-login-link"/);
});

test('console login: wrong password fails, right password lands on /org, 6th failure in a minute is 429', async () => {
  const org = await enrollOrganization(t, 'Login Org');
  const logout = await postForm(t, org.jar, '/console/logout', {});
  assert.equal(logout.statusCode, 303);
  const locked = await browse(t, org.jar, '/org');
  assert.equal(locked.statusCode, 303);
  assert.equal(locked.headers.location, '/console/login');

  const wrong = await loginOrganization(t, org.jar, org.name, 'not the password at all');
  assert.equal(wrong.statusCode, 303);
  assert.equal(wrong.headers.location, '/console/login?login=failed');
  assert.equal(org.jar.get('iwik_session'), undefined);
  const failedPage = await browse(t, org.jar, '/console/login?login=failed');
  assert.match(failedPage.body, /id="login-error"/);

  const noCsrf = await postForm(
    t,
    org.jar,
    '/console/login',
    { organization: org.name, password: org.password },
    { csrf: null },
  );
  assert.equal(noCsrf.statusCode, 403);

  const right = await loginOrganization(t, org.jar, org.name, org.password);
  assert.equal(right.statusCode, 303);
  assert.equal(right.headers.location, '/org');
  const page = await browse(t, org.jar, '/org');
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /id="org-name">Login Org</);

  // rate limit: per organization + client address
  const attacker = new CookieJar('203.0.113.7');
  for (let i = 1; i <= 5; i++) {
    const res = await loginOrganization(t, attacker, org.name, `guess number ${i}`);
    assert.equal(res.statusCode, 303, `attempt ${i}`);
    assert.equal(res.headers.location, '/console/login?login=failed');
  }
  const sixth = await loginOrganization(t, attacker, org.name, org.password);
  assert.equal(sixth.statusCode, 429);
  assert.equal(sixth.json<{ error: { code: string } }>().error.code, 'rate_limited');
  assert.match(String(sixth.headers['retry-after']), /^[1-9][0-9]?$/);
  assert.equal(attacker.get('iwik_session'), undefined);
  assert.ok(!sixth.body.includes(org.password) && !sixth.body.includes(org.name));

  // a different address is not blocked; the same address is blocked for every
  // organization name too (the stage 11 per-IP window has the same five failures)
  const elsewhere = new CookieJar('203.0.113.8');
  const other = await loginOrganization(t, elsewhere, org.name, 'still wrong');
  assert.equal(other.statusCode, 303);
  const otherOrg = new CookieJar('203.0.113.7');
  const unrelated = await loginOrganization(t, otherOrg, 'Bootstrap Org', 'still wrong');
  assert.equal(unrelated.statusCode, 429);
});

test('per-IP login window: five failures under different organization names from one address block the sixth', async () => {
  const org = await enrollOrganization(t, 'IP Bucket Org');
  const attacker = new CookieJar('203.0.113.40');
  for (let i = 1; i <= 5; i++) {
    const res = await loginOrganization(t, attacker, `Guess Org ${i}`, `guess number ${i}`);
    assert.equal(res.statusCode, 303, `attempt ${i}`);
    assert.equal(res.headers.location, '/console/login?login=failed');
  }
  const sixth = await loginOrganization(t, attacker, org.name, org.password);
  assert.equal(sixth.statusCode, 429);
  assert.equal(sixth.json<{ error: { code: string } }>().error.code, 'rate_limited');
  assert.match(String(sixth.headers['retry-after']), /^[1-9][0-9]?$/);
  assert.equal(attacker.get('iwik_session'), undefined);
  assert.ok(!sixth.body.includes(org.password) && !sixth.body.includes(org.name));
  // the per-organization window for that name is untouched: another address signs in
  const elsewhere = new CookieJar('203.0.113.41');
  const ok = await loginOrganization(t, elsewhere, org.name, org.password);
  assert.equal(ok.statusCode, 303);
  assert.equal(ok.headers.location, '/org');
});

test('csrf nonce rotates when a session is established: the pre-login nonce is refused afterwards', async () => {
  const org = await enrollOrganization(t, 'Rotate Org');

  // console password sign-in
  const jar = new CookieJar('203.0.113.42');
  await browse(t, jar, '/console/login');
  const before = jar.csrf();
  assert.ok(before);
  const login = await postForm(t, jar, '/console/login', {
    organization: org.name,
    password: org.password,
  });
  assert.equal(login.statusCode, 303);
  assert.equal(login.headers.location, '/org');
  assert.match(String(login.headers['set-cookie']), /iwik_csrf=/);
  const after = jar.csrf();
  assert.ok(after);
  assert.notEqual(after, before);
  const key = generateNodeKey();
  const stale = await postForm(t, jar, '/org/nodes', { pubkey: key.pubkey }, { csrf: before });
  assert.equal(stale.statusCode, 403);
  assert.equal(stale.json<{ error: { code: string } }>().error.code, 'csrf_failed');
  const current = await postForm(t, jar, '/org/nodes', { pubkey: key.pubkey });
  assert.equal(current.statusCode, 303);
  assert.equal(current.headers.location, '/org?notice=node_registered');

  // a failed sign-in does not rotate
  const failing = new CookieJar('203.0.113.43');
  await browse(t, failing, '/console/login');
  const unchanged = failing.csrf();
  const failed = await postForm(t, failing, '/console/login', {
    organization: org.name,
    password: 'not the password',
  });
  assert.equal(failed.headers.location, '/console/login?login=failed');
  assert.equal(failing.csrf(), unchanged);

  // enrollment establishes a session, so it rotates too
  const invite = await createInvite(t, 'Rotate Enroll Org');
  const enrolling = new CookieJar('203.0.113.44');
  await browse(t, enrolling, invite.invite_path);
  const preEnroll = enrolling.csrf();
  const password = 'rotate enroll org password';
  const enrolled = await postForm(t, enrolling, invite.invite_path, {
    display_name: 'Rotate Enroll Org',
    password,
    password_confirm: password,
    agree_terms: 'on',
    agree_trust_boundary: 'on',
    agree_reciprocity: 'on',
  });
  assert.equal(enrolled.headers.location, '/org?notice=enrolled');
  assert.notEqual(enrolling.csrf(), preEnroll);

  // and so does the stage-2 node-token sign-in on /
  const node = new CookieJar('203.0.113.45');
  await browse(t, node, '/');
  const preNode = node.csrf();
  const signedIn = await postForm(t, node, '/console/session', { token: t.token });
  assert.equal(signedIn.headers.location, '/');
  assert.notEqual(node.csrf(), preNode);
});

test('reset invite: new console password, old one fails, nodes and tokens intact, one organization row', async () => {
  const { pool } = t.app.iwik;
  const org = await enrollWithNode(t, 'Reset Org');
  const tokenStatus = async () =>
    (await t.app.inject({ method: 'GET', url: '/v1/protocols', headers: authHeader(org.token) }))
      .statusCode;
  assert.equal(await tokenStatus(), 200);

  // only the operator token, only for a known organization
  const anon = await t.app.inject({
    method: 'POST',
    url: `/v1/admin/organizations/${org.org_id}/invites`,
  });
  assert.equal(anon.statusCode, 401);
  assert.equal((await reinvite(t, org.org_id, org.token)).statusCode, 401);
  const unknown = await reinvite(t, '01ARZ3NDEKTSV4RRFFQ69G5ZZZ');
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json<{ error: { code: string } }>().error.code, 'not_found');
  assert.equal((await reinvite(t, 'not-an-organization-id')).statusCode, 404);

  const invite = await createResetInvite(t, org.org_id);
  assert.equal(invite.kind, 'reset');
  assert.equal(invite.org_id, org.org_id);
  assert.match(invite.invite_path, /^\/enroll\/[A-Za-z0-9_-]{43}$/);
  // a second unexpired reset invite is refused, without echoing anything
  const dup = await reinvite(t, org.org_id);
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json<{ error: { code: string } }>().error.code, 'invite_exists');
  assert.ok(!dup.body.includes(org.name));
  const invites = await pool.query<{ kind: string; accepted: boolean; invite_hash: string }>(
    `SELECT kind, accepted_at IS NOT NULL AS accepted, invite_hash FROM identity.invites
      WHERE org_id = $1 ORDER BY created_at, invite_hash`,
    [org.org_id],
  );
  assert.deepEqual(
    invites.rows.map((r) => [r.kind, r.accepted]),
    [
      ['enroll', true],
      ['reset', false],
    ],
  );
  const inviteToken = invite.invite_path.slice('/enroll/'.length);
  for (const r of invites.rows) assert.notEqual(r.invite_hash, inviteToken);

  // the page: name read-only, no display-name field, terms unchanged so no checkboxes
  const jar = new CookieJar('203.0.113.31');
  const page = await browse(t, jar, invite.invite_path);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /id="reset-form"/);
  assert.match(page.body, /id="display-name">Reset Org</);
  assert.ok(!page.body.includes('name="display_name"'));
  assert.ok(!page.body.includes('name="agree_terms"'));
  assert.match(page.body, /id="terms-unchanged"/);
  assert.ok(page.body.includes(`id="terms-version">${PILOT_TERMS_VERSION}<`));
  assert.match(page.body, /autocomplete="new-password"/);
  assert.match(page.body, /reset invite/);

  // rejected forms leave the invite open and echo nothing
  const newPassword = 'a brand new console password';
  const short = await postForm(t, jar, invite.invite_path, {
    password: 'short',
    password_confirm: 'short',
  });
  assert.equal(short.statusCode, 400);
  assert.match(short.body, /id="enroll-error"/);
  const mismatch = await postForm(t, jar, invite.invite_path, {
    password: newPassword,
    password_confirm: newPassword + '!',
  });
  assert.equal(mismatch.statusCode, 400);
  assert.ok(!mismatch.body.includes(newPassword));
  const noCsrf = await postForm(
    t,
    jar,
    invite.invite_path,
    { password: newPassword, password_confirm: newPassword },
    { csrf: null },
  );
  assert.equal(noCsrf.statusCode, 403);
  const stillOpen = await pool.query(
    `SELECT 1 FROM identity.invites WHERE org_id = $1 AND kind = 'reset' AND accepted_at IS NULL`,
    [org.org_id],
  );
  assert.equal(stillOpen.rows.length, 1);

  // accept; a submitted display name is not a field on a reset and is ignored
  const ok = await postForm(t, jar, invite.invite_path, {
    display_name: 'Renamed By Reset',
    password: newPassword,
    password_confirm: newPassword,
  });
  assert.equal(ok.statusCode, 303, ok.body);
  assert.equal(ok.headers.location, '/org?notice=password_reset');
  assert.match(String(ok.headers['set-cookie']), /iwik_session=/);
  assert.ok(!String(ok.headers['set-cookie']).includes(newPassword));
  const landed = await browse(t, jar, String(ok.headers.location));
  assert.equal(landed.statusCode, 200);
  assert.match(landed.body, /id="org-name">Reset Org</);
  assert.match(landed.body, /id="notice">/);
  assert.match(landed.body, /Console password set/);
  assert.ok(landed.body.includes(`id="node-${org.node_id}"`));
  assert.ok(landed.body.includes(`id="token-${org.token_id}"`));
  assert.ok(!landed.body.includes(org.token));

  // the invite is consumed
  assert.equal((await browse(t, new CookieJar(), invite.invite_path)).statusCode, 404);
  const reuse = await postForm(t, new CookieJar(), invite.invite_path, {
    password: newPassword,
    password_confirm: newPassword,
  });
  assert.equal(reuse.statusCode, 404);

  // the session signed in with the old login is over; the old password fails; the new one works
  const stale = await browse(t, org.jar, '/org');
  assert.equal(stale.statusCode, 303);
  assert.equal(stale.headers.location, '/console/login');
  const oldPassword = await loginOrganization(
    t,
    new CookieJar('203.0.113.32'),
    org.name,
    org.password,
  );
  assert.equal(oldPassword.headers.location, '/console/login?login=failed');
  const fresh = new CookieJar('203.0.113.33');
  const newLogin = await loginOrganization(t, fresh, org.name, newPassword);
  assert.equal(newLogin.statusCode, 303);
  assert.equal(newLogin.headers.location, '/org');

  // nothing else moved: one organization row, the node and its token, one agreement
  assert.equal(await tokenStatus(), 200);
  const orgs = await pool.query(`SELECT 1 FROM identity.organizations WHERE name = $1`, [org.name]);
  assert.equal(orgs.rows.length, 1);
  const nodes = await pool.query<{ node_id: string; revoked: boolean }>(
    `SELECT node_id, revoked_at IS NOT NULL AS revoked FROM identity.nodes WHERE org_id = $1`,
    [org.org_id],
  );
  assert.deepEqual(nodes.rows, [{ node_id: org.node_id, revoked: false }]);
  const tokens = await pool.query<{ token_id: string; revoked: boolean }>(
    `SELECT t.token_id, t.revoked_at IS NOT NULL AS revoked FROM identity.tokens t
       JOIN identity.nodes n USING (node_id) WHERE n.org_id = $1`,
    [org.org_id],
  );
  assert.deepEqual(tokens.rows, [{ token_id: org.token_id, revoked: false }]);
  const logins = await pool.query<{ revoked: boolean; password_hash: string }>(
    `SELECT revoked_at IS NOT NULL AS revoked, password_hash FROM identity.console_logins
      WHERE org_id = $1 ORDER BY created_at, login_id`,
    [org.org_id],
  );
  assert.deepEqual(
    logins.rows.map((l) => l.revoked),
    [true, false],
  );
  assert.notEqual(logins.rows[0]?.password_hash, logins.rows[1]?.password_hash);
  for (const l of logins.rows) {
    assert.match(l.password_hash, /^scrypt\$/);
    assert.ok(!l.password_hash.includes(newPassword));
  }
  const agreements = await pool.query(`SELECT 1 FROM identity.agreements WHERE org_id = $1`, [
    org.org_id,
  ]);
  assert.equal(agreements.rows.length, 1);

  // audit: identifiers only
  const audit = await t.app.iwik.pool.query<{ event: string; actor: string; target: string }>(
    `SELECT event, actor, target FROM identity.audit WHERE target = $1 ORDER BY at, audit_id`,
    [`org:${org.org_id}`],
  );
  const events = audit.rows.map((r) => r.event);
  assert.ok(events.includes('org.reinvited'));
  assert.ok(events.includes('console.password_reset'));
  const reinvited = audit.rows.find((r) => r.event === 'org.reinvited');
  assert.equal(reinvited?.actor, 'operator');
  const reset = audit.rows.find((r) => r.event === 'console.password_reset');
  assert.match(reset?.actor ?? '', /^login:[0-9A-HJKMNP-TV-Z]{26}$/);
  const text = JSON.stringify(audit.rows);
  for (const forbidden of [org.password, newPassword, org.token, inviteToken]) {
    assert.ok(!text.includes(forbidden));
  }

  // consumed, so the operator can issue the next one
  const again = await createResetInvite(t, org.org_id);
  assert.equal(again.kind, 'reset');
});

test('reset invite: a changed pilot terms version is asked again and recorded once', async () => {
  const { pool } = t.app.iwik;
  const org = await enrollOrganization(t, 'Terms Reset Org');
  // the organization agreed to an earlier version than the one now in force
  await pool.query(`UPDATE identity.agreements SET terms_version = $2 WHERE org_id = $1`, [
    org.org_id,
    '2026-08-pilot-0',
  ]);
  const invite = await createResetInvite(t, org.org_id);
  assert.equal(invite.kind, 'reset');
  const jar = new CookieJar('203.0.113.34');
  const page = await browse(t, jar, invite.invite_path);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /id="terms-changed"/);
  assert.ok(!page.body.includes('id="terms-unchanged"'));
  assert.match(page.body, /name="agree_terms"/);
  assert.match(page.body, /name="agree_trust_boundary"/);
  assert.match(page.body, /name="agree_reciprocity"/);
  assert.ok(page.body.includes(escapeHtml(PILOT_CLAUSES.trust_boundary)));
  assert.ok(!page.body.includes('name="display_name"'));

  const password = 'terms changed new password';
  const missing = await postForm(t, jar, invite.invite_path, {
    password,
    password_confirm: password,
    agree_terms: 'on',
    agree_trust_boundary: 'on',
  });
  assert.equal(missing.statusCode, 400);
  assert.match(missing.body, /Every clause must be accepted/);

  const ok = await resetPassword(t, jar, invite.invite_path, password);
  assert.equal(ok.statusCode, 303, ok.body);
  assert.equal(ok.headers.location, '/org?notice=password_reset');
  const agreements = await pool.query<{
    terms_version: string;
    clauses: string[];
    login_id: string;
  }>(
    `SELECT terms_version, clauses, login_id FROM identity.agreements WHERE org_id = $1
      ORDER BY accepted_at, agreement_id`,
    [org.org_id],
  );
  assert.deepEqual(
    agreements.rows.map((a) => a.terms_version),
    ['2026-08-pilot-0', PILOT_TERMS_VERSION],
  );
  assert.deepEqual(agreements.rows[1]?.clauses, ['terms', 'trust_boundary', 'reciprocity']);
  const live = await pool.query<{ login_id: string }>(
    `SELECT login_id FROM identity.console_logins WHERE org_id = $1 AND revoked_at IS NULL`,
    [org.org_id],
  );
  assert.equal(agreements.rows[1]?.login_id, live.rows[0]?.login_id);

  // a further reset with the terms unchanged records nothing new
  const next = await createResetInvite(t, org.org_id);
  const again = await resetPassword(t, new CookieJar('203.0.113.35'), next.invite_path, password);
  assert.equal(again.statusCode, 303, again.body);
  const count = await pool.query(`SELECT 1 FROM identity.agreements WHERE org_id = $1`, [
    org.org_id,
  ]);
  assert.equal(count.rows.length, 2);
});

test('re-invite of an organization that never enrolled: 409 while its invite is open, a fresh enroll invite once it expired', async () => {
  const { pool } = t.app.iwik;
  const first = await createInvite(t, 'Never Enrolled Org');
  const open = await reinvite(t, first.org_id);
  assert.equal(open.statusCode, 409);
  assert.equal(open.json<{ error: { code: string } }>().error.code, 'invite_exists');

  await pool.query(
    `UPDATE identity.invites SET expires_at = now() - interval '1 second' WHERE org_id = $1`,
    [first.org_id],
  );
  assert.equal((await browse(t, new CookieJar(), first.invite_path)).statusCode, 404);
  const again = await createResetInvite(t, first.org_id);
  assert.equal(again.kind, 'enroll');
  assert.notEqual(again.invite_path, first.invite_path);

  const jar = new CookieJar('203.0.113.36');
  const page = await browse(t, jar, again.invite_path);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /id="enroll-form"/);
  assert.match(page.body, /name="display_name"/);
  assert.match(page.body, /name="agree_terms"/);
  const password = 'never enrolled org password';
  const ok = await postForm(t, jar, again.invite_path, {
    display_name: 'Never Enrolled Org',
    password,
    password_confirm: password,
    agree_terms: 'on',
    agree_trust_boundary: 'on',
    agree_reciprocity: 'on',
  });
  assert.equal(ok.statusCode, 303, ok.body);
  assert.equal(ok.headers.location, '/org?notice=enrolled');
  const orgs = await pool.query(`SELECT 1 FROM identity.organizations WHERE name = $1`, [
    'Never Enrolled Org',
  ]);
  assert.equal(orgs.rows.length, 1);
  const logins = await pool.query(`SELECT 1 FROM identity.console_logins WHERE org_id = $1`, [
    first.org_id,
  ]);
  assert.equal(logins.rows.length, 1);

  // now enrolled, the next re-invite is a reset
  const reset = await createResetInvite(t, first.org_id);
  assert.equal(reset.kind, 'reset');
});

test('two organizations enroll, register nodes (base64 and PEM), issue tokens, and are isolated (404 not 403)', async () => {
  const a = await enrollWithNode(t, 'Org A');
  const b = await enrollOrganization(t, 'Org B');
  const bKey = generateNodeKey();
  const bNode = await registerNode(t, b, pubkeyPem(bKey));
  const bIssued = await issueTokenViaConsole(t, b, bNode, ['query', 'submit']);
  const bAs = { token: bIssued.token, key: bKey };

  // the PEM key is stored canonically as the base64 raw key
  const stored = await t.app.iwik.pool.query<{ pubkey: string }>(
    `SELECT pubkey FROM identity.nodes WHERE node_id = $1`,
    [bNode],
  );
  assert.equal(stored.rows[0]?.pubkey, bKey.pubkey);

  // an unparseable key and a duplicate key are refused with fixed messages
  const junk = await postForm(t, b.jar, '/org/nodes', { pubkey: 'not a key at all' });
  assert.equal(junk.headers.location, '/org?error=pubkey');
  const dup = await postForm(t, b.jar, '/org/nodes', { pubkey: bKey.pubkey });
  assert.equal(dup.headers.location, '/org?error=pubkey_exists');
  const errPage = await browse(t, b.jar, '/org?error=pubkey');
  assert.match(errPage.body, /id="error"/);
  assert.ok(!errPage.body.includes('not a key at all'));

  // each submits a run signed by its own node
  const runA = { ...(await prepareRun(t, { nodeId: a.node_id, token: a.token })) };
  const { receipt: receiptA } = await submitRun(t, runA, { token: a.token, key: a.key });
  const runB = {
    ...(await prepareRun(t, { nodeId: bNode, token: bAs.token })),
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5B00',
    attempt_id: '01ARZ3NDEKTSV4RRFFQ69G5B01',
  };
  const { receipt: receiptB } = await submitRun(t, runB, bAs);
  assert.notEqual(receiptA['receipt_id'], receiptB['receipt_id']);

  // own run readable, the other organization's run is 404 (never 403), nothing leaked
  const own = await t.app.inject({
    method: 'GET',
    url: `/v1/runs/${runA.run_id}`,
    headers: authHeader(a.token),
  });
  assert.equal(own.statusCode, 200);
  assert.equal(own.json<{ run: Run }>().run.node_id, a.node_id);
  const cross = await t.app.inject({
    method: 'GET',
    url: `/v1/runs/${runA.run_id}`,
    headers: authHeader(bAs.token),
  });
  assert.equal(cross.statusCode, 404);
  assert.equal(cross.json<{ error: { code: string } }>().error.code, 'not_found');
  const crossReceipt = await t.app.inject({
    method: 'GET',
    url: `/v1/receipts/${String(receiptA['receipt_id'])}`,
    headers: authHeader(bAs.token),
  });
  assert.equal(crossReceipt.statusCode, 404);
  const seeded = await t.app.inject({
    method: 'GET',
    url: `/v1/runs/${runB.run_id}`,
    headers: authHeader(t.token),
  });
  assert.equal(seeded.statusCode, 404);
  const orgRefs = await t.app.iwik.pool.query<{ org_ref: string }>(
    `SELECT org_ref FROM identity.org_refs WHERE org_id = ANY($1)`,
    [[a.org_id, b.org_id]],
  );
  for (const res of [cross, crossReceipt, seeded]) {
    for (const row of orgRefs.rows) assert.ok(!res.body.includes(row.org_ref));
    assert.ok(!res.body.includes(String(receiptA['receipt_id'])));
  }

  // the console pages are isolated too: B does not see A's node and cannot act on it
  const bPage = await browse(t, b.jar, '/org');
  assert.ok(bPage.body.includes(`id="node-${bNode}"`));
  assert.ok(!bPage.body.includes(a.node_id));
  assert.ok(!bPage.body.includes(a.token_id));
  const issueForeign = await postForm(t, b.jar, `/org/nodes/${a.node_id}/tokens`, {
    scope_query: 'on',
  });
  assert.equal(issueForeign.headers.location, '/org?error=node_unknown');
  const revokeForeign = await postForm(t, b.jar, `/org/tokens/${a.token_id}/revoke`, {});
  assert.equal(revokeForeign.headers.location, '/org?notice=nothing_to_revoke');
  const revokeForeignNode = await postForm(t, b.jar, `/org/nodes/${a.node_id}/revoke`, {});
  assert.equal(revokeForeignNode.headers.location, '/org?notice=nothing_to_revoke');
  const stillWorks = await t.app.inject({
    method: 'GET',
    url: '/v1/protocols',
    headers: authHeader(a.token),
  });
  assert.equal(stillWorks.statusCode, 200);

  // the console counts A's run for A only
  const aHome = await browse(t, a.jar, '/');
  assert.match(aHome.body, /id="accepted-runs">1</);
  assert.ok(aHome.body.includes(`id="last-receipt-id">${String(receiptA['receipt_id'])}<`));
});

test('tokens: shown exactly once, stored only as hashes, no plaintext column', async () => {
  const org = await enrollOrganization(t, 'Hash Org');
  const key = generateNodeKey();
  const nodeId = await registerNode(t, org, key.pubkey);

  const noScopes = await postForm(t, org.jar, `/org/nodes/${nodeId}/tokens`, {});
  assert.equal(noScopes.headers.location, '/org?error=scopes');

  const issued = await issueTokenViaConsole(t, org, nodeId, ['query', 'publish']);
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(issued.token_id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(issued.page.headers['cache-control'], 'no-store');
  assert.match(issued.page.body, /id="issued-scopes">query, publish</);
  // the id is listed, the plaintext is not shown again
  const again = await browse(t, org.jar, '/org');
  assert.ok(again.body.includes(`id="token-${issued.token_id}"`));
  assert.ok(!again.body.includes(issued.token));

  const { pool } = t.app.iwik;
  const columns = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'identity' AND table_name = 'tokens' ORDER BY column_name`,
  );
  assert.deepEqual(
    columns.rows.map((c) => c.column_name),
    ['created_at', 'node_id', 'revoked_at', 'scopes', 'token_hash', 'token_id'],
  );
  // no value in any identity table equals or contains the plaintext
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'identity'`,
  );
  for (const { table_name } of tables.rows) {
    const dump = await pool.query<{ row: unknown }>(
      `SELECT row_to_json(x) AS row FROM identity.${table_name} x`,
    );
    for (const r of dump.rows) assert.ok(!JSON.stringify(r.row).includes(issued.token), table_name);
  }
  const row = await pool.query<{ token_hash: string; scopes: string[] }>(
    `SELECT token_hash, scopes FROM identity.tokens WHERE token_id = $1`,
    [issued.token_id],
  );
  assert.match(row.rows[0]?.token_hash ?? '', /^[0-9a-f]{64}$/);
  assert.deepEqual(row.rows[0]?.scopes, ['query', 'publish']);

  // the token works with exactly the scopes chosen
  const q = await t.app.inject({
    method: 'GET',
    url: '/v1/protocols',
    headers: authHeader(issued.token),
  });
  assert.equal(q.statusCode, 200);
  const s = await preview(t, await prepareRun(t, { nodeId, token: issued.token }), issued.token);
  assert.equal(s.statusCode, 403);
});

test('revocation: token -> 401 unauthorized; node -> every token 401 node_revoked and intake refuses the signature', async () => {
  const org = await enrollWithNode(t, 'Revoke Org');
  const second = await issueTokenViaConsole(t, org, org.node_id, ['query', 'submit']);

  // revoke one token: it is gone, the other still works
  const rt = await postForm(t, org.jar, `/org/tokens/${second.token_id}/revoke`, {});
  assert.equal(rt.headers.location, '/org?notice=token_revoked');
  const gone = await t.app.inject({
    method: 'GET',
    url: '/v1/protocols',
    headers: authHeader(second.token),
  });
  assert.equal(gone.statusCode, 401);
  assert.equal(gone.json<{ error: { code: string } }>().error.code, 'unauthorized');
  const alive = await t.app.inject({
    method: 'GET',
    url: '/v1/protocols',
    headers: authHeader(org.token),
  });
  assert.equal(alive.statusCode, 200);
  const twice = await postForm(t, org.jar, `/org/tokens/${second.token_id}/revoke`, {});
  assert.equal(twice.headers.location, '/org?notice=nothing_to_revoke');
  const page = await browse(t, org.jar, '/org');
  assert.match(page.body, new RegExp(`id="token-${second.token_id}"[\\s\\S]*?revoked `));

  // a preview issued before node revocation cannot be turned into an accepted run after it
  const run = {
    ...(await prepareRun(t, { nodeId: org.node_id, token: org.token })),
    run_id: '01ARZ3NDEKTSV4RRFFQ69G5R00',
    attempt_id: '01ARZ3NDEKTSV4RRFFQ69G5R01',
  };
  const p = await preview(t, run, org.token);
  assert.equal(p.statusCode, 200, p.body);
  const previewId = p.json<{ preview_id: string }>().preview_id;

  const rn = await postForm(t, org.jar, `/org/nodes/${org.node_id}/revoke`, {});
  assert.equal(rn.headers.location, '/org?notice=node_revoked');

  const submitted = await submit(t, previewId, signRun(run, org.key), org.token);
  assert.equal(submitted.statusCode, 401, submitted.body);
  assert.equal(submitted.json<{ error: { code: string } }>().error.code, 'node_revoked');
  const stored = await t.app.iwik.pool.query(`SELECT 1 FROM evidence.runs WHERE run_id = $1`, [
    run.run_id,
  ]);
  assert.equal(stored.rows.length, 0);
  for (const url of ['/v1/protocols', `/v1/runs/${run.run_id}`]) {
    const res = await t.app.inject({ method: 'GET', url, headers: authHeader(org.token) });
    assert.equal(res.statusCode, 401, url);
    assert.equal(res.json<{ error: { code: string } }>().error.code, 'node_revoked');
  }
  // the revoked node's session-less console state: no more tokens for it
  const issueDead = await postForm(t, org.jar, `/org/nodes/${org.node_id}/tokens`, {
    scope_query: 'on',
  });
  assert.equal(issueDead.headers.location, '/org?error=node_revoked');
  const after = await browse(t, org.jar, '/org');
  assert.match(after.body, /\(revoked /);

  // the audit trail names ids only and carries no run content
  const audit = await t.app.iwik.pool.query<{ event: string; actor: string; target: string }>(
    `SELECT event, actor, target FROM identity.audit ORDER BY at, audit_id`,
  );
  const events = new Set(audit.rows.map((r) => r.event));
  for (const e of [
    'org.invited',
    'org.enrolled',
    'node.registered',
    'token.issued',
    'token.revoked',
    'node.revoked',
    'console.login',
  ]) {
    assert.ok(events.has(e), e);
  }
  assert.ok(
    audit.rows.some((r) => r.event === 'token.revoked' && r.target === `token:${second.token_id}`),
  );
  assert.ok(
    audit.rows.some((r) => r.event === 'node.revoked' && r.target === `node:${org.node_id}`),
  );
  const text = JSON.stringify(audit.rows);
  for (const forbidden of [run.run_id, 'stub-model', org.token, second.token, org.password]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  for (const r of audit.rows) {
    assert.match(r.actor, /^(operator|login:[0-9A-HJKMNP-TV-Z]{26})$/);
    assert.match(r.target, /^(org|node|token):[0-9A-Za-z_]+$/);
  }
});

test('scope matrix: every endpoint x every single-scope token', async () => {
  const org = await enrollOrganization(t, 'Matrix Org');
  const key = generateNodeKey();
  const nodeId = await registerNode(t, org, key.pubkey);
  const tokens = {
    query: (await issueTokenViaConsole(t, org, nodeId, ['query'])).token,
    submit: (await issueTokenViaConsole(t, org, nodeId, ['submit'])).token,
    publish: (await issueTokenViaConsole(t, org, nodeId, ['publish'])).token,
  };
  const all = (await issueTokenViaConsole(t, org, nodeId, ['query', 'submit', 'publish'])).token;
  const run = await prepareRun(t, { nodeId, token: all });
  const { receipt } = await submitRun(
    t,
    { ...run, run_id: '01ARZ3NDEKTSV4RRFFQ69G5M00', attempt_id: '01ARZ3NDEKTSV4RRFFQ69G5M01' },
    { token: all, key },
  );

  type Row = {
    method: 'GET' | 'POST';
    url: string;
    payload?: Record<string, unknown>;
    scope: string;
    ok: number;
  };
  const matrix: Row[] = [
    { method: 'GET', url: '/v1/protocols', scope: 'query', ok: 200 },
    { method: 'GET', url: '/v1/protocols/inference-api/latency@1', scope: 'query', ok: 200 },
    { method: 'GET', url: '/v1/protocols/inference-api%2Flatency%401', scope: 'query', ok: 200 },
    { method: 'GET', url: '/v1/runs/01ARZ3NDEKTSV4RRFFQ69G5M00', scope: 'query', ok: 200 },
    {
      method: 'GET',
      url: `/v1/receipts/${String(receipt['receipt_id'])}`,
      scope: 'query',
      ok: 200,
    },
    {
      method: 'POST',
      url: '/v1/contributions/preview',
      payload: { run },
      scope: 'submit',
      ok: 200,
    },
    {
      method: 'POST',
      url: '/v1/runs',
      payload: { preview_id: '01ARZ3NDEKTSV4RRFFQ69G5PRV', run: signRun(run, key) },
      scope: 'submit',
      ok: 404, // scope passes; the bogus preview is what fails
    },
  ];
  // publish endpoints (challenges, outcomes, withdrawals) arrive in a later stage;
  // until then the publish scope opens nothing, which this matrix pins down.
  for (const row of matrix) {
    for (const [scope, token] of Object.entries(tokens)) {
      const res = await t.app.inject({
        method: row.method,
        url: row.url,
        headers: authHeader(token),
        ...(row.payload === undefined ? {} : { payload: row.payload }),
      });
      const label = `${row.method} ${row.url} with ${scope}`;
      if (scope === row.scope) {
        assert.equal(res.statusCode, row.ok, label);
      } else {
        assert.equal(res.statusCode, 403, label);
        assert.deepEqual(res.json(), {
          error: {
            code: 'scope_required',
            message: 'token lacks the required scope',
            details: [{ path: '', rule: `scope:${row.scope}` }],
          },
        });
      }
    }
    // the operator endpoint is never a node scope
    const admin = await t.app.inject({
      method: 'POST',
      url: '/v1/admin/organizations',
      headers: authHeader(all),
      payload: { name: 'Matrix Escalation' },
    });
    assert.equal(admin.statusCode, 401);
  }
});

test('csrf: console mutations without the signed cookie + field are refused', async () => {
  const org = await enrollOrganization(t, 'CSRF Org');
  const key = generateNodeKey();
  const missing = await postForm(t, org.jar, '/org/nodes', { pubkey: key.pubkey }, { csrf: null });
  assert.equal(missing.statusCode, 403);
  assert.equal(missing.json<{ error: { code: string } }>().error.code, 'csrf_failed');
  const wrong = await postForm(
    t,
    org.jar,
    '/org/nodes',
    { pubkey: key.pubkey },
    { csrf: 'x'.repeat(32) },
  );
  assert.equal(wrong.statusCode, 403);
  // cookie present but forged signature
  const forgedJar = new CookieJar();
  forgedJar.absorb({
    headers: { 'set-cookie': `iwik_csrf=${'y'.repeat(32)}.${'z'.repeat(43)}; Path=/` },
  } as never);
  const forged = await postForm(
    t,
    forgedJar,
    '/org/nodes',
    { pubkey: key.pubkey },
    { csrf: 'y'.repeat(32) },
  );
  assert.equal(forged.statusCode, 403);
  const nodes = await t.app.iwik.pool.query(`SELECT 1 FROM identity.nodes WHERE org_id = $1`, [
    org.org_id,
  ]);
  assert.equal(nodes.rows.length, 0);
  const ok = await postForm(t, org.jar, '/org/nodes', { pubkey: key.pubkey });
  assert.equal(ok.statusCode, 303);
});

test('migration is additive and re-runnable: identity tables present, legacy token ids backfilled', async () => {
  const { pool } = t.app.iwik;
  const tables = await pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'identity' ORDER BY 1`,
  );
  assert.deepEqual(
    tables.rows.map((r) => r.table_name),
    [
      'agreements',
      'audit',
      'console_logins',
      'invites',
      'nodes',
      'org_keys',
      'org_refs',
      'organizations',
      'tokens',
    ],
  );
  // the seed token (issued through the stage-2 path) carries a token_id too
  const seed = await pool.query<{ token_id: string }>(
    `SELECT token_id FROM identity.tokens WHERE node_id = $1`,
    ['01ARZ3NDEKTSV4RRFFQ69G5N0D'],
  );
  assert.match(seed.rows[0]?.token_id ?? '', /^[0-9A-HJKMNP-TV-Z]{26}$/);
  // stage 11: invites carry a kind, default enroll, constrained to enroll | reset
  const kind = await pool.query<{ column_default: string; is_nullable: string }>(
    `SELECT column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'identity' AND table_name = 'invites' AND column_name = 'kind'`,
  );
  assert.equal(kind.rows[0]?.column_default, "'enroll'::text");
  assert.equal(kind.rows[0]?.is_nullable, 'NO');
  const anyOrg = await pool.query<{ org_id: string }>(
    `SELECT org_id FROM identity.organizations LIMIT 1`,
  );
  await assert.rejects(
    pool.query(
      `INSERT INTO identity.invites (invite_hash, org_id, kind, expires_at)
       VALUES ($2, $1, 'bogus', now())`,
      [anyOrg.rows[0]?.org_id, '0'.repeat(64)],
    ),
    /invites_kind_check/,
  );
  const ready = await t.app.inject({ method: 'GET', url: '/readyz' });
  assert.equal(ready.statusCode, 200);
});
