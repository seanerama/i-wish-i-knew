// Cohort policy (stage 9; ADR-0002 §4 thresholds, fixed cohort releases,
// differencing defence). `policy_version` is stamped on every receipt the
// real query path issues; a change to any number here is a new version and
// a new ADR, never a silent edit.
//
//   release requires   >= 3 distinct contributing organizations
//                      >= 5 qualifying runs
//                      no organization supplying more than 50 % of the runs
//   differencing       a cohort about to be released is compared with EVERY
//                      prior release for the same protocol: identical member
//                      sets are a repeat and fine; a set that differs from
//                      any prior release by fewer than 3 organizations
//                      (symmetric difference of the member sets) is
//                      suppressed with reason `differencing`
//
// Organizations are compared as keyed hashes (HMAC-SHA256 under a key
// derived from the service KEK); the release log never holds an org_ref.
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import type { SuppressionReason } from '@iwik/contracts';

export const POLICY_VERSION = '2026-09-p1';

export const MIN_ORGS = 3;
export const MIN_RUNS = 5;
export const MAX_ORG_SHARE = 0.5;
/** A released cohort must differ from every earlier release by at least this many organizations. */
export const MIN_ORG_DIFFERENCE = 3;

export interface CohortCounts {
  /** Distinct contributing organizations, shared-source pairs merged (ADR-0003). */
  orgs: number;
  runs: number;
  /** Largest contributor's share of `runs`. */
  max_org_share: number;
}

/** Threshold reasons, in the contract's order; empty when the cohort is releasable. */
export function thresholdReasons(counts: CohortCounts): SuppressionReason[] {
  const reasons: SuppressionReason[] = [];
  if (counts.orgs < MIN_ORGS) reasons.push('min_orgs');
  if (counts.runs < MIN_RUNS) reasons.push('min_runs');
  if (counts.max_org_share > MAX_ORG_SHARE) reasons.push('concentration');
  return reasons;
}

export function symmetricDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n += 1;
  for (const x of b) if (!a.has(x)) n += 1;
  return n;
}

/**
 * The differencing rule: true when `current` differs from any prior member
 * set by fewer than MIN_ORG_DIFFERENCE organizations without being that set.
 */
export function differencingConflict(
  priors: ReadonlyArray<ReadonlySet<string>>,
  current: ReadonlySet<string>,
): boolean {
  for (const prior of priors) {
    const diff = symmetricDifference(prior, current);
    if (diff === 0) continue;
    if (diff < MIN_ORG_DIFFERENCE) return true;
  }
  return false;
}

/** The HMAC key for member hashes, derived from the KEK; never stored. */
export function cohortHashKey(kek: Buffer): Buffer {
  return Buffer.from(
    hkdfSync('sha256', kek, Buffer.from('iwik-cohort-release-salt'), 'iwik-cohort-release-v1', 32),
  );
}

export function orgHash(key: Buffer, orgRef: string): string {
  return createHmac('sha256', key).update(orgRef, 'utf8').digest('hex');
}

/** SHA-256 over the sorted member hashes: one string per member set. */
export function membersHash(hashes: readonly string[]): string {
  return createHash('sha256')
    .update([...hashes].sort().join('\n'), 'utf8')
    .digest('hex');
}
