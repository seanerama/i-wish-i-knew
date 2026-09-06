// Matching (stage 9; ADR-0003 "hard compatibility first, then rank by soft
// similarity", brief §4 "Evidence, matching, and explanation").
//
// Hard compatibility decides who is a candidate; nothing after it can admit
// a run. A candidate is a run that
//   - carries the queried `protocol_ref` (pack/name@major: same major),
//   - executed with a harness digest the protocol's `compatibility` lists,
//   - is accepted and countable: trusted index projection
//     (`index_version` set), not a fixture target, not a same-organization
//     duplicate, `sharing_policy = cooperative` (a private run is the
//     member's own and never joins a cohort), execution status succeeded or
//     failed (excluded / unobserved runs are accounting, never evidence),
//   - matches every `context_filters` key exactly in its plaintext index
//     projection (`index_context @> filter`), and
//   - exists at the pinned evidence revision: accepted at or before it and
//     not withdrawn at or before it (`as_of_revision`; the current revision
//     when the query does not pin one).
// Only the protocol's `required_context` keys are projected, so only they
// can filter: any other key is `422 not_indexed`, as the stage 8 operator
// endpoint answers.
//
// Soft ranking orders the candidates by the origin quality of the required
// keys the caller did NOT filter on (measured / operator_reported >
// provider_reported > unknown). It is an ordering over compatible runs and
// nothing else: it never admits an incompatible run and never drops a
// compatible one.
//
// Nothing here decrypts. Candidate rows carry the ciphertext so the query
// path can open exactly the cohort's bodies and no more (decrypt-scope rule).
import type { ContextOrigin, ContextValue, ProtocolVersion } from '@iwik/contracts';
import type { Queryable } from '../../db.js';
import { ApiError } from '../../errors.js';
import type { ErrorDetail } from '../../errors.js';
import { containmentFilter } from '../cohort/index.js';
import type { CohortFilters, ContributorRow } from '../cohort/index.js';
import type { IndexContext } from '../intake/projection.js';

/** Execution statuses that can carry evidence (claims.json "excludes"). */
export const CANDIDATE_STATUSES: readonly string[] = ['succeeded', 'failed'];

export interface MatchSpec {
  protocol: ProtocolVersion;
  filters: CohortFilters;
  /** Candidates are pinned at this evidence revision. */
  revision: number;
}

export interface CandidateRow {
  run_id: string;
  org_ref: string;
  key_id: string;
  body_ciphertext: Buffer;
  received_at: Date;
  evidence_revision: number;
  execution_status: string;
  index_context: IndexContext;
  measurement_digest: string | null;
  shared_source_suspect: boolean;
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 422 `not_indexed` for every filter key outside the protocol's required_context. */
export function checkFilterKeys(filters: CohortFilters, protocol: ProtocolVersion): void {
  const issues: ErrorDetail[] = [];
  for (const key of Object.keys(filters)) {
    if (!protocol.required_context.includes(key)) {
      issues.push({ path: `/context_filters/${escapePointer(key)}`, rule: 'not_indexed' });
    }
  }
  if (issues.length > 0) throw new ApiError(422, 'validation_failed', { details: issues });
}

const CANDIDATE_WHERE = `
      WHERE protocol_ref = $1
        AND index_version IS NOT NULL
        AND is_fixture = false
        AND duplicate_of IS NULL
        AND sharing_policy = 'cooperative'
        AND backfill_version IS NOT NULL
        AND harness_digest = ANY($2::text[])
        AND execution_status = ANY($3::text[])
        AND index_context @> $4::jsonb
        AND evidence_revision <= $5
        AND (withdrawn_at IS NULL
             OR (withdrawn_revision IS NOT NULL AND withdrawn_revision > $5))`;

function params(spec: MatchSpec): unknown[] {
  return [
    spec.protocol.ref,
    spec.protocol.compatibility.harness_digests,
    CANDIDATE_STATUSES,
    JSON.stringify(containmentFilter(spec.filters)),
    spec.revision,
  ];
}

/** How many runs are compatible, without touching a body. */
export async function countCandidates(db: Queryable, spec: MatchSpec): Promise<number> {
  const res = await db.query<{ n: string | number }>(
    `SELECT count(*) AS n FROM evidence.runs ${CANDIDATE_WHERE}`,
    params(spec),
  );
  return Number(res.rows[0]?.n ?? 0);
}

/** The contributor rows of the compatible runs (no bodies), for counting organizations above the cap. */
export async function candidateContributors(
  db: Queryable,
  spec: MatchSpec,
): Promise<Array<ContributorRow & { n: number }>> {
  const res = await db.query<ContributorRow & { n: string | number }>(
    `SELECT org_ref, measurement_digest, shared_source_suspect, count(*) AS n
       FROM evidence.runs ${CANDIDATE_WHERE}
      GROUP BY org_ref, measurement_digest, shared_source_suspect`,
    params(spec),
  );
  return res.rows.map((r) => ({ ...r, n: Number(r.n) }));
}

/** The compatible runs with their ciphertext, oldest first. Bounded by the caller's cap. */
export async function loadCandidates(
  db: Queryable,
  spec: MatchSpec,
  limit: number,
): Promise<CandidateRow[]> {
  const res = await db.query<{
    run_id: string;
    org_ref: string;
    key_id: string;
    body_ciphertext: Buffer;
    received_at: Date;
    evidence_revision: string | number;
    execution_status: string;
    index_context: IndexContext;
    measurement_digest: string | null;
    shared_source_suspect: boolean;
  }>(
    `SELECT run_id, org_ref, key_id, body_ciphertext, received_at, evidence_revision,
            execution_status, index_context, measurement_digest, shared_source_suspect
       FROM evidence.runs ${CANDIDATE_WHERE}
      ORDER BY received_at, run_id
      LIMIT $6`,
    [...params(spec), limit],
  );
  return res.rows.map((r) => ({ ...r, evidence_revision: Number(r.evidence_revision) }));
}

/** Soft-ranking tier of one context origin: higher is better evidence of the value. */
export function originTier(origin: ContextOrigin | undefined): 0 | 1 | 2 {
  if (origin === 'measured' || origin === 'operator_reported') return 2;
  if (origin === 'provider_reported') return 1;
  return 0;
}

/** Required keys the run does not know (`origin: unknown` or absent from the projection). */
export function unknownKeys(
  context: IndexContext | null | undefined,
  requiredContext: readonly string[],
): string[] {
  return requiredContext.filter((key) => {
    const field = context?.[key];
    return field === undefined || field.origin === 'unknown' || field.value === null;
  });
}

/** True when the projection carries every filter key with exactly the filter value. */
export function matchesFilters(
  context: IndexContext | null | undefined,
  filters: Readonly<Record<string, ContextValue>>,
): boolean {
  for (const [key, value] of Object.entries(filters)) {
    const field = context?.[key];
    if (field === undefined || field.value !== value) return false;
  }
  return true;
}

/** The ranking score: sum of origin tiers over the unfiltered required keys. */
export function rankScore(
  context: IndexContext | null | undefined,
  requiredContext: readonly string[],
  filters: Readonly<Record<string, ContextValue>>,
): number {
  let score = 0;
  for (const key of requiredContext) {
    if (key in filters) continue;
    score += originTier(context?.[key]?.origin);
  }
  return score;
}

/**
 * Order candidates by soft similarity: best-known context first, then
 * oldest first (stable). The input is the output: same runs, same count.
 */
export function rankCandidates<T extends { index_context: IndexContext; received_at: Date }>(
  rows: readonly T[],
  requiredContext: readonly string[],
  filters: Readonly<Record<string, ContextValue>>,
): T[] {
  return rows
    .map((row, i) => ({ row, i, score: rankScore(row.index_context, requiredContext, filters) }))
    .sort(
      (a, b) =>
        b.score - a.score || a.row.received_at.getTime() - b.row.received_at.getTime() || a.i - b.i,
    )
    .map((r) => r.row);
}
