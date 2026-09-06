// Identity (ADR-0006): organizations, nodes, hashed bearer tokens with scopes.
// Stage 2 seeds one organization and node from the environment; stage 6 adds
// enrollment (invites, console logins, agreements, audit) behind
// IWIK_FEATURE_ENROLLMENT. The evidence schema never sees org_id, only the
// opaque org_ref minted here.
import { createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, Queryable } from '../../db.js';
import { withTransaction } from '../../db.js';
import { ApiError, scopeRequired } from '../../errors.js';
import { ulid } from '../../ulid.js';
import type { SeedIdentity } from '../../config.js';

export type Scope = 'query' | 'submit' | 'publish';
export const ALL_SCOPES: readonly Scope[] = ['query', 'submit', 'publish'];

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (ALL_SCOPES as readonly string[]).includes(value);
}

export interface AuthContext {
  node_id: string;
  org_id: string;
  org_ref: string;
  org_name: string;
  scopes: Scope[];
  pubkey: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | undefined;
    /** Set when a valid token was presented but its node is revoked (401 node_revoked). */
    nodeRevoked: boolean;
  }
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** Parse a node public key given as base64 raw 32 bytes or a PEM SPKI block. */
export function parsePublicKey(text: string): KeyObject {
  const trimmed = text.trim();
  if (trimmed.startsWith('-----BEGIN')) {
    const key = createPublicKey(trimmed);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('node key must be Ed25519');
    return key;
  }
  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 32) throw new Error('node public key must be 32 raw bytes (base64) or PEM');
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** Canonical stored form: base64 of the raw 32 bytes. */
export function normalizePublicKey(text: string): string {
  const key = parsePublicKey(text);
  const der = key.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32).toString('base64');
}

export interface OrganizationRow {
  org_id: string;
  org_ref: string;
  name: string;
}

export async function createOrganization(db: Queryable, name: string): Promise<OrganizationRow> {
  const org_id = ulid();
  const org_ref = randomBytes(16).toString('hex');
  await db.query(`INSERT INTO identity.organizations (org_id, name) VALUES ($1, $2)`, [
    org_id,
    name,
  ]);
  await db.query(`INSERT INTO identity.org_refs (org_id, org_ref) VALUES ($1, $2)`, [
    org_id,
    org_ref,
  ]);
  return { org_id, org_ref, name };
}

export async function findOrganizationByName(
  db: Queryable,
  name: string,
): Promise<OrganizationRow | undefined> {
  const res = await db.query<OrganizationRow>(
    `SELECT o.org_id, r.org_ref, o.name
       FROM identity.organizations o JOIN identity.org_refs r USING (org_id)
      WHERE o.name = $1`,
    [name],
  );
  return res.rows[0];
}

export async function findOrganizationById(
  db: Queryable,
  orgId: string,
): Promise<OrganizationRow | undefined> {
  const res = await db.query<OrganizationRow>(
    `SELECT o.org_id, r.org_ref, o.name
       FROM identity.organizations o JOIN identity.org_refs r USING (org_id)
      WHERE o.org_id = $1`,
    [orgId],
  );
  return res.rows[0];
}

export async function createNode(
  db: Queryable,
  orgId: string,
  pubkey: string,
  nodeId: string = ulid(),
): Promise<string> {
  await db.query(`INSERT INTO identity.nodes (node_id, org_id, pubkey) VALUES ($1, $2, $3)`, [
    nodeId,
    orgId,
    normalizePublicKey(pubkey),
  ]);
  return nodeId;
}

export interface IssuedToken {
  /** The plaintext token: returned once to the caller and never stored. */
  token: string;
  /** Public identifier used to name the token for revocation. */
  token_id: string;
}

/**
 * Store the SHA-256 of a token with its scopes. An existing hash (the seed
 * token re-applied at boot) is left untouched, including its token_id.
 */
export async function issueNodeToken(
  db: Queryable,
  nodeId: string,
  scopes: readonly Scope[],
  token: string = randomBytes(32).toString('base64url'),
): Promise<IssuedToken> {
  const tokenHash = hashToken(token);
  const tokenId = ulid();
  await db.query(
    `INSERT INTO identity.tokens (token_hash, node_id, scopes, token_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (token_hash) DO NOTHING`,
    [tokenHash, nodeId, [...scopes], tokenId],
  );
  const row = await db.query<{ token_id: string }>(
    `SELECT token_id FROM identity.tokens WHERE token_hash = $1`,
    [tokenHash],
  );
  return { token, token_id: row.rows[0]?.token_id ?? tokenId };
}

export async function issueToken(
  db: Queryable,
  nodeId: string,
  scopes: readonly Scope[],
  token?: string,
): Promise<string> {
  return (await issueNodeToken(db, nodeId, scopes, token)).token;
}

interface TokenLookup {
  auth: AuthContext;
  token_revoked: Date | null;
  node_revoked: Date | null;
}

async function lookupTokenByHash(
  db: Queryable,
  tokenHash: string,
): Promise<TokenLookup | undefined> {
  const res = await db.query<
    AuthContext & { token_revoked: Date | null; node_revoked: Date | null }
  >(
    `SELECT n.node_id, n.org_id, r.org_ref, o.name AS org_name, t.scopes, n.pubkey,
            t.revoked_at AS token_revoked, n.revoked_at AS node_revoked
       FROM identity.tokens t
       JOIN identity.nodes n USING (node_id)
       JOIN identity.organizations o USING (org_id)
       JOIN identity.org_refs r USING (org_id)
      WHERE t.token_hash = $1`,
    [tokenHash],
  );
  const row = res.rows[0];
  if (row === undefined) return undefined;
  const { token_revoked, node_revoked, ...auth } = row;
  return { auth, token_revoked, node_revoked };
}

export type AuthResult =
  | { kind: 'ok'; auth: AuthContext }
  | { kind: 'unknown' }
  | { kind: 'token_revoked' }
  | { kind: 'node_revoked' };

export async function resolveToken(db: Queryable, token: string): Promise<AuthResult> {
  const found = await lookupTokenByHash(db, hashToken(token));
  if (found === undefined) return { kind: 'unknown' };
  if (found.token_revoked !== null) return { kind: 'token_revoked' };
  if (found.node_revoked !== null) return { kind: 'node_revoked' };
  return { kind: 'ok', auth: found.auth };
}

/** Resolve a token hash to its node and organization; undefined when unknown or revoked. */
export async function authenticateByHash(
  db: Queryable,
  tokenHash: string,
): Promise<AuthContext | undefined> {
  const found = await lookupTokenByHash(db, tokenHash);
  if (found === undefined || found.token_revoked !== null || found.node_revoked !== null) {
    return undefined;
  }
  return found.auth;
}

export async function authenticate(db: Queryable, token: string): Promise<AuthContext | undefined> {
  return authenticateByHash(db, hashToken(token));
}

export async function nodeIsRevoked(db: Queryable, nodeId: string): Promise<boolean> {
  const res = await db.query<{ revoked: boolean }>(
    `SELECT revoked_at IS NOT NULL AS revoked FROM identity.nodes WHERE node_id = $1`,
    [nodeId],
  );
  return res.rows[0]?.revoked ?? true;
}

// ---------------------------------------------------------------------------
// Stage 6: nodes and tokens as the console sees them, revocation, audit.

export interface TokenView {
  token_id: string;
  scopes: Scope[];
  created_at: Date;
  revoked_at: Date | null;
}

export interface NodeView {
  node_id: string;
  pubkey: string;
  created_at: Date;
  revoked_at: Date | null;
  tokens: TokenView[];
}

export async function listNodes(db: Queryable, orgId: string): Promise<NodeView[]> {
  const nodes = await db.query<Omit<NodeView, 'tokens'>>(
    `SELECT node_id, pubkey, created_at, revoked_at FROM identity.nodes
      WHERE org_id = $1 ORDER BY created_at, node_id`,
    [orgId],
  );
  const tokens = await db.query<TokenView & { node_id: string }>(
    `SELECT t.token_id, t.node_id, t.scopes, t.created_at, t.revoked_at
       FROM identity.tokens t JOIN identity.nodes n USING (node_id)
      WHERE n.org_id = $1 ORDER BY t.created_at, t.token_id`,
    [orgId],
  );
  return nodes.rows.map((n) => ({
    ...n,
    tokens: tokens.rows.filter((t) => t.node_id === n.node_id).map(({ node_id: _node, ...t }) => t),
  }));
}

/** Revoke one of the organization's tokens; false when it is not theirs. */
export async function revokeToken(db: Queryable, orgId: string, tokenId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE identity.tokens t SET revoked_at = now()
       FROM identity.nodes n
      WHERE t.node_id = n.node_id AND n.org_id = $1 AND t.token_id = $2 AND t.revoked_at IS NULL`,
    [orgId, tokenId],
  );
  return (res.rowCount ?? 0) > 0;
}

/** Revoke one of the organization's nodes; every token behind it stops working. */
export async function revokeNode(db: Queryable, orgId: string, nodeId: string): Promise<boolean> {
  const res = await db.query(
    `UPDATE identity.nodes SET revoked_at = now()
      WHERE org_id = $1 AND node_id = $2 AND revoked_at IS NULL`,
    [orgId, nodeId],
  );
  return (res.rowCount ?? 0) > 0;
}

export type AuditEvent =
  | 'org.invited'
  | 'org.enrolled'
  | 'node.registered'
  | 'node.revoked'
  | 'token.issued'
  | 'token.revoked'
  | 'console.login';

/** Identifiers only: who (operator / login id) did what to which id. */
export async function audit(
  db: Queryable,
  event: AuditEvent,
  actor: string,
  target: string,
): Promise<void> {
  await db.query(
    `INSERT INTO identity.audit (audit_id, event, actor, target) VALUES ($1, $2, $3, $4)`,
    [ulid(), event, actor, target],
  );
}

// ---------------------------------------------------------------------------
// Stage 6: invites, console logins, agreements.

export interface InviteRow {
  invite_hash: string;
  org_id: string;
  expires_at: Date;
  accepted_at: Date | null;
}

/** Mint an invite for the organization; the plaintext is returned once. */
export async function createInvite(
  db: Queryable,
  orgId: string,
  ttlMs: number,
): Promise<{ invite: string; expires_at: Date }> {
  const invite = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlMs);
  await db.query(
    `INSERT INTO identity.invites (invite_hash, org_id, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(invite), orgId, expiresAt],
  );
  return { invite, expires_at: expiresAt };
}

/** The invite row when it exists, is unexpired, and is not yet accepted. */
export async function findOpenInvite(
  db: Queryable,
  invite: string,
): Promise<InviteRow | undefined> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(invite)) return undefined;
  const res = await db.query<InviteRow>(
    `SELECT invite_hash, org_id, expires_at, accepted_at FROM identity.invites
      WHERE invite_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
    [hashToken(invite)],
  );
  return res.rows[0];
}

export interface ConsoleLoginRow {
  login_id: string;
  org_id: string;
  password_hash: string;
}

export async function findConsoleLoginByOrgName(
  db: Queryable,
  orgName: string,
): Promise<ConsoleLoginRow | undefined> {
  const res = await db.query<ConsoleLoginRow>(
    `SELECT l.login_id, l.org_id, l.password_hash
       FROM identity.console_logins l JOIN identity.organizations o USING (org_id)
      WHERE o.name = $1 AND l.revoked_at IS NULL
      ORDER BY l.created_at DESC LIMIT 1`,
    [orgName],
  );
  return res.rows[0];
}

export async function findConsoleLogin(
  db: Queryable,
  loginId: string,
): Promise<(ConsoleLoginRow & { org_name: string }) | undefined> {
  const res = await db.query<ConsoleLoginRow & { org_name: string }>(
    `SELECT l.login_id, l.org_id, l.password_hash, o.name AS org_name
       FROM identity.console_logins l JOIN identity.organizations o USING (org_id)
      WHERE l.login_id = $1 AND l.revoked_at IS NULL`,
    [loginId],
  );
  return res.rows[0];
}

export interface EnrollmentInput {
  invite: InviteRow;
  displayName: string;
  passwordHash: string;
  termsVersion: string;
  clauses: readonly string[];
}

export class NameTakenError extends Error {
  override name = 'NameTakenError';
}

/**
 * Accept an invite in one transaction: set the display name, create the
 * console login, record the agreement, mark the invite accepted, audit.
 */
export async function completeEnrollment(
  pool: Pool,
  input: EnrollmentInput,
): Promise<{ login_id: string; org: OrganizationRow }> {
  return withTransaction(pool, async (client) => {
    const claimed = await client.query(
      `UPDATE identity.invites SET accepted_at = now()
        WHERE invite_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [input.invite.invite_hash],
    );
    if ((claimed.rowCount ?? 0) === 0) throw new ApiError(404, 'not_found');
    const taken = await client.query<{ org_id: string }>(
      `SELECT org_id FROM identity.organizations WHERE name = $1 AND org_id <> $2`,
      [input.displayName, input.invite.org_id],
    );
    if (taken.rows.length > 0) throw new NameTakenError('display name already in use');
    await client.query(
      `UPDATE identity.organizations SET name = $2, enrolled_at = now() WHERE org_id = $1`,
      [input.invite.org_id, input.displayName],
    );
    const loginId = ulid();
    await client.query(
      `INSERT INTO identity.console_logins (login_id, org_id, password_hash) VALUES ($1, $2, $3)`,
      [loginId, input.invite.org_id, input.passwordHash],
    );
    await client.query(
      `INSERT INTO identity.agreements (agreement_id, org_id, login_id, terms_version, clauses)
       VALUES ($1, $2, $3, $4, $5)`,
      [ulid(), input.invite.org_id, loginId, input.termsVersion, [...input.clauses]],
    );
    await audit(client, 'org.enrolled', `login:${loginId}`, `org:${input.invite.org_id}`);
    const org = await findOrganizationById(client, input.invite.org_id);
    if (org === undefined) throw new Error('organization vanished during enrollment');
    return { login_id: loginId, org };
  });
}

// ---------------------------------------------------------------------------

/**
 * Idempotently create the env-seeded organization, node, and token. Runs at
 * every boot; a second boot finds the rows and changes nothing.
 */
export async function seedIdentity(
  pool: Pool,
  seed: SeedIdentity,
): Promise<{ org: OrganizationRow; node_id: string }> {
  return withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [7241865325823965]);
    const org =
      (await findOrganizationByName(client, seed.org)) ??
      (await createOrganization(client, seed.org));
    const pubkey = normalizePublicKey(seed.nodePubkey);
    let nodeId: string | undefined;
    if (seed.nodeId !== undefined) {
      const byId = await client.query<{ node_id: string; pubkey: string; org_id: string }>(
        `SELECT node_id, pubkey, org_id FROM identity.nodes WHERE node_id = $1`,
        [seed.nodeId],
      );
      const row = byId.rows[0];
      if (row !== undefined) {
        if (row.org_id !== org.org_id)
          throw new Error('IWIK_SEED_NODE_ID belongs to another organization');
        if (!timingSafeEqual(Buffer.from(row.pubkey), Buffer.from(pubkey))) {
          throw new Error('IWIK_SEED_NODE_ID exists with a different public key');
        }
        nodeId = row.node_id;
      }
    } else {
      const byKey = await client.query<{ node_id: string }>(
        `SELECT node_id FROM identity.nodes WHERE org_id = $1 AND pubkey = $2 AND revoked_at IS NULL
          ORDER BY created_at LIMIT 1`,
        [org.org_id, pubkey],
      );
      nodeId = byKey.rows[0]?.node_id;
    }
    if (nodeId === undefined) {
      nodeId = await createNode(client, org.org_id, pubkey, seed.nodeId ?? ulid());
    }
    await issueToken(client, nodeId, ALL_SCOPES, seed.nodeToken);
    return { org, node_id: nodeId };
  });
}

function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

/** Decorate requests with `auth` and expose `requireScope(scope)` pre-handlers. */
export function registerIdentity(app: FastifyInstance, pool: Pool): void {
  app.decorateRequest('auth', undefined);
  app.decorateRequest('nodeRevoked', false);
  app.addHook('onRequest', async (request) => {
    request.auth = undefined;
    request.nodeRevoked = false;
    const token = bearerToken(request);
    if (token === undefined) return;
    const result = await resolveToken(pool, token);
    if (result.kind === 'ok') {
      request.auth = result.auth;
      request.log = request.log.child({ org_ref: result.auth.org_ref });
    } else if (result.kind === 'node_revoked') {
      request.nodeRevoked = true;
    }
  });
}

export function requireScope(
  scope: Scope,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request) => {
    if (request.nodeRevoked) throw new ApiError(401, 'node_revoked');
    if (request.auth === undefined) throw new ApiError(401, 'unauthorized');
    if (!request.auth.scopes.includes(scope)) throw scopeRequired(scope);
  };
}
