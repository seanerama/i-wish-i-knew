// The operator console for the ledger (stage 10): `/admin/challenges` lists
// open challenges with their grounds and target kind only, and resolves
// them. Behind IWIK_FEATURE_CHALLENGE like the JSON endpoints (404 while
// off, before anything else).
//
// Operator session. The console had no operator identity before this stage
// (the operator token is a bearer token for the /v1/admin endpoints, ADR-0006).
// The same token signs in here, through a form, and what the browser then
// holds is a separate HMAC-signed cookie (`iwik_operator`) carrying the
// SHA-256 of the token, compared in constant time against
// `config.operatorTokenHash` on every request, exactly as the bearer path
// does; the token itself is never stored. It is deliberately not a member
// session (`iwik_session`): an operator signed in here holds no organization
// and sees no evidence. The login is CSRF-protected and rate limited per
// client address like the console login (identity/ratelimit.ts, same
// pilot-only limitations); the cookie lasts one hour.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ChallengeResolution, RelationshipRationale } from '@iwik/contracts';
import type { Config } from '../../config.js';
import { ApiError } from '../../errors.js';
import { ULID_PATTERN } from '../../ulid.js';
import { PRODUCT_NAME } from '../console/index.js';
import { csrfToken, requireCsrf, rotateCsrf } from '../console/session.js';
import { audit } from '../identity/index.js';
import { FailureWindow } from '../identity/ratelimit.js';
import type { ChallengeDeps } from './index.js';
import { acknowledgeChallenge, listOpenChallenges, resolveChallenge } from './index.js';
import {
  CHALLENGE_RESOLUTIONS,
  RELATIONSHIP_RATIONALES,
  RESOLUTION_RELATIONSHIP,
} from './vocab.js';

export const OPERATOR_COOKIE = 'iwik_operator';
export const OPERATOR_SESSION_TTL_SECONDS = 60 * 60;
/** Subject for the per-address login window: the same for every request. */
const IP_BUCKET = '*';
const OPERATOR_TOKEN_MAX_LENGTH = 512;

interface OperatorPayload {
  v: 1;
  kind: 'operator';
  /** SHA-256 of the operator token, hex. */
  h: string;
  iat: number;
  exp: number;
}

function hmac(key: Buffer, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('base64url');
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function sealOperatorSession(key: Buffer, payload: OperatorPayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${hmac(key, `operator:${body}`)}`;
}

export function openOperatorSession(
  key: Buffer,
  cookie: string | undefined,
): OperatorPayload | undefined {
  if (cookie === undefined) return undefined;
  const dot = cookie.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const body = cookie.slice(0, dot);
  if (!equal(cookie.slice(dot + 1), hmac(key, `operator:${body}`))) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const p = parsed as Record<string, unknown>;
  if (
    p['v'] !== 1 ||
    p['kind'] !== 'operator' ||
    typeof p['h'] !== 'string' ||
    typeof p['exp'] !== 'number' ||
    p['exp'] * 1000 < Date.now()
  ) {
    return undefined;
  }
  return parsed as OperatorPayload;
}

/** Whether the presented operator token (form field) is the configured one; constant time. */
export function operatorTokenMatches(token: string, config: Config): boolean {
  if (config.operatorTokenHash === undefined || token === '') return false;
  const presented = createHash('sha256').update(token, 'utf8').digest();
  return timingSafeEqual(presented, config.operatorTokenHash);
}

/** True when the cookie carries a valid, unexpired session for the configured operator token. */
export function resolveOperatorSession(request: FastifyRequest, config: Config): boolean {
  const payload = openOperatorSession(config.sessionKey, request.cookies[OPERATOR_COOKIE]);
  if (payload === undefined || config.operatorTokenHash === undefined) return false;
  if (!/^[0-9a-f]{64}$/.test(payload.h)) return false;
  return timingSafeEqual(Buffer.from(payload.h, 'hex'), config.operatorTokenHash);
}

export function setOperatorSession(reply: FastifyReply, config: Config, token: string): void {
  const iat = Math.floor(Date.now() / 1000);
  const payload: OperatorPayload = {
    v: 1,
    kind: 'operator',
    h: createHash('sha256').update(token, 'utf8').digest('hex'),
    iat,
    exp: iat + OPERATOR_SESSION_TTL_SECONDS,
  };
  reply.setCookie(OPERATOR_COOKIE, sealOperatorSession(config.sessionKey, payload), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.production,
    path: '/',
    maxAge: OPERATOR_SESSION_TTL_SECONDS,
  });
  // A nonce that existed before sign-in is refused afterwards (stage 11 rule).
  rotateCsrf(reply, config);
}

export function clearOperatorSession(reply: FastifyReply): void {
  reply.clearCookie(OPERATOR_COOKIE, { path: '/' });
}

function formString(body: unknown, field: string, max: number): string {
  if (typeof body !== 'object' || body === null) return '';
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.slice(0, max) : '';
}

const NOTICES = new Set(['resolved', 'acknowledged']);
const ERRORS = new Set(['unknown', 'already_resolved', 'resolution', 'rationale', 'confirm']);

export function registerOperatorConsole(app: FastifyInstance, deps: ChallengeDeps): void {
  const { pool, config } = deps;
  const failures = new FailureWindow();
  /** HTML pages: a plain 404 while the flag is off, before anything else. */
  const gate = async (): Promise<void> => {
    if (!config.featureChallenge) throw new ApiError(404, 'not_found');
  };
  app.get<{ Querystring: { login?: string } }>(
    '/admin/login',
    { preHandler: gate },
    async (request, reply) => {
      if (resolveOperatorSession(request, config)) return reply.redirect('/admin/challenges', 303);
      return reply.view('admin-login', {
        product: PRODUCT_NAME,
        login_failed: request.query.login === 'failed',
        csrf: csrfToken(request, reply, config),
      });
    },
  );

  app.post('/admin/login', { preHandler: gate }, async (request, reply) => {
    requireCsrf(request, config);
    const ip = request.ip;
    const retryAfter = failures.retryAfterSeconds(IP_BUCKET, ip);
    if (retryAfter > 0) {
      request.log.info('operator login rate limited');
      throw new ApiError(429, 'rate_limited', { headers: { 'retry-after': String(retryAfter) } });
    }
    const token = formString(request.body, 'token', OPERATOR_TOKEN_MAX_LENGTH).trim();
    if (!operatorTokenMatches(token, config)) {
      failures.recordFailure(IP_BUCKET, ip);
      request.log.info('operator login failed');
      return reply.redirect('/admin/login?login=failed', 303);
    }
    failures.clear(IP_BUCKET, ip);
    setOperatorSession(reply, config, token);
    await audit(pool, 'console.operator_login', 'operator', 'console:admin');
    request.log.info('operator login');
    return reply.redirect('/admin/challenges', 303);
  });

  app.post('/admin/logout', { preHandler: gate }, async (request, reply) => {
    requireCsrf(request, config);
    clearOperatorSession(reply);
    return reply.redirect('/admin/login', 303);
  });

  app.get<{ Querystring: { notice?: string; error?: string } }>(
    '/admin/challenges',
    { preHandler: gate },
    async (request, reply) => {
      if (!resolveOperatorSession(request, config)) return reply.redirect('/admin/login', 303);
      const challenges = await listOpenChallenges(pool);
      const notice = request.query.notice;
      const error = request.query.error;
      return reply.view('admin-challenges', {
        product: PRODUCT_NAME,
        csrf: csrfToken(request, reply, config),
        challenges: challenges.map((c) => ({ ...c, filed_at: c.filed_at.toISOString() })),
        resolutions: CHALLENGE_RESOLUTIONS,
        relationship_of: RESOLUTION_RELATIONSHIP,
        rationales: RELATIONSHIP_RATIONALES,
        notice: notice !== undefined && NOTICES.has(notice) ? notice : null,
        error: error !== undefined && ERRORS.has(error) ? error : null,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    '/admin/challenges/:id/resolve',
    { preHandler: gate },
    async (request, reply) => {
      requireCsrf(request, config);
      if (!resolveOperatorSession(request, config)) return reply.redirect('/admin/login', 303);
      const id = request.params.id;
      if (!ULID_PATTERN.test(id)) return reply.redirect('/admin/challenges?error=unknown', 303);
      const action = formString(request.body, 'action', 16);
      if (action === 'acknowledge') {
        const done = await acknowledgeChallenge(pool, id);
        return reply.redirect(
          done ? '/admin/challenges?notice=acknowledged' : '/admin/challenges?error=unknown',
          303,
        );
      }
      const resolution = formString(request.body, 'resolution', 16);
      const rationale = formString(request.body, 'rationale', 32);
      const confirmed = formString(request.body, 'confirm', 4) === 'on';
      if (!(CHALLENGE_RESOLUTIONS as readonly string[]).includes(resolution)) {
        return reply.redirect('/admin/challenges?error=resolution', 303);
      }
      if (!(RELATIONSHIP_RATIONALES as readonly string[]).includes(rationale)) {
        return reply.redirect('/admin/challenges?error=rationale', 303);
      }
      if (!confirmed) return reply.redirect('/admin/challenges?error=confirm', 303);
      const chosen = resolution as ChallengeResolution;
      try {
        const result = await resolveChallenge(pool, id, {
          resolution: chosen,
          relationship: {
            kind: RESOLUTION_RELATIONSHIP[chosen],
            rationale: rationale as RelationshipRationale,
          },
        });
        request.log.info(
          {
            challenge_id: result.challenge_id,
            resolution: result.resolution,
            resolved_revision: result.resolved_revision,
          },
          'challenge resolved (console)',
        );
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) {
          return reply.redirect('/admin/challenges?error=unknown', 303);
        }
        if (err instanceof ApiError && err.status === 409) {
          return reply.redirect('/admin/challenges?error=already_resolved', 303);
        }
        throw err;
      }
      return reply.redirect('/admin/challenges?notice=resolved', 303);
    },
  );
}
