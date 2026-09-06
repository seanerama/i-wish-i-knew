// Own evidence (stage 9; ADR-0002 "Members can inspect their own evidence").
// The requester's own runs for the queried protocol, each with whether it is
// compatible with the query and why not when it is not. Ids are the caller's
// own, so they may appear. Nothing here is read from another organization's
// rows, and nothing here is decrypted: the classification uses the plaintext
// index columns only.
import type { OwnEvidence, OwnRun, OwnRunReason, ProtocolVersion } from '@iwik/contracts';
import type { Queryable } from '../../db.js';
import type { CohortFilters } from '../cohort/index.js';
import type { IndexContext } from '../intake/projection.js';
import { CANDIDATE_STATUSES, matchesFilters } from '../matching/index.js';

export const OWN_EVIDENCE_LIMIT = 100;

export const OWN_EVIDENCE_NOTE =
  "Your organization's own runs for this protocol; ids are yours. Nothing here is released to any other organization.";

interface OwnRow {
  run_id: string;
  received_at: Date;
  evidence_revision: string | number;
  execution_status: string;
  sharing_policy: string;
  backfill_version: number | null;
  withdrawn_at: Date | null;
  is_fixture: boolean;
  duplicate_of: string | null;
  index_version: number | null;
  index_context: IndexContext | null;
  harness_digest: string;
}

export interface OwnEvidenceSpec {
  org_ref: string;
  protocol: ProtocolVersion;
  filters: CohortFilters;
  revision: number;
  /** Whether the query path formed a cohort (so compatible runs are in it). */
  cohort_formed: boolean;
}

function asStatus(value: string): OwnRun['execution_status'] {
  switch (value) {
    case 'attempted':
    case 'succeeded':
    case 'failed':
    case 'excluded':
    case 'unobserved':
      return value;
    default:
      return 'excluded';
  }
}

/** The same rules as matching, applied to one own row; empty means compatible. */
export function classifyOwnRun(row: OwnRow, spec: OwnEvidenceSpec): OwnRunReason[] {
  const reasons: OwnRunReason[] = [];
  if (row.index_version === null) reasons.push('not_indexed');
  if (row.is_fixture) reasons.push('fixture');
  if (row.duplicate_of !== null) reasons.push('duplicate');
  if (row.sharing_policy !== 'cooperative' || row.backfill_version === null)
    reasons.push('private');
  // Withdrawn is withdrawn, whatever revision the query pins (ADR-0002 §6).
  if (row.withdrawn_at !== null) reasons.push('withdrawn');
  if (Number(row.evidence_revision) > spec.revision) reasons.push('after_as_of');
  if (!spec.protocol.compatibility.harness_digests.includes(row.harness_digest)) {
    reasons.push('harness_incompatible');
  }
  if (!CANDIDATE_STATUSES.includes(row.execution_status)) reasons.push('status_not_countable');
  if (row.index_version !== null && !matchesFilters(row.index_context, spec.filters)) {
    reasons.push('filter_mismatch');
  }
  return reasons;
}

export async function ownEvidence(db: Queryable, spec: OwnEvidenceSpec): Promise<OwnEvidence> {
  const res = await db.query<OwnRow>(
    `SELECT run_id, received_at, evidence_revision, execution_status, sharing_policy,
            backfill_version, withdrawn_at, is_fixture, duplicate_of,
            index_version, index_context, harness_digest
       FROM evidence.runs
      WHERE org_ref = $1 AND protocol_ref = $2
      ORDER BY received_at DESC, run_id DESC
      LIMIT $3`,
    [spec.org_ref, spec.protocol.ref, OWN_EVIDENCE_LIMIT],
  );
  const runs: OwnRun[] = res.rows.map((row) => {
    const reasons = classifyOwnRun(row, spec);
    const compatible = reasons.length === 0;
    return {
      run_id: row.run_id,
      received_at: row.received_at.toISOString(),
      execution_status: asStatus(row.execution_status),
      sharing_policy: row.sharing_policy === 'cooperative' ? 'cooperative' : 'private',
      compatible,
      in_cohort: compatible && spec.cohort_formed,
      reasons,
    };
  });
  return {
    runs,
    compatible: runs.filter((r) => r.compatible).length,
    in_cohort: runs.filter((r) => r.in_cohort).length,
    note: OWN_EVIDENCE_NOTE,
  };
}
