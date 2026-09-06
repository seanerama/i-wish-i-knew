// Cohort accounting (stage 8; ADR-0002 thresholds, ADR-0003 analysis unit).
//
//   cohortPreview(protocol_ref, filters)  exact distinct-organization count,
//                                         run count, and the largest
//                                         organization's share of runs for
//                                         one (protocol, filters) tuple: the
//                                         numbers stage 9 tests thresholds
//                                         against. Internal only.
//   GET /v1/admin/cohorts                 the same tuple for an operator, as
//                                         RANGES only (never exact counts),
//                                         behind IWIK_FEATURE_DEDUPE.
//
// What counts: a run counts when it is not withdrawn, not a fixture run
// (never releasable, ADR-0003), not a same-organization duplicate, and its
// index projection is trusted (`index_version` set) and contains the filter
// (`index_context @> filter`). One contributor is one organization; two
// organizations that submitted the same measurement (`shared_source_suspect`)
// are counted as one contributor, because a shared source is not independent
// evidence (brief §7). Their runs still count as runs.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ContextValue } from '@iwik/contracts';
import type { Config } from '../../config.js';
import type { Pool, Queryable } from '../../db.js';
import { ApiError } from '../../errors.js';
import type { ErrorDetail } from '../../errors.js';
import { operatorAuthorized } from '../enrollment/index.js';
import { currentRevision } from '../intake/index.js';
import type { IndexContext } from '../intake/projection.js';
import type { Registry } from '../registry/index.js';

export { listContributions, recordContribution, repairContributions } from './contributions.js';
export type { ContributionRow } from './contributions.js';

export interface CohortFilters {
  [key: string]: ContextValue;
}

export interface CohortPreview {
  protocol_ref: string;
  filters: CohortFilters;
  /** Distinct contributing organizations, shared-source pairs merged. */
  orgs: number;
  /** Counted runs (see the module comment for what counts). */
  runs: number;
  /** Largest contributor's share of `runs`, 0 when there are none. */
  max_org_share: number;
}

/** The containment document for `index_context @> $1`: `{ key: { value } }` per filter. */
export function containmentFilter(filters: CohortFilters): Partial<IndexContext> {
  const doc: Record<string, { value: ContextValue }> = {};
  for (const [key, value] of Object.entries(filters)) doc[key] = { value };
  return doc as Partial<IndexContext>;
}

interface CountRow {
  org_ref: string;
  measurement_digest: string | null;
  shared_source_suspect: boolean;
  n: string | number;
}

/**
 * Merge organizations linked by a shared measurement into one contributor:
 * a union-find over org_refs keyed by the digests flagged as shared.
 */
function contributorOf(rows: CountRow[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) {
      const next = parent.get(root);
      if (next === undefined) {
        parent.set(root, root);
        break;
      }
      root = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const row of rows) if (!parent.has(row.org_ref)) parent.set(row.org_ref, row.org_ref);
  const byDigest = new Map<string, string>();
  for (const row of rows) {
    if (!row.shared_source_suspect || row.measurement_digest === null) continue;
    const first = byDigest.get(row.measurement_digest);
    if (first === undefined) byDigest.set(row.measurement_digest, row.org_ref);
    else union(first, row.org_ref);
  }
  const out = new Map<string, string>();
  for (const org of parent.keys()) out.set(org, find(org));
  return out;
}

export async function cohortPreview(
  db: Queryable,
  protocolRef: string,
  filters: CohortFilters = {},
): Promise<CohortPreview> {
  const res = await db.query<CountRow>(
    `SELECT org_ref, measurement_digest, shared_source_suspect, count(*) AS n
       FROM evidence.runs
      WHERE protocol_ref = $1
        AND withdrawn_at IS NULL
        AND is_fixture = false
        AND duplicate_of IS NULL
        AND index_version IS NOT NULL
        AND index_context @> $2::jsonb
      GROUP BY org_ref, measurement_digest, shared_source_suspect`,
    [protocolRef, JSON.stringify(containmentFilter(filters))],
  );
  const contributor = contributorOf(res.rows);
  const perContributor = new Map<string, number>();
  let runs = 0;
  for (const row of res.rows) {
    const unit = contributor.get(row.org_ref) ?? row.org_ref;
    const n = Number(row.n);
    runs += n;
    perContributor.set(unit, (perContributor.get(unit) ?? 0) + n);
  }
  const largest = Math.max(0, ...perContributor.values());
  return {
    protocol_ref: protocolRef,
    filters,
    orgs: perContributor.size,
    runs,
    max_org_share: runs === 0 ? 0 : largest / runs,
  };
}

// ---------------------------------------------------------------------------
// Ranges (contracts/evidence-envelope.md count-range vocabulary; ADR-0002
// "counts are released as ranges, never exact below 11").

export type OrgRange = '<3' | '3-5' | '6-10' | '11+';
export type RunRange = '<5' | '5-10' | '11-50' | '51+';
/** The concentration rule is a 50 % cap, so the only band that matters is which side of it. */
export type ShareBand = '<=50%' | '>50%';

export function orgRange(n: number): OrgRange {
  if (n < 3) return '<3';
  if (n <= 5) return '3-5';
  if (n <= 10) return '6-10';
  return '11+';
}

export function runRange(n: number): RunRange {
  if (n < 5) return '<5';
  if (n <= 10) return '5-10';
  if (n <= 50) return '11-50';
  return '51+';
}

export function shareBand(share: number): ShareBand {
  return share > 0.5 ? '>50%' : '<=50%';
}

export interface CohortRanges {
  protocol_ref: string;
  filters: CohortFilters;
  orgs: OrgRange;
  runs: RunRange;
  max_org_share: ShareBand;
  evidence_revision: number;
}

export function toRanges(preview: CohortPreview, revision: number): CohortRanges {
  return {
    protocol_ref: preview.protocol_ref,
    filters: preview.filters,
    orgs: orgRange(preview.orgs),
    runs: runRange(preview.runs),
    max_org_share: shareBand(preview.max_org_share),
    evidence_revision: revision,
  };
}

// ---------------------------------------------------------------------------
// Operator endpoint.

const PROTOCOL_REF_RE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*@[1-9][0-9]*$/;
const FILTER_PREFIX = 'filter.';

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** `filter.<key>=<value>` query parameters; values parse as JSON scalars, else strings. */
export function parseCohortQuery(
  query: Record<string, unknown>,
  registry: Registry,
): { protocol_ref: string; filters: CohortFilters } {
  const issues: ErrorDetail[] = [];
  const ref = query['protocol_ref'];
  let required: readonly string[] = [];
  if (typeof ref !== 'string' || ref === '') {
    issues.push({ path: '/protocol_ref', rule: 'required' });
  } else if (!PROTOCOL_REF_RE.test(ref)) {
    issues.push({ path: '/protocol_ref', rule: 'pattern' });
  } else {
    const entry = registry.get(ref);
    if (entry === undefined) issues.push({ path: '/protocol_ref', rule: 'protocol_unknown' });
    else required = entry.protocol.required_context;
  }
  const filters: CohortFilters = {};
  for (const [name, raw] of Object.entries(query)) {
    if (name === 'protocol_ref') continue;
    const pointer = `/${escapePointer(name)}`;
    if (!name.startsWith(FILTER_PREFIX) || name.length === FILTER_PREFIX.length) {
      issues.push({ path: pointer, rule: 'additionalProperties' });
      continue;
    }
    const key = name.slice(FILTER_PREFIX.length);
    if (Array.isArray(raw) || typeof raw !== 'string') {
      issues.push({ path: pointer, rule: 'type' });
      continue;
    }
    // Only the protocol's required keys are ever projected, so only they can filter.
    if (!required.includes(key)) {
      issues.push({ path: pointer, rule: 'not_indexed' });
      continue;
    }
    filters[key] = parseScalar(raw);
  }
  if (issues.length > 0) throw new ApiError(422, 'validation_failed', { details: issues });
  return { protocol_ref: ref as string, filters };
}

function parseScalar(raw: string): ContextValue {
  if (raw === 'null') return null;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return raw;
}

export interface CohortDeps {
  pool: Pool;
  config: Config;
  registry: Registry;
}

export function registerCohortRoutes(app: FastifyInstance, deps: CohortDeps): void {
  const { pool, config, registry } = deps;
  const gate = async (): Promise<void> => {
    if (!config.featureDedupe) throw new ApiError(404, 'feature_disabled');
  };

  app.get('/v1/admin/cohorts', { preHandler: gate }, async (request: FastifyRequest) => {
    if (!operatorAuthorized(request, config)) throw new ApiError(401, 'unauthorized');
    const query =
      typeof request.query === 'object' && request.query !== null
        ? (request.query as Record<string, unknown>)
        : {};
    const parsed = parseCohortQuery(query, registry);
    const preview = await cohortPreview(pool, parsed.protocol_ref, parsed.filters);
    const revision = await currentRevision(pool);
    const ranges = toRanges(preview, revision);
    // Ranges only, even in our own logs.
    request.log.info(
      { protocol_ref: parsed.protocol_ref, orgs: ranges.orgs, runs: ranges.runs },
      'cohort preview served',
    );
    return ranges;
  });
}
