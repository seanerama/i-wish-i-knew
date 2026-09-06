// Persistence for the query path (stage 9): the release log the differencing
// defence reads (evidence.cohort_releases) and the revision-keyed answer
// cache (evidence.cache, created in stage 7).
//
// Cache rule (stage 7 review carry-forward): a row is valid only while its
// revision is the latest revision that touched the protocol. A row that is
// older is treated as invalid on read, whatever the eviction job did or did
// not get to, and is deleted on the spot. Payloads hold the cooperative
// outcome only (bands, sections, reasons): nothing per caller and nothing
// exact.
import type { ContextValue, ReceiptResult, SuppressionReason } from '@iwik/contracts';
import type { Queryable } from '../../db.js';
import { latestRevisionFor } from '../intake/index.js';
import type { OrgRange, RunRange } from '../cohort/index.js';
import { ulid } from '../../ulid.js';
import { membersHash } from './policy.js';

export type OutcomeStatus = 'released' | 'suppressed' | 'insufficient_evidence';

/** The caller-independent answer for one (query, revision): what the cache stores. */
export interface CooperativeOutcome {
  status: OutcomeStatus;
  orgs: OrgRange;
  runs: RunRange;
  suppression_reasons?: SuppressionReason[];
  /** Present only when released. */
  sections?: Omit<ReceiptResult, 'own_evidence'>;
}

export function cacheKey(queryDigest: string, revision: number): string {
  return `query:${queryDigest}:${revision}`;
}

/** The cached outcome, or undefined when absent or no longer current for its protocol. */
export async function readCachedOutcome(
  db: Queryable,
  key: string,
  protocolRef: string,
): Promise<CooperativeOutcome | undefined> {
  const res = await db.query<{ revision: string | number; payload: CooperativeOutcome }>(
    `SELECT revision, payload FROM evidence.cache WHERE key = $1 AND protocol_ref = $2`,
    [key, protocolRef],
  );
  const row = res.rows[0];
  if (row === undefined) return undefined;
  const latest = await latestRevisionFor(db, protocolRef);
  if (Number(row.revision) < latest) {
    await db.query(`DELETE FROM evidence.cache WHERE key = $1`, [key]);
    return undefined;
  }
  return row.payload;
}

export async function writeCachedOutcome(
  db: Queryable,
  key: string,
  protocolRef: string,
  revision: number,
  outcome: CooperativeOutcome,
): Promise<void> {
  await db.query(
    `INSERT INTO evidence.cache (key, protocol_ref, revision, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (key) DO NOTHING`,
    [key, protocolRef, revision, JSON.stringify(outcome)],
  );
}

/** The member sets of every prior release for a protocol, as keyed hashes. */
export async function priorMemberSets(
  db: Queryable,
  protocolRef: string,
): Promise<Array<ReadonlySet<string>>> {
  const res = await db.query<{ member_org_hashes: string[] }>(
    `SELECT member_org_hashes FROM evidence.cohort_releases WHERE protocol_ref = $1`,
    [protocolRef],
  );
  return res.rows.map((r) => new Set(r.member_org_hashes));
}

/**
 * Whether a pinned cohort still reproduces the release first recorded at
 * that revision for the same protocol and filters: same member set and the
 * same run count. Undefined when nothing was released there (nothing to
 * reproduce). Compares hashes and a count only; says nothing about who.
 */
export async function pinnedReleaseReproduced(
  db: Queryable,
  protocolRef: string,
  filters: Record<string, ContextValue>,
  revision: number,
  memberOrgHashes: readonly string[],
  runCount: number,
): Promise<boolean | undefined> {
  const res = await db.query<{ member_orgs_hash: string; run_count: number }>(
    `SELECT member_orgs_hash, run_count FROM evidence.cohort_releases
      WHERE protocol_ref = $1 AND revision = $2 AND filters = $3::jsonb
      ORDER BY released_at, release_id LIMIT 1`,
    [protocolRef, revision, JSON.stringify(filters)],
  );
  const original = res.rows[0];
  if (original === undefined) return undefined;
  return (
    original.member_orgs_hash === membersHash(memberOrgHashes) &&
    Number(original.run_count) === runCount
  );
}

export interface ReleaseRecord {
  query_digest: string;
  protocol_ref: string;
  filters: Record<string, ContextValue>;
  /** Sorted keyed hashes of the member organizations. */
  member_org_hashes: string[];
  member_orgs_hash: string;
  org_count: number;
  run_count: number;
  revision: number;
  receipt_id: string;
}

export async function recordRelease(db: Queryable, record: ReleaseRecord): Promise<string> {
  const releaseId = ulid();
  await db.query(
    `INSERT INTO evidence.cohort_releases
       (release_id, query_digest, protocol_ref, filters, member_orgs_hash, member_org_hashes,
        org_count, run_count, revision, receipt_id)
     VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10)`,
    [
      releaseId,
      record.query_digest,
      record.protocol_ref,
      JSON.stringify(record.filters),
      record.member_orgs_hash,
      record.member_org_hashes,
      record.org_count,
      record.run_count,
      record.revision,
      record.receipt_id,
    ],
  );
  return releaseId;
}
