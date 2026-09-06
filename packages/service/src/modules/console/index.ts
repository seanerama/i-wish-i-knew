// Member console (ADR-0001): server-rendered pages with plain HTML forms.
//
// `/` shows the product, the ADR-0002 trust-boundary statement, the evidence
// revision, and for a signed-in organization or node its accepted-run count
// and last receipt id. Sign-in comes in two forms:
//   - node token on `/` (stage 2; still works with enrollment off), and
//   - organization name + console password at `/console/login` (stage 6,
//     only with IWIK_FEATURE_ENROLLMENT=on), which unlocks `/org`.
// Both produce the same signed session cookie (session.ts). Enrollment
// pages live in modules/enrollment.
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { serviceRoot } from '../../config.js';
import type { Config } from '../../config.js';
import type { Pool } from '../../db.js';
import { ApiError } from '../../errors.js';
import {
  audit,
  authenticateByHash,
  findConsoleLoginByOrgName,
  hashToken,
} from '../identity/index.js';
import { DUMMY_HASH, PASSWORD_MAX_LENGTH, verifyPassword } from '../identity/password.js';
import { FailureWindow } from '../identity/ratelimit.js';
import { currentRevision, findReceipt, withStaleness } from '../intake/index.js';
import type { Registry } from '../registry/index.js';
import { ULID_PATTERN } from '../../ulid.js';
import { clearSession, csrfToken, requireCsrf, resolveSession, setSession } from './session.js';
import type { Session } from './session.js';

export { SESSION_COOKIE } from './session.js';

export const PRODUCT_NAME = 'I Wish I Knew';

/** ADR-0002: the pilot may not be marketed as operator-excluded. */
export const TRUST_BOUNDARY_STATEMENT =
  'Pilot trust boundary (ADR-0002): evidence is stored sanitized and encrypted per organization, ' +
  'but service operators are inside the trust boundary during the pilot. ' +
  'Operator exclusion is a gate before the first real-member release, not a current guarantee.';

/** packages/service/views: shipped as files, not compiled, so src/ and dist/ share it. */
export const viewsDir = join(serviceRoot, 'views');

export const ORG_NAME_MAX_LENGTH = 120;

/** Subject for the per-IP login window: the same for every request. */
const IP_BUCKET = '*';

export interface ConsoleDeps {
  pool: Pool;
  config: Config;
  registry: Registry;
  /** Per organization name + client IP failure window; one per process. */
  loginFailures?: FailureWindow;
  /**
   * Stage 11: a second window keyed by client IP alone (same limit and
   * window), so varying the organization name does not buy more attempts.
   */
  loginIpFailures?: FailureWindow;
}

interface SessionView {
  kind: 'org' | 'node';
  org_name: string;
  node_id: string | null;
  accepted_runs: number;
  last_receipt_id: string | null;
}

async function sessionView(session: Session, deps: ConsoleDeps): Promise<SessionView> {
  const orgRef =
    session.kind === 'node'
      ? session.auth.org_ref
      : (
          await deps.pool.query<{ org_ref: string }>(
            `SELECT org_ref FROM identity.org_refs WHERE org_id = $1`,
            [session.org_id],
          )
        ).rows[0]?.org_ref;
  const runs = await deps.pool.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM evidence.runs WHERE org_ref = $1`,
    [orgRef ?? ''],
  );
  const receipt = await deps.pool.query<{ receipt_id: string }>(
    `SELECT receipt_id FROM evidence.receipts WHERE org_ref = $1
      ORDER BY issued_at DESC, receipt_id DESC LIMIT 1`,
    [orgRef ?? ''],
  );
  return {
    kind: session.kind,
    org_name: session.kind === 'node' ? session.auth.org_name : session.org_name,
    node_id: session.kind === 'node' ? session.auth.node_id : null,
    accepted_runs: Number(runs.rows[0]?.n ?? 0),
    last_receipt_id: receipt.rows[0]?.receipt_id ?? null,
  };
}

/** Pre-handler: 404 (the standard envelope) unless enrollment is on. */
export function requireEnrollment(
  config: Config,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async () => {
    if (!config.featureEnrollment) throw new ApiError(404, 'not_found');
  };
}

function formString(body: unknown, field: string, max: number): string {
  if (typeof body !== 'object' || body === null) return '';
  const value = (body as Record<string, unknown>)[field];
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  const failures = deps.loginFailures ?? new FailureWindow();
  const ipFailures = deps.loginIpFailures ?? new FailureWindow();
  const enrollmentOn = deps.config.featureEnrollment;

  app.get<{ Querystring: { login?: string } }>('/', async (request, reply) => {
    const session = await resolveSession(request, deps.config, deps.pool);
    const view = session === undefined ? null : await sessionView(session, deps);
    const revision = await currentRevision(deps.pool);
    return reply.view('index', {
      product: PRODUCT_NAME,
      trust_statement: TRUST_BOUNDARY_STATEMENT,
      evidence_revision: revision,
      protocols: deps.registry.list().map((e) => e.protocol.ref),
      intake_enabled: deps.config.featureIntake,
      enrollment_enabled: enrollmentOn,
      withdrawal_enabled: deps.config.featureWithdrawal,
      dedupe_enabled: deps.config.featureDedupe,
      cooperative_query_enabled: deps.config.featureCooperativeQuery,
      session: view,
      login_failed: request.query.login === 'failed',
      csrf: csrfToken(request, reply, deps.config),
    });
  });

  // Stage 2 sign-in: a node token. The cookie carries the token hash only.
  app.post<{ Body: { token?: string } }>('/console/session', async (request, reply) => {
    requireCsrf(request, deps.config);
    const token = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
    const auth = token === '' ? undefined : await authenticateByHash(deps.pool, hashToken(token));
    if (auth === undefined) {
      request.log.info('console sign-in failed');
      return reply.redirect('/?login=failed', 303);
    }
    setSession(reply, deps.config, { kind: 'node', token_hash: hashToken(token) });
    request.log.info({ org_ref: auth.org_ref }, 'console sign-in');
    return reply.redirect('/', 303);
  });

  // Stage 6 sign-in: organization name + console password, rate limited per
  // organization + IP and (stage 11) per IP alone. Both key on `request.ip`,
  // which is the X-Forwarded-For client only when IWIK_TRUST_PROXY says so.
  // In-process memory, pilot only: see identity/ratelimit.ts.
  app.get<{ Querystring: { login?: string } }>(
    '/console/login',
    { preHandler: requireEnrollment(deps.config) },
    async (request, reply) => {
      const session = await resolveSession(request, deps.config, deps.pool);
      if (session?.kind === 'org') return reply.redirect('/org', 303);
      return reply.view('login', {
        product: PRODUCT_NAME,
        login_failed: request.query.login === 'failed',
        csrf: csrfToken(request, reply, deps.config),
      });
    },
  );

  app.post(
    '/console/login',
    { preHandler: requireEnrollment(deps.config) },
    async (request, reply) => {
      requireCsrf(request, deps.config);
      const orgName = formString(request.body, 'organization', ORG_NAME_MAX_LENGTH).trim();
      const password = formString(request.body, 'password', PASSWORD_MAX_LENGTH);
      const ip = request.ip;
      const retryAfter = Math.max(
        failures.retryAfterSeconds(orgName, ip),
        ipFailures.retryAfterSeconds(IP_BUCKET, ip),
      );
      if (retryAfter > 0) {
        request.log.info('console login rate limited');
        throw new ApiError(429, 'rate_limited', { headers: { 'retry-after': String(retryAfter) } });
      }
      const login =
        orgName === '' ? undefined : await findConsoleLoginByOrgName(deps.pool, orgName);
      // Always run scrypt so an unknown organization costs the same as a wrong password.
      const ok =
        verifyPassword(password, login?.password_hash ?? DUMMY_HASH) && login !== undefined;
      if (!ok) {
        failures.recordFailure(orgName, ip);
        ipFailures.recordFailure(IP_BUCKET, ip);
        request.log.info('console login failed');
        return reply.redirect('/console/login?login=failed', 303);
      }
      // A success clears the organization's own window only; the per-IP
      // window keeps counting until it expires, so one known password does
      // not reopen guessing against other organizations from that address.
      failures.clear(orgName, ip);
      // setSession also rotates the CSRF nonce (stage 11).
      setSession(reply, deps.config, {
        kind: 'org',
        login_id: login.login_id,
        org_id: login.org_id,
      });
      await audit(deps.pool, 'console.login', `login:${login.login_id}`, `org:${login.org_id}`);
      request.log.info({ org_id: login.org_id }, 'console login');
      return reply.redirect('/org', 303);
    },
  );

  app.post('/console/logout', async (request, reply) => {
    requireCsrf(request, deps.config);
    clearSession(reply);
    return reply.redirect('/', 303);
  });

  // Stage 9: one of the signed-in organization's query receipts, rendered
  // section by section (the same AnswerReceipt GET /v1/receipts/{id} returns,
  // staleness included). Either session kind may read; another
  // organization's receipt is a 404 page, never a hint that it exists.
  app.get<{ Params: { id: string } }>('/receipts/:id', async (request, reply) => {
    const session = await resolveSession(request, deps.config, deps.pool);
    if (session === undefined) return reply.redirect('/', 303);
    const orgRef =
      session.kind === 'node'
        ? session.auth.org_ref
        : (
            await deps.pool.query<{ org_ref: string }>(
              `SELECT org_ref FROM identity.org_refs WHERE org_id = $1`,
              [session.org_id],
            )
          ).rows[0]?.org_ref;
    const id = request.params.id;
    const found =
      orgRef !== undefined && ULID_PATTERN.test(id)
        ? await findReceipt(deps.pool, id, orgRef)
        : undefined;
    if (found === undefined || found.kind !== 'query') {
      return reply.status(404).view('message', {
        product: PRODUCT_NAME,
        title: 'Receipt not found',
        message: 'No query receipt with that id belongs to your organization.',
      });
    }
    const receipt = await withStaleness(deps.pool, found);
    const result =
      typeof receipt['result'] === 'object' && receipt['result'] !== null
        ? (receipt['result'] as Record<string, unknown>)
        : {};
    return reply.view('receipt', {
      product: PRODUCT_NAME,
      org_name: session.kind === 'node' ? session.auth.org_name : session.org_name,
      receipt,
      result,
      json: JSON.stringify(receipt, null, 2),
    });
  });
}
