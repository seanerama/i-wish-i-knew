// Console sessions and CSRF (stage 6).
//
// One cookie, `iwik_session`, carries an HMAC-SHA256-signed payload keyed by
// a session key derived from the KEK (config.sessionKey). Two kinds of
// session exist:
//   - `org`: an organization signed in with its console password
//     (identity.console_logins); may manage nodes and tokens at /org.
//   - `node`: the stage-2 path, a node token pasted on `/`; carries the token
//     hash (never the token) and is re-checked against identity.tokens on
//     every request, so revoking the token or its node ends the session.
// Cookies are HttpOnly, SameSite=Lax (an invite link opened from mail or chat
// is a top-level navigation and must still carry the cookie afterwards) and
// Secure in production.
//
// CSRF: double-submit with a signed cookie. `iwik_csrf` holds
// `<nonce>.<hmac(nonce)>`; every form carries the nonce in `_csrf`; a POST is
// accepted only when the cookie verifies and equals the field.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { Queryable } from '../../db.js';
import { ApiError } from '../../errors.js';
import { authenticateByHash, findConsoleLogin } from '../identity/index.js';
import type { AuthContext } from '../identity/index.js';

export const SESSION_COOKIE = 'iwik_session';
export const CSRF_COOKIE = 'iwik_csrf';
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export type SessionPayload =
  | { v: 1; kind: 'org'; login_id: string; org_id: string; iat: number; exp: number }
  | { v: 1; kind: 'node'; token_hash: string; iat: number; exp: number };

function hmac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64url');
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sealSession(key: Buffer, payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(key, body)}`;
}

export function openSession(key: Buffer, cookie: string | undefined): SessionPayload | undefined {
  if (cookie === undefined) return undefined;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const body = cookie.slice(0, dot);
  const mac = cookie.slice(dot + 1);
  if (!equal(mac, hmac(key, body))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const p = parsed as Record<string, unknown>;
  if (p['v'] !== 1 || typeof p['exp'] !== 'number' || p['exp'] * 1000 < Date.now()) {
    return undefined;
  }
  if (p['kind'] === 'org' && typeof p['login_id'] === 'string' && typeof p['org_id'] === 'string') {
    return parsed as SessionPayload;
  }
  if (p['kind'] === 'node' && typeof p['token_hash'] === 'string') return parsed as SessionPayload;
  return undefined;
}

function cookieOptions(config: Config, maxAge: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.production,
    path: '/',
    maxAge,
  };
}

export type NewSession =
  { kind: 'org'; login_id: string; org_id: string } | { kind: 'node'; token_hash: string };

export function setSession(reply: FastifyReply, config: Config, payload: NewSession): void {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + SESSION_TTL_SECONDS;
  const full: SessionPayload =
    payload.kind === 'org'
      ? { v: 1, kind: 'org', login_id: payload.login_id, org_id: payload.org_id, iat, exp }
      : { v: 1, kind: 'node', token_hash: payload.token_hash, iat, exp };
  reply.setCookie(
    SESSION_COOKIE,
    sealSession(config.sessionKey, full),
    cookieOptions(config, SESSION_TTL_SECONDS),
  );
}

export function clearSession(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

export type Session =
  | { kind: 'org'; login_id: string; org_id: string; org_name: string }
  | { kind: 'node'; auth: AuthContext };

/** The live session behind the cookie, re-validated against the database. */
export async function resolveSession(
  request: FastifyRequest,
  config: Config,
  db: Queryable,
): Promise<Session | undefined> {
  const payload = openSession(config.sessionKey, request.cookies[SESSION_COOKIE]);
  if (payload === undefined) return undefined;
  if (payload.kind === 'node') {
    const auth = await authenticateByHash(db, payload.token_hash);
    return auth === undefined ? undefined : { kind: 'node', auth };
  }
  const login = await findConsoleLogin(db, payload.login_id);
  if (login === undefined || login.org_id !== payload.org_id) return undefined;
  return { kind: 'org', login_id: login.login_id, org_id: login.org_id, org_name: login.org_name };
}

/** The CSRF nonce for the forms on this response, setting the cookie when absent or invalid. */
export function csrfToken(request: FastifyRequest, reply: FastifyReply, config: Config): string {
  const existing = verifiedCsrfCookie(request, config);
  if (existing !== undefined) return existing;
  const nonce = randomBytes(24).toString('base64url');
  reply.setCookie(
    CSRF_COOKIE,
    `${nonce}.${hmac(config.sessionKey, `csrf:${nonce}`)}`,
    cookieOptions(config, SESSION_TTL_SECONDS),
  );
  return nonce;
}

function verifiedCsrfCookie(request: FastifyRequest, config: Config): string | undefined {
  const raw = request.cookies[CSRF_COOKIE];
  if (raw === undefined) return undefined;
  const dot = raw.indexOf('.');
  if (dot <= 0) return undefined;
  const nonce = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return undefined;
  return equal(mac, hmac(config.sessionKey, `csrf:${nonce}`)) ? nonce : undefined;
}

/** Throw 403 csrf_failed unless the form's `_csrf` matches the signed cookie. */
export function requireCsrf(request: FastifyRequest, config: Config): void {
  const cookieNonce = verifiedCsrfCookie(request, config);
  const body = request.body;
  const field =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)['_csrf']
      : undefined;
  if (cookieNonce === undefined || typeof field !== 'string' || !equal(field, cookieNonce)) {
    throw new ApiError(403, 'csrf_failed');
  }
}
