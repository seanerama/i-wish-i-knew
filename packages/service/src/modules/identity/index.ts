// Identity (ADR-0006): organizations, nodes, hashed bearer tokens with scopes.
// Stage 2 seeds one organization and node from the environment; stage 6
// replaces the seed with enrollment. The evidence schema never sees org_id,
// only the opaque org_ref minted here.
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

export async function issueToken(
  db: Queryable,
  nodeId: string,
  scopes: readonly Scope[],
  token: string = randomBytes(32).toString('base64url'),
): Promise<string> {
  await db.query(
    `INSERT INTO identity.tokens (token_hash, node_id, scopes) VALUES ($1, $2, $3)
     ON CONFLICT (token_hash) DO NOTHING`,
    [hashToken(token), nodeId, [...scopes]],
  );
  return token;
}

/** Resolve a token hash to its node and organization; undefined when unknown or revoked. */
export async function authenticateByHash(
  db: Queryable,
  tokenHash: string,
): Promise<AuthContext | undefined> {
  const res = await db.query<AuthContext>(
    `SELECT n.node_id, n.org_id, r.org_ref, o.name AS org_name, t.scopes, n.pubkey
       FROM identity.tokens t
       JOIN identity.nodes n USING (node_id)
       JOIN identity.organizations o USING (org_id)
       JOIN identity.org_refs r USING (org_id)
      WHERE t.token_hash = $1 AND t.revoked_at IS NULL AND n.revoked_at IS NULL`,
    [tokenHash],
  );
  return res.rows[0];
}

export async function authenticate(db: Queryable, token: string): Promise<AuthContext | undefined> {
  return authenticateByHash(db, hashToken(token));
}

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
  app.addHook('onRequest', async (request) => {
    request.auth = undefined;
    const token = bearerToken(request);
    if (token === undefined) return;
    const auth = await authenticate(pool, token);
    if (auth !== undefined) {
      request.auth = auth;
      request.log = request.log.child({ org_ref: auth.org_ref });
    }
  });
}

export function requireScope(
  scope: Scope,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request) => {
    if (request.auth === undefined) throw new ApiError(401, 'unauthorized');
    if (!request.auth.scopes.includes(scope)) throw scopeRequired(scope);
  };
}
