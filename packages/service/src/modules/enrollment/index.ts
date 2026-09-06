// Enrollment (stage 6, ADR-0002 / ADR-0006), behind IWIK_FEATURE_ENROLLMENT.
//
//   POST /v1/admin/organizations   operator token -> org + one-time invite URL
//   POST /v1/admin/organizations/:org_id/invites
//                                   operator token -> one-time reset invite for
//                                   an enrolled org (stage 11): new console
//                                   password, nodes and tokens untouched
//   GET|POST /enroll/:invite        accept the invite: display name, console
//                                   password, pilot terms (trust statement,
//                                   reciprocity) recorded with version + time;
//                                   a reset invite keeps the name read-only and
//                                   re-records the terms only if their version
//                                   changed
//   GET /org                        nodes and tokens of the signed-in org
//   POST /org/nodes                 register a node by its Ed25519 public key
//   POST /org/nodes/:id/tokens      issue a scoped token, shown exactly once
//   POST /org/nodes/:id/revoke      revoke a node (all its tokens stop)
//   POST /org/tokens/:id/revoke     revoke one token
//
// With the flag off every route above answers 404 through the standard
// envelope, before any authentication, so a probe learns nothing.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from '../../config.js';
import type { Pool } from '../../db.js';
import { withTransaction } from '../../db.js';
import { ApiError } from '../../errors.js';
import { ULID_PATTERN } from '../../ulid.js';
import { ORG_NAME_MAX_LENGTH, PRODUCT_NAME, TRUST_BOUNDARY_STATEMENT } from '../console/index.js';
import { requireEnrollment } from '../console/index.js';
import { csrfToken, requireCsrf, resolveSession, setSession } from '../console/session.js';
import {
  ALL_SCOPES,
  NameTakenError,
  audit,
  completeEnrollment,
  completeReset,
  createInvite,
  createNode,
  createOrganization,
  findOpenInvite,
  findOrganizationById,
  hasOpenInvite,
  isScope,
  issueNodeToken,
  latestAgreedTermsVersion,
  listNodes,
  normalizePublicKey,
  revokeNode,
  revokeToken,
} from '../identity/index.js';
import type { InviteKind, InviteRow, Scope } from '../identity/index.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword } from '../identity/password.js';
import { listOwnQueryReceipts } from '../aggregate/index.js';
import { REASON_CODES, listOwnRuns, orgRefOf } from '../withdrawal/index.js';

/** Bump when the wording of any clause below changes; agreements record it. */
export const PILOT_TERMS_VERSION = '2026-09-pilot-1';

export const PILOT_CLAUSES = {
  terms:
    'Pilot terms: this is a pilot deployment for measurable technical systems. Contributions are ' +
    'sanitized envelopes only (no free text, secrets, hostnames, or raw artifacts). Withdrawal takes ' +
    'effect at the next evidence revision; already delivered answers cannot be recalled; backups ' +
    'expire within 30 days.',
  trust_boundary: TRUST_BOUNDARY_STATEMENT,
  reciprocity:
    'Reciprocity (R11): members agree to contribute qualifying findings when reasonably possible. ' +
    'Contribution incentives never reward volume, favorable results, or disclosure of secrets.',
} as const;

export type Clause = keyof typeof PILOT_CLAUSES;
export const CLAUSE_IDS = Object.keys(PILOT_CLAUSES) as Clause[];

export interface EnrollmentDeps {
  pool: Pool;
  config: Config;
}

/** Operator token check: hash the presented bearer token and compare in constant time. */
export function operatorAuthorized(request: FastifyRequest, config: Config): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || config.operatorTokenHash === undefined) return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (match?.[1] === undefined) return false;
  const presented = createHash('sha256').update(match[1], 'utf8').digest();
  return timingSafeEqual(presented, config.operatorTokenHash);
}

function field(body: unknown, name: string, max: number): string {
  if (typeof body !== 'object' || body === null) return '';
  const value = (body as Record<string, unknown>)[name];
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function checked(body: unknown, name: string): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const value = (body as Record<string, unknown>)[name];
  return value === 'on' || value === 'true' || value === '1' || value === 'yes';
}

/** Scopes from checkbox fields `scope_query`, `scope_submit`, `scope_publish`. */
function requestedScopes(body: unknown): Scope[] {
  const out: Scope[] = [];
  if (typeof body !== 'object' || body === null) return out;
  const record = body as Record<string, unknown>;
  for (const scope of ALL_SCOPES) {
    if (checked(record, `scope_${scope}`)) out.push(scope);
  }
  // Also accept a repeated `scopes` field (multi-select), for non-checkbox clients.
  const listed = record['scopes'];
  for (const s of Array.isArray(listed) ? listed : [listed]) {
    if (isScope(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

export function validDisplayName(name: string): boolean {
  return name.length >= 2 && name.length <= ORG_NAME_MAX_LENGTH && !/[\p{Cc}]/u.test(name);
}

type EnrollError = 'name' | 'name_taken' | 'password' | 'password_match' | 'agree';

export function registerEnrollmentRoutes(app: FastifyInstance, deps: EnrollmentDeps): void {
  const { config, pool } = deps;
  const gate = requireEnrollment(config);
  const inviteUrl = (invite: string) => {
    const path = `/enroll/${invite}`;
    return config.publicUrl === undefined ? path : `${config.publicUrl}${path}`;
  };

  const notFoundPage = (reply: FastifyReply) =>
    reply.status(404).view('message', {
      product: PRODUCT_NAME,
      title: 'Invite not found',
      message:
        'This enrollment link is unknown, already used, or expired. Ask the operator for a new one.',
    });

  // --- operator bootstrap -------------------------------------------------

  app.post('/v1/admin/organizations', { preHandler: gate }, async (request, reply) => {
    if (!operatorAuthorized(request, config)) throw new ApiError(401, 'unauthorized');
    const body = request.body;
    const name =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>)['name']
        : undefined;
    if (typeof name !== 'string' || !validDisplayName(name.trim())) {
      throw new ApiError(422, 'validation_failed', {
        details: [{ path: '/name', rule: 'format' }],
      });
    }
    const created = await withTransaction(pool, async (client) => {
      const taken = await client.query(`SELECT 1 FROM identity.organizations WHERE name = $1`, [
        name.trim(),
      ]);
      if (taken.rows.length > 0) throw new ApiError(409, 'name_taken');
      const org = await createOrganization(client, name.trim());
      const invite = await createInvite(client, org.org_id, config.inviteTtlMs);
      await audit(client, 'org.invited', 'operator', `org:${org.org_id}`);
      return { org, invite };
    });
    request.log.info({ org_id: created.org.org_id }, 'organization invited');
    reply.status(201);
    return {
      org_id: created.org.org_id,
      invite_url: inviteUrl(created.invite.invite),
      expires_at: created.invite.expires_at.toISOString(),
    };
  });

  // Stage 11: re-invite an existing organization. An enrolled organization
  // gets a `reset` invite (new console password; nodes, tokens, and the
  // display name stay). An organization that never completed enrollment
  // (its enrollment invite expired) gets a fresh `enroll` invite instead:
  // there is no password to reset yet. Never a second organization row.
  app.post<{ Params: { org_id: string } }>(
    '/v1/admin/organizations/:org_id/invites',
    { preHandler: gate },
    async (request, reply) => {
      if (!operatorAuthorized(request, config)) throw new ApiError(401, 'unauthorized');
      const orgId = request.params.org_id;
      if (!ULID_PATTERN.test(orgId)) throw new ApiError(404, 'not_found');
      const created = await withTransaction(pool, async (client) => {
        // Lock the organization row so two concurrent re-invites cannot both
        // pass the open-invite check.
        const org = await client.query<{ enrolled: boolean }>(
          `SELECT enrolled_at IS NOT NULL AS enrolled FROM identity.organizations
            WHERE org_id = $1 FOR UPDATE`,
          [orgId],
        );
        const row = org.rows[0];
        if (row === undefined) throw new ApiError(404, 'not_found');
        if (await hasOpenInvite(client, orgId)) throw new ApiError(409, 'invite_exists');
        const kind: InviteKind = row.enrolled ? 'reset' : 'enroll';
        const invite = await createInvite(client, orgId, config.inviteTtlMs, kind);
        await audit(client, 'org.reinvited', 'operator', `org:${orgId}`);
        return invite;
      });
      request.log.info({ org_id: orgId, kind: created.kind }, 'organization re-invited');
      reply.status(201);
      return {
        org_id: orgId,
        kind: created.kind,
        invite_url: inviteUrl(created.invite),
        expires_at: created.expires_at.toISOString(),
      };
    },
  );

  // --- enrollment ---------------------------------------------------------

  interface EnrollView {
    /** `enroll`: first enrollment. `reset`: new password for an enrolled organization. */
    mode: InviteKind;
    display_name: string;
    /** Reset only: the pilot terms version changed since the last agreement, so it is asked again. */
    terms_changed: boolean;
    error: EnrollError | null;
  }

  const renderEnroll = (request: FastifyRequest, reply: FastifyReply, view: EnrollView) =>
    reply.view('enroll', {
      product: PRODUCT_NAME,
      terms_version: PILOT_TERMS_VERSION,
      clauses: PILOT_CLAUSES,
      password_min: PASSWORD_MIN_LENGTH,
      csrf: csrfToken(request, reply, config),
      ...view,
    });

  /** A reset invite asks for the terms again only when their version moved on. */
  const termsChanged = async (invite: InviteRow) =>
    invite.kind === 'reset' &&
    (await latestAgreedTermsVersion(pool, invite.org_id)) !== PILOT_TERMS_VERSION;

  app.get<{ Params: { invite: string } }>(
    '/enroll/:invite',
    { preHandler: gate },
    async (request, reply) => {
      const invite = await findOpenInvite(pool, request.params.invite);
      if (invite === undefined) return notFoundPage(reply);
      const org = await findOrganizationById(pool, invite.org_id);
      if (org === undefined) return notFoundPage(reply);
      return renderEnroll(request, reply, {
        mode: invite.kind,
        display_name: org.name,
        terms_changed: await termsChanged(invite),
        error: null,
      });
    },
  );

  app.post<{ Params: { invite: string } }>(
    '/enroll/:invite',
    { preHandler: gate },
    async (request, reply) => {
      requireCsrf(request, config);
      const invite = await findOpenInvite(pool, request.params.invite);
      if (invite === undefined) return notFoundPage(reply);
      if (invite.kind === 'reset') return acceptReset(request, reply, invite);
      const displayName = field(request.body, 'display_name', ORG_NAME_MAX_LENGTH + 1).trim();
      const password = field(request.body, 'password', PASSWORD_MAX_LENGTH + 1);
      const confirm = field(request.body, 'password_confirm', PASSWORD_MAX_LENGTH + 1);
      const agreed = CLAUSE_IDS.every((c) => checked(request.body, `agree_${c}`));
      const fail = (error: EnrollError) => {
        reply.status(400);
        return renderEnroll(request, reply, {
          mode: 'enroll',
          display_name: displayName,
          terms_changed: false,
          error,
        });
      };
      if (!validDisplayName(displayName)) return fail('name');
      if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
        return fail('password');
      }
      if (password !== confirm) return fail('password_match');
      if (!agreed) return fail('agree');

      let result;
      try {
        result = await completeEnrollment(pool, {
          invite,
          displayName,
          passwordHash: hashPassword(password),
          termsVersion: PILOT_TERMS_VERSION,
          clauses: CLAUSE_IDS,
        });
      } catch (err) {
        if (err instanceof NameTakenError) return fail('name_taken');
        if (err instanceof ApiError && err.status === 404) return notFoundPage(reply);
        throw err;
      }
      setSession(reply, config, {
        kind: 'org',
        login_id: result.login_id,
        org_id: result.org.org_id,
      });
      request.log.info({ org_id: result.org.org_id }, 'organization enrolled');
      return reply.redirect('/org?notice=enrolled', 303);
    },
  );

  // Stage 11: a reset invite sets a new console password for the existing
  // organization. The display name is not a form field (it is shown read-only
  // and any submitted value is ignored); nodes and tokens are untouched; the
  // pilot terms are asked again only when their version changed.
  async function acceptReset(request: FastifyRequest, reply: FastifyReply, invite: InviteRow) {
    const org = await findOrganizationById(pool, invite.org_id);
    if (org === undefined) return notFoundPage(reply);
    const changed = await termsChanged(invite);
    const password = field(request.body, 'password', PASSWORD_MAX_LENGTH + 1);
    const confirm = field(request.body, 'password_confirm', PASSWORD_MAX_LENGTH + 1);
    const agreed = !changed || CLAUSE_IDS.every((c) => checked(request.body, `agree_${c}`));
    const fail = (error: EnrollError) => {
      reply.status(400);
      return renderEnroll(request, reply, {
        mode: 'reset',
        display_name: org.name,
        terms_changed: changed,
        error,
      });
    };
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
      return fail('password');
    }
    if (password !== confirm) return fail('password_match');
    if (!agreed) return fail('agree');

    let result;
    try {
      result = await completeReset(pool, {
        invite,
        passwordHash: hashPassword(password),
        termsVersion: PILOT_TERMS_VERSION,
        clauses: CLAUSE_IDS,
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return notFoundPage(reply);
      throw err;
    }
    setSession(reply, config, {
      kind: 'org',
      login_id: result.login_id,
      org_id: result.org.org_id,
    });
    request.log.info(
      { org_id: result.org.org_id, agreement_recorded: result.agreement_recorded },
      'console password reset',
    );
    return reply.redirect('/org?notice=password_reset', 303);
  }

  // --- organization console ----------------------------------------------

  type OrgSession = { login_id: string; org_id: string; org_name: string };

  async function orgSession(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<OrgSession | undefined> {
    const session = await resolveSession(request, config, pool);
    if (session?.kind !== 'org') {
      reply.redirect('/console/login', 303);
      return undefined;
    }
    return session;
  }

  interface OrgPageExtras {
    issued?: { token: string; token_id: string; node_id: string; scopes: Scope[] };
    notice?: string;
    error?: string;
  }

  async function renderOrg(
    request: FastifyRequest,
    reply: FastifyReply,
    session: OrgSession,
    extras: OrgPageExtras = {},
  ) {
    const nodes = await listNodes(pool, session.org_id);
    const orgRef = await orgRefOf(pool, session.org_id);
    const runs = orgRef === undefined ? [] : await listOwnRuns(pool, orgRef);
    // Stage 9: the organization's own query receipts, each linking to /receipts/<id>.
    const receipts = orgRef === undefined ? [] : await listOwnQueryReceipts(pool, orgRef);
    return reply.view('org', {
      receipts: receipts.map((r) => ({ ...r, issued_at: r.issued_at.toISOString() })),
      product: PRODUCT_NAME,
      org_name: session.org_name,
      csrf: csrfToken(request, reply, config),
      scopes: ALL_SCOPES,
      service_url: config.publicUrl ?? '<service origin>',
      // Stage 7: own runs and the withdraw form (hidden while the flag is off).
      withdrawal_enabled: config.featureWithdrawal,
      reason_codes: REASON_CODES,
      runs: runs.map((r) => ({
        ...r,
        received_at: r.received_at.toISOString(),
        withdrawn_at: r.withdrawn_at?.toISOString() ?? null,
      })),
      nodes: nodes.map((n) => ({
        ...n,
        created_at: n.created_at.toISOString(),
        revoked_at: n.revoked_at?.toISOString() ?? null,
        tokens: n.tokens.map((t) => ({
          ...t,
          created_at: t.created_at.toISOString(),
          revoked_at: t.revoked_at?.toISOString() ?? null,
        })),
      })),
      issued: extras.issued ?? null,
      notice: extras.notice ?? null,
      error: extras.error ?? null,
    });
  }

  const NOTICES = new Set([
    'enrolled',
    'password_reset',
    'node_registered',
    'node_revoked',
    'token_revoked',
    'nothing_to_revoke',
    'withdrawn',
    'already_withdrawn',
  ]);
  const ERRORS = new Set([
    'pubkey',
    'pubkey_exists',
    'scopes',
    'node_unknown',
    'node_revoked',
    'withdraw_runs',
    'withdraw_reason',
    'withdraw_confirm',
  ]);

  app.get<{ Querystring: { notice?: string; error?: string } }>(
    '/org',
    { preHandler: gate },
    async (request, reply) => {
      const session = await orgSession(request, reply);
      if (session === undefined) return reply;
      const extras: OrgPageExtras = {};
      if (request.query.notice !== undefined && NOTICES.has(request.query.notice)) {
        extras.notice = request.query.notice;
      }
      if (request.query.error !== undefined && ERRORS.has(request.query.error)) {
        extras.error = request.query.error;
      }
      return renderOrg(request, reply, session, extras);
    },
  );

  app.post('/org/nodes', { preHandler: gate }, async (request, reply) => {
    requireCsrf(request, config);
    const session = await orgSession(request, reply);
    if (session === undefined) return reply;
    let pubkey: string;
    try {
      pubkey = normalizePublicKey(field(request.body, 'pubkey', 4096));
    } catch {
      request.log.info('node registration rejected: public key unparseable');
      return reply.redirect('/org?error=pubkey', 303);
    }
    const nodeId = await withTransaction(pool, async (client) => {
      const dup = await client.query(
        `SELECT 1 FROM identity.nodes WHERE org_id = $1 AND pubkey = $2 AND revoked_at IS NULL`,
        [session.org_id, pubkey],
      );
      if (dup.rows.length > 0) return undefined;
      const id = await createNode(client, session.org_id, pubkey);
      await audit(client, 'node.registered', `login:${session.login_id}`, `node:${id}`);
      return id;
    });
    if (nodeId === undefined) return reply.redirect('/org?error=pubkey_exists', 303);
    request.log.info({ node_id: nodeId }, 'node registered');
    return reply.redirect('/org?notice=node_registered', 303);
  });

  app.post<{ Params: { node_id: string } }>(
    '/org/nodes/:node_id/tokens',
    { preHandler: gate },
    async (request, reply) => {
      requireCsrf(request, config);
      const session = await orgSession(request, reply);
      if (session === undefined) return reply;
      const nodeId = request.params.node_id;
      const scopes = requestedScopes(request.body);
      if (scopes.length === 0) return reply.redirect('/org?error=scopes', 303);
      const node = ULID_PATTERN.test(nodeId)
        ? await pool.query<{ revoked: boolean }>(
            `SELECT revoked_at IS NOT NULL AS revoked FROM identity.nodes
              WHERE node_id = $1 AND org_id = $2`,
            [nodeId, session.org_id],
          )
        : undefined;
      const row = node?.rows[0];
      if (row === undefined) return reply.redirect('/org?error=node_unknown', 303);
      if (row.revoked) return reply.redirect('/org?error=node_revoked', 303);
      const issued = await withTransaction(pool, async (client) => {
        const t = await issueNodeToken(client, nodeId, scopes);
        await audit(client, 'token.issued', `login:${session.login_id}`, `token:${t.token_id}`);
        return t;
      });
      request.log.info({ node_id: nodeId, token_id: issued.token_id, scopes }, 'token issued');
      // Rendered directly (no redirect): the plaintext exists only in this
      // response and in the caller's clipboard. Nothing stores it.
      reply.header('cache-control', 'no-store');
      return renderOrg(request, reply, session, {
        issued: { token: issued.token, token_id: issued.token_id, node_id: nodeId, scopes },
      });
    },
  );

  app.post<{ Params: { node_id: string } }>(
    '/org/nodes/:node_id/revoke',
    { preHandler: gate },
    async (request, reply) => {
      requireCsrf(request, config);
      const session = await orgSession(request, reply);
      if (session === undefined) return reply;
      const nodeId = request.params.node_id;
      if (!ULID_PATTERN.test(nodeId)) return reply.redirect('/org?error=node_unknown', 303);
      const done = await withTransaction(pool, async (client) => {
        const ok = await revokeNode(client, session.org_id, nodeId);
        if (ok) await audit(client, 'node.revoked', `login:${session.login_id}`, `node:${nodeId}`);
        return ok;
      });
      if (done) request.log.info({ node_id: nodeId }, 'node revoked');
      return reply.redirect(
        done ? '/org?notice=node_revoked' : '/org?notice=nothing_to_revoke',
        303,
      );
    },
  );

  app.post<{ Params: { token_id: string } }>(
    '/org/tokens/:token_id/revoke',
    { preHandler: gate },
    async (request, reply) => {
      requireCsrf(request, config);
      const session = await orgSession(request, reply);
      if (session === undefined) return reply;
      const tokenId = request.params.token_id;
      if (!/^[A-Za-z0-9_]{1,64}$/.test(tokenId)) {
        return reply.redirect('/org?notice=nothing_to_revoke', 303);
      }
      const done = await withTransaction(pool, async (client) => {
        const ok = await revokeToken(client, session.org_id, tokenId);
        if (ok)
          await audit(client, 'token.revoked', `login:${session.login_id}`, `token:${tokenId}`);
        return ok;
      });
      if (done) request.log.info({ token_id: tokenId }, 'token revoked');
      return reply.redirect(
        done ? '/org?notice=token_revoked' : '/org?notice=nothing_to_revoke',
        303,
      );
    },
  );
}
