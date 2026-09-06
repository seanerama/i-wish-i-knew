// Aggregate (architecture.md: versioned calculations, cohort thresholds,
// suppression, receipts). Stage 5 ships only the honest stub of
// `POST /v1/evidence/query` (contracts/member-api.md): the request shape is
// validated, the caller needs scope `query`, and the answer is an
// `AnswerReceipt` with `status: insufficient_evidence` and
// `suppression_reasons: ["no_cooperative_evidence"]`, persisted as a receipt
// of kind `query` so `GET /v1/receipts/{id}` re-reads it. There is no
// matching or aggregation here: the commons is empty until phase 4 lands, and
// this endpoint says so rather than pretending.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AnswerReceipt, ContextValue } from '@iwik/contracts';
import { canonicalize, validate } from '@iwik/contracts';
import type { Pool } from '../../db.js';
import { ApiError } from '../../errors.js';
import type { ErrorDetail } from '../../errors.js';
import { ulid } from '../../ulid.js';
import { requireScope } from '../identity/index.js';
import { currentRevision } from '../intake/index.js';
import type { Registry } from '../registry/index.js';

export interface AggregateDeps {
  pool: Pool;
  registry: Registry;
}

/** Versions stamped on every receipt this stub issues. */
export const CALCULATION_VERSION = 'no-cooperative-evidence/0';
export const POLICY_VERSION = 'pilot-disclosure/1';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PROTOCOL_REF_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/;

export interface QueryRequest {
  protocol_ref: string;
  investigation_id?: string;
  context_filters: Record<string, ContextValue>;
  as_of_revision?: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isScalar(value: unknown): value is ContextValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** Validate the query body; issues carry paths and rules only. */
export function parseQueryRequest(body: unknown): QueryRequest {
  const issues: ErrorDetail[] = [];
  if (!isObject(body)) {
    throw new ApiError(422, 'validation_failed', { details: [{ path: '', rule: 'type' }] });
  }
  const known = new Set(['protocol_ref', 'investigation_id', 'context_filters', 'as_of_revision']);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ path: '', rule: 'additionalProperties' });
  }
  const ref = body['protocol_ref'];
  if (typeof ref !== 'string') issues.push({ path: '/protocol_ref', rule: 'required' });
  else if (!PROTOCOL_REF_RE.test(ref)) issues.push({ path: '/protocol_ref', rule: 'pattern' });
  const investigation = body['investigation_id'];
  if (investigation !== undefined) {
    if (typeof investigation !== 'string' || !ULID_RE.test(investigation)) {
      issues.push({ path: '/investigation_id', rule: 'pattern' });
    }
  }
  const filters: Record<string, ContextValue> = {};
  const rawFilters = body['context_filters'];
  if (rawFilters !== undefined) {
    if (!isObject(rawFilters)) {
      issues.push({ path: '/context_filters', rule: 'type' });
    } else {
      for (const [key, value] of Object.entries(rawFilters)) {
        if (!isScalar(value)) {
          // The key is the submitter's; the path names it as a pointer segment
          // only, the way ContextField errors do.
          issues.push({
            path: `/context_filters/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`,
            rule: 'type',
          });
        } else {
          filters[key] = value;
        }
      }
    }
  }
  const revision = body['as_of_revision'];
  if (revision !== undefined && (!Number.isInteger(revision) || (revision as number) < 0)) {
    issues.push({ path: '/as_of_revision', rule: 'minimum' });
  }
  if (issues.length > 0) throw new ApiError(422, 'validation_failed', { details: issues });
  const request: QueryRequest = { protocol_ref: ref as string, context_filters: filters };
  if (typeof investigation === 'string') request.investigation_id = investigation;
  if (typeof revision === 'number') request.as_of_revision = revision;
  return request;
}

/** SHA-256 over the JCS form of the normalized query: the receipt's `query_digest`. */
export function queryDigest(query: QueryRequest): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(query), 'utf8').digest('hex');
}

interface ReceiptRow {
  receipt_id: string;
  evidence_revision: string | number;
  issued_at: Date;
}

export function registerAggregateRoutes(app: FastifyInstance, deps: AggregateDeps): void {
  app.post('/v1/evidence/query', { preHandler: requireScope('query') }, async (request) => {
    const auth = request.auth;
    if (auth === undefined) throw new ApiError(401, 'unauthorized');
    const query = parseQueryRequest(request.body);
    if (deps.registry.get(query.protocol_ref) === undefined) {
      throw new ApiError(422, 'validation_failed', {
        details: [{ path: '/protocol_ref', rule: 'protocol_unknown' }],
      });
    }

    // Honest and minimal: no cohort exists yet, so nothing is matched and
    // nothing is released. The receipt records that at the current revision.
    const receiptId = ulid();
    const revision = await currentRevision(deps.pool);
    const payload = {
      query_digest: queryDigest(query),
      cohort: {
        protocol_ref: query.protocol_ref,
        filters: query.context_filters,
        orgs: '<3',
        runs: '<5',
      },
      calculation_version: CALCULATION_VERSION,
      policy_version: POLICY_VERSION,
      suppression_reasons: ['no_cooperative_evidence'],
    };
    const inserted = await deps.pool.query<ReceiptRow>(
      `INSERT INTO evidence.receipts (receipt_id, org_ref, kind, status, payload, evidence_revision)
       VALUES ($1, $2, 'query', 'insufficient_evidence', $3, $4)
       RETURNING receipt_id, evidence_revision, issued_at`,
      [receiptId, auth.org_ref, JSON.stringify(payload), revision],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('receipt insert returned no row');
    const receipt: AnswerReceipt = {
      receipt_id: row.receipt_id,
      query_digest: payload.query_digest,
      status: 'insufficient_evidence',
      cohort: payload.cohort,
      calculation_version: CALCULATION_VERSION,
      policy_version: POLICY_VERSION,
      evidence_revision: Number(row.evidence_revision),
      suppression_reasons: ['no_cooperative_evidence'],
      issued_at: row.issued_at.toISOString(),
    };
    const check = validate('AnswerReceipt', receipt);
    if (!check.ok) throw new Error('assembled receipt is not a valid AnswerReceipt');
    request.log.info({ receipt_id: receiptId, protocol_ref: query.protocol_ref }, 'query answered');
    return receipt;
  });
}
