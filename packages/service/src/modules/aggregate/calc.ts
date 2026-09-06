// The versioned calculation (stage 9; brief §7 "Fair statistics",
// ADR-0003 analysis unit): pure functions over the decrypted bodies of ONE
// matched cohort. Nothing here touches the database, the network, or a log.
//
//   calculation_version = latency-v1
//
//   analysis unit   one run (one protocol execution from one node);
//                   attempts inside a run are samples within a run
//   contributor     one organization (shared-source pairs merged upstream)
//   per claim       the claims.json derivation: per-run statistics the run
//                   already carries (nearest-rank percentiles of ttft_ms and
//                   total_ms; failed / attempted), each spread ACROSS runs
//                   with nearest-rank percentiles and n; never a pooled
//                   number over all attempts
//   contradictions  for a distribution metric's p50: the per-run values are
//                   grouped by organization; two organizations with at least
//                   two runs each whose interquartile ranges (nearest-rank
//                   q1, q3) do not overlap are flagged. The text is a fixed
//                   template that names no organization and proposes no
//                   cause (brief §7 "Diagnosis").
//   missingness     sums of Run.accounting across the cohort; runs with any
//                   unknown required context; runs below a claim's minimum
//   freshness       oldest and newest received_at, as dates only
//   uncertainty     descriptive: no confidence interval is computed; tail
//                   statistics (p95, p99) are reported but a tail claim
//                   needs TAIL_MINIMUM_RUNS runs (brief §7 "minimum sample
//                   needed for tail claims")
//
// `compute` returns exact numbers so the arithmetic can be hand-checked;
// `releaseSections` is the only path onto the wire and bands every count.
import type {
  AttemptSums,
  ContextOrigin,
  CountBand,
  MetricSpread,
  ReceiptContradiction,
  ReceiptFinding,
  ReceiptResult,
  ReleasedCount,
  RunAccounting,
  Spread,
  SuppressionReason,
} from '@iwik/contracts';
import { orgRange, runRange, shareBand } from '../cohort/index.js';
import { MAX_ORG_SHARE, MIN_ORGS, MIN_RUNS } from './policy.js';

export const CALCULATION_VERSION = 'latency-v1';
/** Brief §7: tail claims need a minimum sample; below it p95/p99 are descriptive only. */
export const TAIL_MINIMUM_RUNS = 20;
/** The per-run statistics a distribution metric carries (claims.json per_run). */
export const DISTRIBUTION_STATISTICS = ['p50', 'p90', 'p95', 'p99'] as const;
/** The statistic contradictions are tested on. */
export const CONTRADICTION_STATISTIC = 'p50';

export const RANKING_STATEMENT =
  'measured > provider_reported > unknown on the unfiltered required keys; ranking orders compatible runs and never admits an incompatible one';

/** Fixed template; no organization, no cause. */
export function contradictionText(metric: string, statistic: string): string {
  return (
    `Two contributing organizations report non-overlapping interquartile ranges of per-run ${metric} ${statistic} ` +
    'under the same matched conditions. Both sets of observations are retained. ' +
    'The evidence does not identify why they differ; a controlled comparison under a registered protocol would.'
  );
}

// ---------------------------------------------------------------------------
// claims.json

export interface MetricSpec {
  name: string;
  path: string;
  kind: 'distribution' | 'rate';
  unit?: string;
}

export interface ClaimSpec {
  name: string;
  minimum_succeeded?: number;
  minimum_attempted?: number;
  metrics: MetricSpec[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The claim specs of a pack's claims.json restricted to `permitted` (ProtocolVersion.permitted_claims). */
export function parseClaims(
  claims: Record<string, unknown>,
  permitted: readonly string[],
): ClaimSpec[] {
  const out: ClaimSpec[] = [];
  const list = Array.isArray(claims['claims']) ? (claims['claims'] as unknown[]) : [];
  for (const raw of list) {
    if (!isObject(raw) || typeof raw['name'] !== 'string') continue;
    if (!permitted.includes(raw['name'])) continue;
    const derivation = isObject(raw['derivation']) ? raw['derivation'] : {};
    const metrics: MetricSpec[] = [];
    const rawMetrics = Array.isArray(derivation['metrics'])
      ? (derivation['metrics'] as unknown[])
      : [];
    for (const m of rawMetrics) {
      if (!isObject(m) || typeof m['name'] !== 'string' || typeof m['path'] !== 'string') continue;
      const kind = m['kind'];
      // `breakdown` (error classes) is not released in latency-v1: class
      // names are pack vocabulary, but per-class counts would be small exact counts.
      if (kind !== 'distribution' && kind !== 'rate') continue;
      const spec: MetricSpec = { name: m['name'], path: m['path'], kind };
      if (typeof m['unit'] === 'string') spec.unit = m['unit'];
      metrics.push(spec);
    }
    const spec: ClaimSpec = { name: raw['name'], metrics };
    const minSucceeded = derivation['minimum_succeeded_attempts_per_run'];
    if (typeof minSucceeded === 'number') spec.minimum_succeeded = minSucceeded;
    const minAttempted = derivation['minimum_attempts_per_run'];
    if (typeof minAttempted === 'number') spec.minimum_attempted = minAttempted;
    out.push(spec);
  }
  return out;
}

/** JSON-pointer lookup (RFC 6901); undefined when absent. */
export function pointer(value: unknown, path: string): unknown {
  if (path === '') return value;
  let current: unknown = value;
  for (const raw of path.split('/').slice(1)) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) current = current[Number(segment)];
    else if (isObject(current)) current = current[segment];
    else return undefined;
  }
  return current;
}

// ---------------------------------------------------------------------------
// statistics

/**
 * Nearest-rank percentile: the value at rank ceil(p/100 * n) (1-based) of
 * the ascending values. p in (0, 100]. Never interpolates.
 */
export function nearestRank(sortedAscending: readonly number[], percentile: number): number {
  const n = sortedAscending.length;
  if (n === 0) throw new RangeError('nearestRank of an empty list');
  if (!(percentile > 0 && percentile <= 100)) throw new RangeError('percentile out of range');
  const rank = Math.min(n, Math.max(1, Math.ceil((percentile / 100) * n)));
  return sortedAscending[rank - 1] as number;
}

export interface ExactSpread {
  n: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
}

/** The nearest-rank spread of a list of per-run values; undefined when empty. */
export function exactSpread(values: readonly number[]): ExactSpread | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  return {
    n: sorted.length,
    min: sorted[0] as number,
    p50: nearestRank(sorted, 50),
    p90: nearestRank(sorted, 90),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
    max: sorted[sorted.length - 1] as number,
  };
}

export interface Quartiles {
  q1: number;
  q3: number;
}

/** Nearest-rank first and third quartiles. */
export function quartiles(values: readonly number[]): Quartiles | undefined {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  return { q1: nearestRank(sorted, 25), q3: nearestRank(sorted, 75) };
}

/** True when the two interquartile ranges share no point. */
export function iqrDisjoint(a: Quartiles, b: Quartiles): boolean {
  return a.q3 < b.q1 || b.q3 < a.q1;
}

// ---------------------------------------------------------------------------
// the cohort computation

/** One run of the matched cohort, already decrypted and reduced to what the calculation reads. */
export interface Sample {
  /** The contributing organization (raw org_ref); never leaves this process. */
  org_ref: string;
  /** The contributor unit after the shared-source merge (an org_ref of the group). */
  contributor: string;
  received_at: Date;
  execution_status: string;
  accounting: RunAccounting;
  /** The pack-validated result body. */
  result: unknown;
  /** Origin per required context key, from the index projection. */
  context_origin: Readonly<Record<string, ContextOrigin | undefined>>;
}

export interface ExactMetric {
  kind: 'distribution' | 'rate';
  unit?: string;
  /** Runs that carried the metric. */
  runs: number;
  statistics?: Record<string, ExactSpread>;
  values?: ExactSpread;
}

export interface ExactContradiction {
  claim: string;
  metric: string;
  statistic: string;
}

export interface ClaimComputation {
  claim: string;
  /** Runs meeting the claim's per-run minimum. */
  eligible: number;
  below_minimum: number;
  /** Contributor units among the eligible runs. */
  orgs: number;
  max_org_share: number;
  metrics: Record<string, ExactMetric>;
  contradictions: ExactContradiction[];
}

export interface Computation {
  runs: number;
  /** Contributor units (shared-source pairs merged). */
  orgs: number;
  max_org_share: number;
  claims: ClaimComputation[];
  attempts: RunAccounting;
  runs_with_unknown_context: number;
  /** Per unfiltered required key: runs that know the value. */
  context_known: Record<string, number>;
  oldest_received_at: Date | undefined;
  newest_received_at: Date | undefined;
}

function concentration(samples: readonly Sample[]): { orgs: number; max_org_share: number } {
  const per = new Map<string, number>();
  for (const s of samples) per.set(s.contributor, (per.get(s.contributor) ?? 0) + 1);
  const largest = Math.max(0, ...per.values());
  return {
    orgs: per.size,
    max_org_share: samples.length === 0 ? 0 : largest / samples.length,
  };
}

function eligibleFor(spec: ClaimSpec, samples: readonly Sample[]): Sample[] {
  return samples.filter((s) => {
    const a = s.accounting;
    if (spec.minimum_succeeded !== undefined) {
      // A latency distribution comes from succeeded attempts of a succeeded run.
      if (s.execution_status !== 'succeeded') return false;
      if (a.succeeded < spec.minimum_succeeded) return false;
    }
    if (spec.minimum_attempted !== undefined && a.attempted < spec.minimum_attempted) return false;
    return true;
  });
}

function numberAt(value: unknown, key: string): number | undefined {
  if (!isObject(value)) return undefined;
  const n = value[key];
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Per-run rate: the pointer's number when present, else failed / attempted from the accounting (R4). */
function rateOf(sample: Sample, path: string): number | undefined {
  const direct = pointer(sample.result, path);
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const a = sample.accounting;
  return a.attempted === 0 ? undefined : a.failed / a.attempted;
}

function contradictionsFor(
  claim: string,
  metric: MetricSpec,
  perRun: ReadonlyArray<{ org_ref: string; value: number }>,
): ExactContradiction[] {
  const byOrg = new Map<string, number[]>();
  for (const r of perRun) byOrg.set(r.org_ref, [...(byOrg.get(r.org_ref) ?? []), r.value]);
  const ranges: Quartiles[] = [];
  for (const values of byOrg.values()) {
    if (values.length < 2) continue; // one run is not a distribution
    const q = quartiles(values);
    if (q !== undefined) ranges.push(q);
  }
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      if (iqrDisjoint(ranges[i] as Quartiles, ranges[j] as Quartiles)) {
        return [{ claim, metric: metric.name, statistic: CONTRADICTION_STATISTIC }];
      }
    }
  }
  return [];
}

function computeClaim(spec: ClaimSpec, samples: readonly Sample[]): ClaimComputation {
  const eligible = eligibleFor(spec, samples);
  const { orgs, max_org_share } = concentration(eligible);
  const metrics: Record<string, ExactMetric> = {};
  const contradictions: ExactContradiction[] = [];
  for (const metric of spec.metrics) {
    if (metric.kind === 'distribution') {
      const carried = eligible
        .map((s) => ({ org_ref: s.org_ref, value: pointer(s.result, metric.path) }))
        .filter((r) => isObject(r.value));
      const statistics: Record<string, ExactSpread> = {};
      for (const stat of DISTRIBUTION_STATISTICS) {
        const values = carried
          .map((r) => numberAt(r.value, stat))
          .filter((v): v is number => v !== undefined);
        const spread = exactSpread(values);
        if (spread !== undefined) statistics[stat] = spread;
      }
      const entry: ExactMetric = { kind: 'distribution', runs: carried.length, statistics };
      if (metric.unit !== undefined) entry.unit = metric.unit;
      metrics[metric.name] = entry;
      const p50s = carried
        .map((r) => ({ org_ref: r.org_ref, value: numberAt(r.value, CONTRADICTION_STATISTIC) }))
        .filter((r): r is { org_ref: string; value: number } => r.value !== undefined);
      contradictions.push(...contradictionsFor(spec.name, metric, p50s));
    } else {
      const rates = eligible
        .map((s) => rateOf(s, metric.path))
        .filter((v): v is number => v !== undefined);
      const entry: ExactMetric = { kind: 'rate', runs: rates.length };
      const spread = exactSpread(rates);
      if (spread !== undefined) entry.values = spread;
      if (metric.unit !== undefined) entry.unit = metric.unit;
      metrics[metric.name] = entry;
    }
  }
  return {
    claim: spec.name,
    eligible: eligible.length,
    below_minimum: samples.length - eligible.length,
    orgs,
    max_org_share,
    metrics,
    contradictions,
  };
}

/** The whole computation over one cohort, exact. */
export function compute(
  samples: readonly Sample[],
  claims: readonly ClaimSpec[],
  requiredContext: readonly string[],
  filterKeys: readonly string[],
): Computation {
  const attempts: RunAccounting = {
    planned: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    excluded: 0,
    unobserved: 0,
  };
  let unknownRuns = 0;
  const known: Record<string, number> = {};
  const unfiltered = requiredContext.filter((k) => !filterKeys.includes(k));
  for (const key of unfiltered) known[key] = 0;
  let oldest: Date | undefined;
  let newest: Date | undefined;
  for (const s of samples) {
    for (const key of Object.keys(attempts) as Array<keyof RunAccounting>) {
      attempts[key] += s.accounting[key];
    }
    let anyUnknown = false;
    for (const key of unfiltered) {
      const origin = s.context_origin[key];
      if (origin === undefined || origin === 'unknown') anyUnknown = true;
      else known[key] = (known[key] ?? 0) + 1;
    }
    if (anyUnknown) unknownRuns += 1;
    if (oldest === undefined || s.received_at < oldest) oldest = s.received_at;
    if (newest === undefined || s.received_at > newest) newest = s.received_at;
  }
  const { orgs, max_org_share } = concentration(samples);
  return {
    runs: samples.length,
    orgs,
    max_org_share,
    claims: claims.map((spec) => computeClaim(spec, samples)),
    attempts,
    runs_with_unknown_context: unknownRuns,
    context_known: known,
    oldest_received_at: oldest,
    newest_received_at: newest,
  };
}

// ---------------------------------------------------------------------------
// release: exact -> bands. The only path onto the wire.

/** ADR-0002: exact at 11 or more, otherwise `<11`. */
export function releasedCount(n: number): ReleasedCount {
  return n >= 11 ? n : '<11';
}

function bandSpread(s: ExactSpread): Spread {
  return {
    n: runRange(s.n),
    min: s.min,
    p50: s.p50,
    p90: s.p90,
    p95: s.p95,
    p99: s.p99,
    max: s.max,
  };
}

function bandMetric(m: ExactMetric): MetricSpread {
  const out: MetricSpread = { kind: m.kind, runs: runRange(m.runs) };
  if (m.unit !== undefined) out.unit = m.unit;
  if (m.statistics !== undefined) {
    out.statistics = {};
    for (const [stat, spread] of Object.entries(m.statistics))
      out.statistics[stat] = bandSpread(spread);
  }
  if (m.values !== undefined) out.values = bandSpread(m.values);
  return out;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The per-claim threshold check: a claim whose eligible runs do not qualify is withheld. */
export function claimReasons(claim: ClaimComputation): SuppressionReason[] {
  const reasons: SuppressionReason[] = [];
  if (claim.orgs < MIN_ORGS) reasons.push('min_orgs');
  if (claim.eligible < MIN_RUNS) reasons.push('min_runs');
  if (claim.max_org_share > MAX_ORG_SHARE) reasons.push('concentration');
  return reasons;
}

export interface ReleaseInput {
  computation: Computation;
  requiredContext: readonly string[];
  filterKeys: readonly string[];
}

/**
 * The cooperative sections of a released receipt: every count a band, every
 * text a fixed template, nothing per run and nothing per organization.
 */
export function releaseSections(input: ReleaseInput): Omit<ReceiptResult, 'own_evidence'> {
  const c = input.computation;
  const runsBand: CountBand = runRange(c.runs);
  const orgsBand: CountBand = orgRange(c.orgs);
  const findings: ReceiptFinding[] = [];
  const distributions: Record<string, Record<string, MetricSpread>> = {};
  const contradictions: ReceiptContradiction[] = [];
  const belowMinimum: Record<string, CountBand> = {};
  for (const claim of c.claims) {
    const reasons = claimReasons(claim);
    belowMinimum[claim.claim] = runRange(claim.below_minimum);
    const metricNames = Object.keys(claim.metrics);
    if (reasons.length > 0) {
      findings.push({
        claim: claim.claim,
        status: 'withheld',
        statement: `Withheld: the runs eligible for this claim (${runRange(claim.eligible)} runs from ${orgRange(claim.orgs)} organizations) do not meet the release policy (${reasons.join(', ')}).`,
        metrics: metricNames,
        reasons,
      });
      continue;
    }
    const banded: Record<string, MetricSpread> = {};
    for (const [name, metric] of Object.entries(claim.metrics)) banded[name] = bandMetric(metric);
    distributions[claim.claim] = banded;
    const kinds = new Set(Object.values(claim.metrics).map((m) => m.kind));
    findings.push({
      claim: claim.claim,
      status: 'released',
      statement: kinds.has('distribution')
        ? `Across ${runRange(claim.eligible)} runs from ${orgRange(claim.orgs)} organizations, per-run nearest-rank percentiles of ${metricNames.join(' and ')} are reported as spreads across runs; no pooled number is released.`
        : `Across ${runRange(claim.eligible)} runs from ${orgRange(claim.orgs)} organizations, the per-run ${metricNames.join(' and ')} (failed / attempted) is reported as a spread across runs.`,
      metrics: metricNames,
    });
    for (const x of claim.contradictions) {
      contradictions.push({
        kind: 'org_level_iqr_disjoint',
        claim: x.claim,
        metric: x.metric,
        statistic: x.statistic,
        text: contradictionText(x.metric, x.statistic),
      });
    }
  }

  const attempts: AttemptSums = {
    planned: releasedCount(c.attempts.planned),
    attempted: releasedCount(c.attempts.attempted),
    succeeded: releasedCount(c.attempts.succeeded),
    failed: releasedCount(c.attempts.failed),
    excluded: releasedCount(c.attempts.excluded),
    unobserved: releasedCount(c.attempts.unobserved),
  };
  const contextKnown: Record<string, CountBand> = {};
  const unfiltered = input.requiredContext.filter((k) => !input.filterKeys.includes(k)).sort();
  for (const key of unfiltered) contextKnown[key] = runRange(c.context_known[key] ?? 0);

  const tailSupported = c.runs >= TAIL_MINIMUM_RUNS;
  const limitations: string[] = [];
  if (c.runs_with_unknown_context > 0) {
    limitations.push(
      `${runRange(c.runs_with_unknown_context)} runs carry at least one required context field with origin unknown.`,
    );
  }
  if (!tailSupported) {
    limitations.push(
      `Fewer than ${TAIL_MINIMUM_RUNS} runs: tail statistics (p95, p99) do not support a tail claim.`,
    );
  }
  if (contradictions.length > 0) {
    limitations.push(
      'Contributing organizations disagree on at least one statistic; the disagreement is listed under contradictions and is not averaged away.',
    );
  }
  limitations.push(
    'One run is one protocol execution from one node; attempts inside a run are samples within a run, never independent observations.',
  );

  const result: Omit<ReceiptResult, 'own_evidence'> = {
    findings,
    applicability: {
      filters_applied: [...input.filterKeys].sort(),
      unfiltered_required_context: unfiltered,
      context_known: contextKnown,
      ranking: RANKING_STATEMENT,
    },
    distributions: {
      claims: distributions,
      contributors: { orgs: orgsBand, max_org_share: shareBand(c.max_org_share) },
    },
    missingness: {
      attempts,
      runs_with_unknown_context: runRange(c.runs_with_unknown_context),
      runs_below_claim_minimum: belowMinimum,
    },
    contradictions,
    uncertainty: {
      kind: 'descriptive',
      detail: `Spreads are descriptive nearest-rank percentiles of per-run statistics across ${runsBand} runs; no confidence interval is computed.`,
      runs: runsBand,
      tail_claims: {
        minimum_runs: TAIL_MINIMUM_RUNS,
        supported: tailSupported,
        statement: tailSupported
          ? `At least ${TAIL_MINIMUM_RUNS} runs: p95 and p99 spreads may support a tail claim, subject to the limitations listed.`
          : `Fewer than ${TAIL_MINIMUM_RUNS} runs: p95 and p99 spreads are reported but do not support a tail claim.`,
      },
    },
    freshness: {
      ...(c.oldest_received_at !== undefined
        ? { oldest_received_on: isoDate(c.oldest_received_at) }
        : {}),
      ...(c.newest_received_at !== undefined
        ? { newest_received_on: isoDate(c.newest_received_at) }
        : {}),
    },
    limitations,
  };
  return result;
}
