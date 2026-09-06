// Intake (contracts/member-api.md): preview, submit, read back own runs and
// receipts. A submitted Run is validated against the frozen envelope,
// rescanned for secrets, checked against the registry, bound to a preview,
// signature-verified, stored encrypted under the organization's data key,
// and answered with an intake receipt. Idempotent on run_id.
import { createHash, verify as verifySig } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Run } from '@iwik/contracts';
import { canonicalize, validate } from '@iwik/contracts';
import type { Config } from '../../config.js';
import type { Pool, Queryable } from '../../db.js';
import { withTransaction } from '../../db.js';
import { ApiError } from '../../errors.js';
import type { ErrorDetail } from '../../errors.js';
import { ulid } from '../../ulid.js';
import type { Envelope } from '../crypto/index.js';
import { SHARING_BACKFILL_VERSION } from '../jobs/handlers.js';
import type { AuthContext } from '../identity/index.js';
import { nodeIsRevoked, parsePublicKey, requireScope } from '../identity/index.js';
import type { Registry } from '../registry/index.js';
import { sanitizeValue } from './sanitize.js';
import type { SanitizationReport } from './sanitize.js';

export interface IntakeDeps {
  pool: Pool;
  envelope: Envelope;
  registry: Registry;
  config: Config;
}

export interface Receipt {
  receipt_id: string;
  kind: string;
  status: string;
  evidence_revision: number;
  issued_at: string;
  [key: string]: unknown;
}

/**
 * The bytes a node signs and the bytes intake digests: the JCS form of the
 * Run with `submission.signature` removed (and no `org_ref`, which is server
 * assigned). The content digest is therefore independent of the signature
 * and identical between preview and submit.
 */
export function signingPayload(run: Run): string {
  const body: Record<string, unknown> = { ...run };
  delete body['org_ref'];
  const unsigned: Record<string, unknown> = { ...run.submission };
  delete unsigned['signature'];
  body['submission'] = unsigned;
  return canonicalize(body);
}

export function contentDigest(run: Run): string {
  return 'sha256:' + createHash('sha256').update(signingPayload(run), 'utf8').digest('hex');
}

export function verifyRunSignature(run: Run, pubkey: string): boolean {
  try {
    return verifySig(
      null,
      Buffer.from(signingPayload(run), 'utf8'),
      parsePublicKey(pubkey),
      Buffer.from(run.submission.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/** Fixture targets are never shared with a cooperative cohort (ADR-0003). */
export function effectiveSharingPolicy(run: Run): Run['submission']['sharing_policy'] {
  return run.target.kind === 'fixture' ? 'private' : run.submission.sharing_policy;
}

interface Checked {
  run: Run;
  report: SanitizationReport;
  sharing_policy: Run['submission']['sharing_policy'];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every 422 the intake can raise, in order: envelope, sanitization, registry, identity. */
export function checkRun(candidate: unknown, auth: AuthContext, deps: IntakeDeps): Checked {
  if (!isObject(candidate)) {
    throw new ApiError(422, 'validation_failed', { details: [{ path: '/run', rule: 'type' }] });
  }
  const issues: ErrorDetail[] = [];
  const validation = validate('Run', candidate);
  issues.push(...validation.errors);
  if ('org_ref' in candidate) issues.push({ path: '/org_ref', rule: 'server_assigned' });

  const { issues: sanitizeIssues, report } = sanitizeValue(candidate, {
    maxStringLength: deps.config.maxStringLength,
    extraPatterns: deps.config.extraSecretPatterns,
  });
  issues.push(...sanitizeIssues);
  if (issues.length > 0) throw new ApiError(422, 'validation_failed', { details: issues });

  const run = candidate as unknown as Run;
  const entry = deps.registry.get(run.protocol_ref);
  if (entry === undefined) {
    issues.push({ path: '/protocol_ref', rule: 'protocol_unknown' });
  } else {
    const protocol = entry.protocol;
    if (protocol.status !== 'accepted') {
      issues.push({ path: '/protocol_ref', rule: 'protocol_not_accepted' });
    }
    if (run.protocol_digest !== protocol.protocol_digest) {
      issues.push({ path: '/protocol_digest', rule: 'protocol_digest_mismatch' });
    }
    if (!protocol.compatibility.harness_digests.includes(run.harness_digest)) {
      issues.push({ path: '/harness_digest', rule: 'harness_digest_unknown' });
    }
    if (run.result_schema_digest !== protocol.result_schema_digest) {
      issues.push({ path: '/result_schema_digest', rule: 'result_schema_digest_mismatch' });
    }
    const present = new Set(run.context.map((field) => field.key));
    for (const key of protocol.required_context) {
      // The key name comes from the registry, not from the submission.
      if (!present.has(key))
        issues.push({ path: `/context/${key}`, rule: 'required_context_missing' });
    }
  }
  if (run.node_id !== auth.node_id) issues.push({ path: '/node_id', rule: 'node_mismatch' });
  if (issues.length > 0) throw new ApiError(422, 'validation_failed', { details: issues });

  return { run, report, sharing_policy: effectiveSharingPolicy(run) };
}

function requireAuth(request: FastifyRequest): AuthContext {
  if (request.auth === undefined) throw new ApiError(401, 'unauthorized');
  return request.auth;
}

interface ReceiptRow {
  receipt_id: string;
  kind: string;
  status: string;
  payload: Record<string, unknown>;
  evidence_revision: string | number;
  issued_at: Date;
}

function toReceipt(row: ReceiptRow): Receipt {
  return {
    receipt_id: row.receipt_id,
    kind: row.kind,
    status: row.status,
    ...row.payload,
    evidence_revision: Number(row.evidence_revision),
    issued_at: row.issued_at.toISOString(),
  };
}

async function findReceipt(
  db: Queryable,
  receiptId: string,
  orgRef: string,
): Promise<Receipt | undefined> {
  const res = await db.query<ReceiptRow>(
    `SELECT receipt_id, kind, status, payload, evidence_revision, issued_at
       FROM evidence.receipts WHERE receipt_id = $1 AND org_ref = $2`,
    [receiptId, orgRef],
  );
  const row = res.rows[0];
  return row === undefined ? undefined : toReceipt(row);
}

/** The latest evidence revision that touched a protocol (0 when none has). */
export async function latestRevisionFor(db: Queryable, protocolRef: string): Promise<number> {
  const res = await db.query<{ latest: string | number | null }>(
    `SELECT max(revision) AS latest FROM evidence.revision_log WHERE protocol_ref = $1`,
    [protocolRef],
  );
  return Number(res.rows[0]?.latest ?? 0);
}

/**
 * Staleness on read (stage 7, ADR-0002 §6): a query receipt pinned at an
 * evidence revision older than the latest revision that touched its
 * protocol (an accepted run or a withdrawal) reads `stale`. Nothing else
 * about the receipt changes and nothing says what moved. Intake receipts
 * record an acceptance and never go stale.
 */
export async function withStaleness(db: Queryable, receipt: Receipt): Promise<Receipt> {
  if (receipt.kind !== 'query') return receipt;
  const cohort = receipt['cohort'];
  const protocolRef =
    typeof cohort === 'object' && cohort !== null
      ? (cohort as Record<string, unknown>)['protocol_ref']
      : undefined;
  if (typeof protocolRef !== 'string') return receipt;
  const latest = await latestRevisionFor(db, protocolRef);
  return latest > receipt.evidence_revision ? { ...receipt, status: 'stale' } : receipt;
}

export async function currentRevision(db: Queryable): Promise<number> {
  const res = await db.query<{ revision: string | number }>(
    `SELECT revision FROM evidence.revision WHERE singleton`,
  );
  return Number(res.rows[0]?.revision ?? 0);
}

interface Stored {
  status: 200 | 201;
  receipt: Receipt;
}

async function storeRun(
  checked: Checked,
  digestValue: string,
  auth: AuthContext,
  deps: IntakeDeps,
): Promise<Stored> {
  const { run, sharing_policy } = checked;
  return withTransaction(deps.pool, async (client) => {
    // Serialize submitters of the same run_id on the revision row; the
    // singleton lock also orders the revision increments.
    await client.query(`SELECT revision FROM evidence.revision WHERE singleton FOR UPDATE`);
    // A node revoked after the auth hook ran (or between preview and submit)
    // never gets a signature accepted: checked inside the storing transaction.
    if (await nodeIsRevoked(client, auth.node_id)) throw new ApiError(401, 'node_revoked');
    const existing = await client.query<{
      org_ref: string;
      content_digest: string;
      receipt_id: string;
    }>(`SELECT org_ref, content_digest, receipt_id FROM evidence.runs WHERE run_id = $1`, [
      run.run_id,
    ]);
    const prior = existing.rows[0];
    if (prior !== undefined) {
      if (prior.org_ref === auth.org_ref && prior.content_digest === digestValue) {
        const receipt = await findReceipt(client, prior.receipt_id, auth.org_ref);
        if (receipt === undefined) throw new Error('receipt missing for stored run');
        return { status: 200, receipt };
      }
      throw new ApiError(409, 'run_conflict');
    }

    const bumped = await client.query<{ revision: string | number }>(
      `UPDATE evidence.revision SET revision = revision + 1, updated_at = now()
        WHERE singleton RETURNING revision`,
    );
    const revision = Number(bumped.rows[0]?.revision ?? 0);
    await client.query(
      `INSERT INTO evidence.revision_log (revision, protocol_ref, kind) VALUES ($1, $2, 'intake')`,
      [revision, run.protocol_ref],
    );

    const stored: Run = {
      ...run,
      org_ref: auth.org_ref,
      submission: { ...run.submission, sharing_policy },
    };
    const sealed = await deps.envelope.seal(
      auth.org_ref,
      Buffer.from(JSON.stringify(stored), 'utf8'),
    );

    const receiptId = ulid();
    const payload = {
      run_id: run.run_id,
      content_digest: digestValue,
      protocol_ref: run.protocol_ref,
      execution_status: run.execution_status,
      sharing_policy,
    };
    const inserted = await client.query<ReceiptRow>(
      `INSERT INTO evidence.receipts (receipt_id, org_ref, kind, status, payload, evidence_revision)
       VALUES ($1, $2, 'intake', 'accepted', $3, $4)
       RETURNING receipt_id, kind, status, payload, evidence_revision, issued_at`,
      [receiptId, auth.org_ref, JSON.stringify(payload), revision],
    );
    await client.query(
      `INSERT INTO evidence.runs
         (run_id, org_ref, protocol_ref, protocol_digest, harness_digest, execution_status,
          content_digest, body_ciphertext, key_id, receipt_id, evidence_revision,
          sharing_policy, backfill_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        run.run_id,
        auth.org_ref,
        run.protocol_ref,
        run.protocol_digest,
        run.harness_digest,
        run.execution_status,
        digestValue,
        sealed.ciphertext,
        sealed.key_id,
        receiptId,
        revision,
        sharing_policy,
        SHARING_BACKFILL_VERSION,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('receipt insert returned no row');
    return { status: 201, receipt: toReceipt(row) };
  });
}

export function registerIntakeRoutes(app: FastifyInstance, deps: IntakeDeps): void {
  const requireIntake = async (_request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!deps.config.featureIntake) throw new ApiError(503, 'feature_disabled');
  };

  app.post(
    '/v1/contributions/preview',
    { preHandler: [requireIntake, requireScope('submit')] },
    async (request) => {
      const auth = requireAuth(request);
      const body = isObject(request.body) ? request.body : {};
      const checked = checkRun(body['run'], auth, deps);
      const digestValue = contentDigest(checked.run);
      const previewId = ulid();
      const expiresAt = new Date(Date.now() + deps.config.previewTtlMs);
      await deps.pool.query(
        `INSERT INTO evidence.previews (preview_id, org_ref, content_digest, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [previewId, auth.org_ref, digestValue, expiresAt],
      );
      request.log.info({ preview_id: previewId }, 'preview issued');
      return {
        preview_id: previewId,
        content_digest: digestValue,
        expires_at: expiresAt.toISOString(),
        validation: { ok: true },
        sanitization: checked.report,
        would_store: {
          run_id: checked.run.run_id,
          protocol_ref: checked.run.protocol_ref,
          execution_status: checked.run.execution_status,
          target_kind: checked.run.target.kind,
          sharing_policy: checked.sharing_policy,
          encrypted: true,
        },
      };
    },
  );

  app.post(
    '/v1/runs',
    { preHandler: [requireIntake, requireScope('submit')] },
    async (request, reply) => {
      const auth = requireAuth(request);
      const body = isObject(request.body) ? request.body : {};
      const previewId = body['preview_id'];
      if (typeof previewId !== 'string' || previewId === '') {
        throw new ApiError(422, 'validation_failed', {
          details: [{ path: '/preview_id', rule: 'required' }],
        });
      }
      const checked = checkRun(body['run'], auth, deps);
      const digestValue = contentDigest(checked.run);

      const preview = await deps.pool.query<{ content_digest: string; expires_at: Date }>(
        `SELECT content_digest, expires_at FROM evidence.previews
          WHERE preview_id = $1 AND org_ref = $2`,
        [previewId, auth.org_ref],
      );
      const bound = preview.rows[0];
      if (bound === undefined) throw new ApiError(404, 'preview_not_found');
      if (bound.expires_at.getTime() < Date.now()) throw new ApiError(409, 'preview_expired');
      if (bound.content_digest !== digestValue) throw new ApiError(409, 'preview_mismatch');

      if (!verifyRunSignature(checked.run, auth.pubkey)) throw new ApiError(401, 'bad_signature');

      const stored = await storeRun(checked, digestValue, auth, deps);
      request.log.info(
        {
          run_id: checked.run.run_id,
          receipt_id: stored.receipt.receipt_id,
          status: stored.status,
        },
        stored.status === 201 ? 'run accepted' : 'run already accepted',
      );
      reply.status(stored.status);
      return stored.receipt;
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/receipts/:id',
    { preHandler: requireScope('query') },
    async (request) => {
      const auth = requireAuth(request);
      const receipt = await findReceipt(deps.pool, request.params.id, auth.org_ref);
      if (receipt === undefined) throw new ApiError(404, 'not_found');
      return withStaleness(deps.pool, receipt);
    },
  );

  app.get<{ Params: { run_id: string } }>(
    '/v1/runs/:run_id',
    { preHandler: requireScope('query') },
    async (request) => {
      const auth = requireAuth(request);
      const res = await deps.pool.query<{
        body_ciphertext: Buffer;
        key_id: string;
        receipt_id: string;
        evidence_revision: string | number;
        received_at: Date;
        withdrawn_at: Date | null;
        withdrawn_revision: string | number | null;
      }>(
        `SELECT body_ciphertext, key_id, receipt_id, evidence_revision, received_at,
                withdrawn_at, withdrawn_revision
           FROM evidence.runs WHERE run_id = $1 AND org_ref = $2`,
        [request.params.run_id, auth.org_ref],
      );
      const row = res.rows[0];
      if (row === undefined) throw new ApiError(404, 'not_found');
      const plaintext = await deps.envelope.open(auth.org_ref, row.key_id, row.body_ciphertext);
      return {
        run: JSON.parse(plaintext.toString('utf8')) as Run,
        receipt_id: row.receipt_id,
        evidence_revision: Number(row.evidence_revision),
        received_at: row.received_at.toISOString(),
        // Stage 7 (additive): present only once the run is withdrawn.
        ...(row.withdrawn_at !== null && row.withdrawn_revision !== null
          ? {
              withdrawn_at: row.withdrawn_at.toISOString(),
              withdrawn_revision: Number(row.withdrawn_revision),
            }
          : {}),
      };
    },
  );
}
