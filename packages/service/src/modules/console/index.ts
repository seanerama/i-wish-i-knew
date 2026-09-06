// Member console: one server-rendered page (ADR-0001). Shows the product,
// the ADR-0002 trust-boundary statement, the evidence revision, and for a
// node signed in with its token (simple session cookie for now; stage 6
// brings real console sign-in) its organization's accepted-run count and
// last receipt id.
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { serviceRoot } from '../../config.js';
import type { Config } from '../../config.js';
import type { Pool } from '../../db.js';
import { authenticateByHash, hashToken } from '../identity/index.js';
import type { AuthContext } from '../identity/index.js';
import { currentRevision } from '../intake/index.js';
import type { Registry } from '../registry/index.js';

export const PRODUCT_NAME = 'I Wish I Knew';

/** ADR-0002: the pilot may not be marketed as operator-excluded. */
export const TRUST_BOUNDARY_STATEMENT =
  'Pilot trust boundary (ADR-0002): evidence is stored sanitized and encrypted per organization, ' +
  'but service operators are inside the trust boundary during the pilot. ' +
  'Operator exclusion is a gate before the first real-member release, not a current guarantee.';

export const SESSION_COOKIE = 'iwik_session';
/** packages/service/views: shipped as files, not compiled, so src/ and dist/ share it. */
export const viewsDir = join(serviceRoot, 'views');

export interface ConsoleDeps {
  pool: Pool;
  config: Config;
  registry: Registry;
}

interface SessionView {
  org_name: string;
  node_id: string;
  accepted_runs: number;
  last_receipt_id: string | null;
}

async function sessionFromCookie(
  request: FastifyRequest,
  deps: ConsoleDeps,
): Promise<AuthContext | undefined> {
  const raw = request.cookies[SESSION_COOKIE];
  if (raw === undefined) return undefined;
  const unsigned = request.unsignCookie(raw);
  if (!unsigned.valid || unsigned.value === null) return undefined;
  return authenticateByHash(deps.pool, unsigned.value);
}

async function sessionView(auth: AuthContext, deps: ConsoleDeps): Promise<SessionView> {
  const runs = await deps.pool.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM evidence.runs WHERE org_ref = $1`,
    [auth.org_ref],
  );
  const receipt = await deps.pool.query<{ receipt_id: string }>(
    `SELECT receipt_id FROM evidence.receipts WHERE org_ref = $1
      ORDER BY issued_at DESC, receipt_id DESC LIMIT 1`,
    [auth.org_ref],
  );
  return {
    org_name: auth.org_name,
    node_id: auth.node_id,
    accepted_runs: Number(runs.rows[0]?.n ?? 0),
    last_receipt_id: receipt.rows[0]?.receipt_id ?? null,
  };
}

export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleDeps): void {
  app.get<{ Querystring: { login?: string } }>('/', async (request, reply) => {
    const auth = await sessionFromCookie(request, deps);
    const session = auth === undefined ? null : await sessionView(auth, deps);
    const revision = await currentRevision(deps.pool);
    return reply.view('index', {
      product: PRODUCT_NAME,
      trust_statement: TRUST_BOUNDARY_STATEMENT,
      evidence_revision: revision,
      protocols: deps.registry.list().map((e) => e.protocol.ref),
      intake_enabled: deps.config.featureIntake,
      session,
      login_failed: request.query.login === 'failed',
    });
  });

  app.post<{ Body: { token?: string } }>('/console/session', async (request, reply) => {
    const token = typeof request.body?.token === 'string' ? request.body.token.trim() : '';
    const auth = token === '' ? undefined : await authenticateByHash(deps.pool, hashToken(token));
    if (auth === undefined) {
      request.log.info('console sign-in failed');
      return reply.redirect('/?login=failed', 303);
    }
    reply.setCookie(SESSION_COOKIE, hashToken(token), {
      signed: true,
      httpOnly: true,
      sameSite: 'strict',
      secure: deps.config.production,
      path: '/',
      maxAge: 8 * 60 * 60,
    });
    request.log.info({ org_ref: auth.org_ref }, 'console sign-in');
    return reply.redirect('/', 303);
  });

  app.post('/console/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/', 303);
  });
}
