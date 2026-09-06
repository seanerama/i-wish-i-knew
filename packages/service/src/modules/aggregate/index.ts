// Aggregate (architecture.md: versioned calculations, cohort thresholds,
// suppression, receipts): `POST /v1/evidence/query` (contracts/member-api.md).
//
// Stage 5 shipped the honest stub: a validated request, scope `query`, and
// an `AnswerReceipt` with `status: insufficient_evidence` and
// `suppression_reasons: ["no_cooperative_evidence"]`, persisted as a receipt
// of kind `query`. That path is unchanged and remains the answer while
// IWIK_FEATURE_COOPERATIVE_QUERY is off (default).
//
// Stage 9, behind the flag, is the real thing:
//
//   1. hard compatibility and filters (modules/matching), pinned at
//      `as_of_revision` or the current revision; a withdrawn run is never a
//      candidate, pin or no pin (ADR-0002 §6), so a pinned answer whose
//      cohort no longer matches the release recorded at that revision says
//      so with a fixed limitation, or is suppressed as usual;
//   2. the answer cache keyed by (query_digest, revision), valid only while
//      the revision is the latest that touched the protocol (releases.ts);
//   3. on a miss: the candidate count first (zero -> insufficient_evidence;
//      above IWIK_QUERY_COHORT_CAP -> suppressed cohort_too_large, before any
//      body is opened), then exactly the cohort's bodies are decrypted and
//      reduced to samples; the calculation (calc.ts, latency-v1) and the
//      policy (policy.ts, 2026-09-p1) run over them;
//   4. a releasable cohort is checked against every prior release of the
//      protocol (differencing defence) under a per-protocol advisory lock,
//      recorded in evidence.cohort_releases as keyed member hashes, and
//      cached;
//   5. the receipt is persisted (kind query, so staleness applies on
//      re-read) and validated as an AnswerReceipt before it leaves.
//
// The requester's own runs for the protocol are always summarised in
// `result.own_evidence` (ids are the caller's), released or not. Bodies are
// never logged; log lines carry ids, bands, and reasons only.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  AnswerReceipt,
  ContextOrigin,
  ContextValue,
  OwnEvidence,
  ProtocolVersion,
  ReceiptResult,
  SuppressionReason,
} from '@iwik/contracts';
import { canonicalize, validate } from '@iwik/contracts';
import type { Config } from '../../config.js';
import type { Pool, Queryable } from '../../db.js';
import { withTransaction } from '../../db.js';
import { ApiError } from '../../errors.js';
import type { ErrorDetail } from '../../errors.js';
import { ulid } from '../../ulid.js';
import { ensureClaimsForReceipt, stampClaimIds } from '../challenge/claims.js';
import { contributorOf, orgRange, runRange } from '../cohort/index.js';
import type { CohortFilters } from '../cohort/index.js';
import type { Envelope } from '../crypto/index.js';
import { requireScope } from '../identity/index.js';
import { currentRevision } from '../intake/index.js';
import type { IndexContext } from '../intake/projection.js';
import { parseStoredRun } from '../jobs/handlers.js';
import {
  candidateContributors,
  checkFilterKeys,
  countCandidates,
  loadCandidates,
  rankCandidates,
} from '../matching/index.js';
import type { CandidateRow, MatchSpec } from '../matching/index.js';
import type { Registry } from '../registry/index.js';
import { CALCULATION_VERSION, compute, parseClaims, releaseSections } from './calc.js';
import type { Sample } from './calc.js';
import { ownEvidence } from './own.js';
import {
  POLICY_VERSION,
  cohortHashKey,
  differencingConflict,
  membersHash,
  orgHash,
  thresholdReasons,
} from './policy.js';
import {
  cacheKey,
  pinnedReleaseReproduced,
  priorMemberSets,
  readCachedOutcome,
  recordRelease,
  writeCachedOutcome,
} from './releases.js';
import type { CooperativeOutcome } from './releases.js';

export { CALCULATION_VERSION } from './calc.js';
export { POLICY_VERSION } from './policy.js';

/**
 * The fixed limitation a pinned answer carries when its cohort no longer
 * matches the release first recorded at the pinned revision (a withdrawal
 * since then). Never says what changed.
 */
export const PINNED_NOT_REPRODUCIBLE =
  'Pinned cohort no longer reproducible: contributions changed since the pinned revision.';

export interface AggregateDeps {
  pool: Pool;
  registry: Registry;
  config: Config;
  envelope: Envelope;
}

/** Versions stamped on every receipt the stage 5 stub issues (flag off). */
export const STUB_CALCULATION_VERSION = 'no-cooperative-evidence/0';
export const STUB_POLICY_VERSION = 'pilot-disclosure/1';

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

/** The persisted payload of a query receipt: everything but the row columns. */
interface QueryPayload {
  query_digest: string;
  cohort: AnswerReceipt['cohort'];
  calculation_version: string;
  policy_version: string;
  suppression_reasons?: SuppressionReason[];
  result?: ReceiptResult;
}

async function insertReceipt(
  db: Queryable,
  orgRef: string,
  status: AnswerReceipt['status'],
  payload: QueryPayload,
  revision: number,
): Promise<AnswerReceipt> {
  const receiptId = ulid();
  const inserted = await db.query<ReceiptRow>(
    `INSERT INTO evidence.receipts (receipt_id, org_ref, kind, status, payload, evidence_revision)
     VALUES ($1, $2, 'query', $3, $4, $5)
     RETURNING receipt_id, evidence_revision, issued_at`,
    [receiptId, orgRef, status, JSON.stringify(payload), revision],
  );
  const row = inserted.rows[0];
  if (row === undefined) throw new Error('receipt insert returned no row');
  const receipt: AnswerReceipt = {
    receipt_id: row.receipt_id,
    query_digest: payload.query_digest,
    status,
    cohort: payload.cohort,
    calculation_version: payload.calculation_version,
    policy_version: payload.policy_version,
    evidence_revision: Number(row.evidence_revision),
    ...(payload.result !== undefined ? { result: payload.result } : {}),
    ...(payload.suppression_reasons !== undefined
      ? { suppression_reasons: payload.suppression_reasons }
      : {}),
    issued_at: row.issued_at.toISOString(),
  };
  const check = validate('AnswerReceipt', receipt);
  if (!check.ok) throw new Error('assembled receipt is not a valid AnswerReceipt');
  return receipt;
}

// ---------------------------------------------------------------------------
// the stage 5 stub (flag off)

async function stubAnswer(deps: AggregateDeps, orgRef: string, query: QueryRequest) {
  // Honest and minimal: no cohort exists yet, so nothing is matched and
  // nothing is released. The receipt records that at the current revision.
  const revision = await currentRevision(deps.pool);
  return insertReceipt(
    deps.pool,
    orgRef,
    'insufficient_evidence',
    {
      query_digest: queryDigest(query),
      cohort: {
        protocol_ref: query.protocol_ref,
        filters: query.context_filters,
        orgs: '<3',
        runs: '<5',
      },
      calculation_version: STUB_CALCULATION_VERSION,
      policy_version: STUB_POLICY_VERSION,
      suppression_reasons: ['no_cooperative_evidence'],
    },
    revision,
  );
}

// ---------------------------------------------------------------------------
// the cooperative answer (flag on)

function originsOf(context: IndexContext): Record<string, ContextOrigin | undefined> {
  const out: Record<string, ContextOrigin | undefined> = {};
  for (const [key, field] of Object.entries(context)) out[key] = field.origin;
  return out;
}

/** Decrypt exactly these rows and reduce them to calculation samples. */
async function toSamples(envelope: Envelope, rows: readonly CandidateRow[]): Promise<Sample[]> {
  const units = contributorOf(rows);
  const samples: Sample[] = [];
  for (const row of rows) {
    const run = parseStoredRun(await envelope.open(row.org_ref, row.key_id, row.body_ciphertext));
    samples.push({
      org_ref: row.org_ref,
      contributor: units.get(row.org_ref) ?? row.org_ref,
      received_at: row.received_at,
      execution_status: row.execution_status,
      accounting: run.accounting,
      result: run.result,
      context_origin: originsOf(row.index_context),
    });
  }
  return samples;
}

interface Resolved {
  outcome: CooperativeOutcome;
  /** Set when the outcome is a release that still has to pass the differencing check. */
  release?: { member_org_hashes: string[]; org_count: number; run_count: number };
  cohort_formed: boolean;
}

async function resolveOutcome(
  deps: AggregateDeps,
  protocol: ProtocolVersion,
  claims: Record<string, unknown>,
  spec: MatchSpec,
  /** Whether the query pinned `as_of_revision` (the reproducibility check applies). */
  pinned: boolean,
  log: { info(obj: Record<string, unknown>, msg: string): void },
): Promise<Resolved> {
  const count = await countCandidates(deps.pool, spec);
  if (count === 0) {
    return {
      outcome: {
        status: 'insufficient_evidence',
        orgs: '<3',
        runs: '<5',
        suppression_reasons: ['no_cooperative_evidence'],
      },
      cohort_formed: false,
    };
  }
  if (count > deps.config.queryCohortCap) {
    // Decrypt-scope rule: never open more bodies than the cap. The bands come
    // from the plaintext index only; no body is even loaded.
    const units = contributorOf(await candidateContributors(deps.pool, spec));
    log.info({ protocol_ref: protocol.ref, runs: runRange(count) }, 'cohort above cap');
    return {
      outcome: {
        status: 'suppressed',
        orgs: orgRange(new Set([...units.values()]).size),
        runs: runRange(count),
        suppression_reasons: ['cohort_too_large'],
      },
      cohort_formed: false,
    };
  }
  const rows = rankCandidates(
    await loadCandidates(deps.pool, spec, deps.config.queryCohortCap),
    protocol.required_context,
    spec.filters,
  );
  const samples = await toSamples(deps.envelope, rows);
  const filterKeys = Object.keys(spec.filters);
  const computation = compute(
    samples,
    parseClaims(claims, protocol.permitted_claims),
    protocol.required_context,
    filterKeys,
  );
  const orgs = orgRange(computation.orgs);
  const runs = runRange(computation.runs);
  const reasons = thresholdReasons(computation);
  if (reasons.length > 0) {
    return {
      outcome: { status: 'suppressed', orgs, runs, suppression_reasons: reasons },
      cohort_formed: true,
    };
  }
  const key = cohortHashKey(deps.config.kek);
  const members = [...new Set(samples.map((s) => orgHash(key, s.org_ref)))].sort();
  const sections = releaseSections({
    computation,
    requiredContext: protocol.required_context,
    filterKeys,
  });
  if (pinned) {
    // A pin reproduces the release recorded at that revision only while its
    // members and runs are all still there (withdrawn runs never re-enter).
    const reproduced = await pinnedReleaseReproduced(
      deps.pool,
      protocol.ref,
      spec.filters,
      spec.revision,
      members,
      samples.length,
    );
    if (reproduced === false) {
      sections.limitations = [PINNED_NOT_REPRODUCIBLE, ...(sections.limitations ?? [])];
    }
  }
  return {
    outcome: { status: 'released', orgs, runs, sections },
    release: { member_org_hashes: members, org_count: members.length, run_count: samples.length },
    cohort_formed: true,
  };
}

async function cooperativeAnswer(
  deps: AggregateDeps,
  orgRef: string,
  query: QueryRequest,
  log: { info(obj: Record<string, unknown>, msg: string): void },
): Promise<AnswerReceipt> {
  const entry = deps.registry.get(query.protocol_ref);
  if (entry === undefined) throw new Error('protocol vanished from the registry');
  const protocol = entry.protocol;
  checkFilterKeys(query.context_filters, protocol);
  const current = await currentRevision(deps.pool);
  if (query.as_of_revision !== undefined && query.as_of_revision > current) {
    throw new ApiError(422, 'validation_failed', {
      details: [{ path: '/as_of_revision', rule: 'maximum' }],
    });
  }
  const revision = query.as_of_revision ?? current;
  const digest = queryDigest(query);
  const filters: CohortFilters = query.context_filters;
  const spec: MatchSpec = { protocol, filters, revision };
  const key = cacheKey(digest, revision);

  let resolved: Resolved | undefined;
  const cached = await readCachedOutcome(deps.pool, key, protocol.ref);
  if (cached !== undefined) {
    // Cached outcomes always come from a formed cohort (see the write below).
    resolved = { outcome: cached, cohort_formed: true };
  } else {
    resolved = await resolveOutcome(
      deps,
      protocol,
      entry.claims,
      spec,
      query.as_of_revision !== undefined,
      log,
    );
  }

  const own = await ownEvidence(deps.pool, {
    org_ref: orgRef,
    protocol,
    filters,
    revision,
    cohort_formed: resolved.cohort_formed,
  });

  const fromCache = cached !== undefined;
  return withTransaction(deps.pool, async (client) => {
    let outcome = resolved.outcome;
    let release = resolved.release;
    if (release !== undefined) {
      // One release decision per protocol at a time: the differencing check
      // and the release row commit together.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `cohort_release:${protocol.ref}`,
      ]);
      const priors = await priorMemberSets(client, protocol.ref);
      if (differencingConflict(priors, new Set(release.member_org_hashes))) {
        outcome = {
          status: 'suppressed',
          orgs: outcome.orgs,
          runs: outcome.runs,
          suppression_reasons: ['differencing'],
        };
        release = undefined;
      }
    }
    // Stage 10 (additive): every released finding becomes a Claim row for
    // this receipt (origin measured, corroboration unreplicated), and the
    // finding carries its claim_id so a challenge can name it. The ids are
    // minted per receipt: the cached outcome stays caller-free.
    const stamped =
      outcome.status === 'released' && outcome.sections !== undefined
        ? stampClaimIds(outcome.sections)
        : undefined;
    const issued = stamped === undefined ? outcome : { ...outcome, sections: stamped.sections };
    const receipt = await insertReceipt(
      client,
      orgRef,
      outcome.status,
      {
        query_digest: digest,
        cohort: { protocol_ref: protocol.ref, filters, orgs: outcome.orgs, runs: outcome.runs },
        calculation_version: CALCULATION_VERSION,
        policy_version: POLICY_VERSION,
        ...(outcome.suppression_reasons !== undefined
          ? { suppression_reasons: outcome.suppression_reasons }
          : {}),
        ...resultSection(issued, own),
      },
      revision,
    );
    if (stamped !== undefined) {
      await ensureClaimsForReceipt(
        client,
        {
          receipt_id: receipt.receipt_id,
          org_ref: orgRef,
          protocol_ref: protocol.ref,
          calculation_version: CALCULATION_VERSION,
          policy_version: POLICY_VERSION,
          evidence_revision: revision,
          cohort: { orgs: outcome.orgs, runs: outcome.runs },
          result: stamped.sections,
        },
        stamped.ids,
      );
    }
    if (release !== undefined) {
      await recordRelease(client, {
        query_digest: digest,
        protocol_ref: protocol.ref,
        filters,
        member_org_hashes: release.member_org_hashes,
        member_orgs_hash: membersHash(release.member_org_hashes),
        org_count: release.org_count,
        run_count: release.run_count,
        revision,
        receipt_id: receipt.receipt_id,
      });
    }
    // Only an outcome that decrypted a cohort is worth caching. The other two
    // (no candidates; more than IWIK_QUERY_COHORT_CAP of them) cost one count
    // and depend on a per-deployment setting, so they are recomputed.
    if (!fromCache && resolved.cohort_formed) {
      await writeCachedOutcome(client, key, protocol.ref, revision, outcome);
    }
    return receipt;
  });
}

/** `result` is present only when there is something to show the caller. */
function resultSection(outcome: CooperativeOutcome, own: OwnEvidence): { result?: ReceiptResult } {
  if (outcome.sections === undefined && own.runs.length === 0) return {};
  return { result: { ...(outcome.sections ?? {}), own_evidence: own } };
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
    const receipt = deps.config.featureCooperativeQuery
      ? await cooperativeAnswer(deps, auth.org_ref, query, request.log)
      : await stubAnswer(deps, auth.org_ref, query);
    request.log.info(
      {
        receipt_id: receipt.receipt_id,
        protocol_ref: query.protocol_ref,
        status: receipt.status,
        orgs: receipt.cohort.orgs,
        runs: receipt.cohort.runs,
        reasons: receipt.suppression_reasons ?? [],
      },
      'query answered',
    );
    return receipt;
  });
}

export interface OwnReceiptSummary {
  receipt_id: string;
  status: string;
  protocol_ref: string | null;
  evidence_revision: number;
  issued_at: Date;
}

/** The organization's own query receipts, newest first (console). */
export async function listOwnQueryReceipts(
  db: Queryable,
  orgRef: string,
  limit = 50,
): Promise<OwnReceiptSummary[]> {
  const res = await db.query<{
    receipt_id: string;
    status: string;
    protocol_ref: string | null;
    evidence_revision: string | number;
    issued_at: Date;
  }>(
    `SELECT receipt_id, status, payload #>> '{cohort,protocol_ref}' AS protocol_ref,
            evidence_revision, issued_at
       FROM evidence.receipts
      WHERE org_ref = $1 AND kind = 'query'
      ORDER BY issued_at DESC, receipt_id DESC
      LIMIT $2`,
    [orgRef, limit],
  );
  return res.rows.map((r) => ({ ...r, evidence_revision: Number(r.evidence_revision) }));
}
