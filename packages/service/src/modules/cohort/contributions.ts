// The contributions ledger (stage 8): evidence.contributions, one row per
// (protocol, organization), maintained inside the intake and withdrawal
// transactions and rebuilt by the index_backfill job. Kept apart from the
// cohort module so the jobs module can import it without a cycle through
// intake.
import type { Queryable } from '../../db.js';

export interface ContributionRow {
  protocol_ref: string;
  org_ref: string;
  runs_accepted: number;
  runs_withdrawn: number;
  last_received: Date | null;
}

export async function listContributions(
  db: Queryable,
  protocolRef: string,
): Promise<ContributionRow[]> {
  const res = await db.query<ContributionRow>(
    `SELECT protocol_ref, org_ref, runs_accepted, runs_withdrawn, last_received
       FROM evidence.contributions WHERE protocol_ref = $1 ORDER BY org_ref`,
    [protocolRef],
  );
  return res.rows;
}

/** One accepted, countable run: +1 accepted, last_received now. */
export async function recordContribution(
  db: Queryable,
  protocolRef: string,
  orgRef: string,
): Promise<void> {
  await db.query(
    `INSERT INTO evidence.contributions (protocol_ref, org_ref, runs_accepted, last_received)
     VALUES ($1, $2, 1, now())
     ON CONFLICT (protocol_ref, org_ref) DO UPDATE
       SET runs_accepted = evidence.contributions.runs_accepted + 1, last_received = now()`,
    [protocolRef, orgRef],
  );
}

/**
 * Rebuild the ledger from the runs whose projection is trusted. Idempotent;
 * `index_backfill` runs it after projecting, and it is the recovery path if
 * the ledger ever disagrees with the rows.
 */
export async function repairContributions(db: Queryable): Promise<number> {
  const upserted = await db.query(
    `INSERT INTO evidence.contributions
       (protocol_ref, org_ref, runs_accepted, runs_withdrawn, last_received)
     SELECT protocol_ref, org_ref,
            count(*) FILTER (WHERE withdrawn_at IS NULL),
            count(*) FILTER (WHERE withdrawn_at IS NOT NULL),
            max(received_at)
       FROM evidence.runs
      WHERE index_version IS NOT NULL AND is_fixture = false AND duplicate_of IS NULL
      GROUP BY protocol_ref, org_ref
     ON CONFLICT (protocol_ref, org_ref) DO UPDATE
       SET runs_accepted = EXCLUDED.runs_accepted,
           runs_withdrawn = EXCLUDED.runs_withdrawn,
           last_received = EXCLUDED.last_received`,
  );
  // A ledger row whose runs are all gone (or all became duplicates) reads zero.
  await db.query(
    `UPDATE evidence.contributions c SET runs_accepted = 0, runs_withdrawn = 0
      WHERE NOT EXISTS (
        SELECT 1 FROM evidence.runs r
         WHERE r.protocol_ref = c.protocol_ref AND r.org_ref = c.org_ref
           AND r.index_version IS NOT NULL AND r.is_fixture = false AND r.duplicate_of IS NULL)
        AND (c.runs_accepted <> 0 OR c.runs_withdrawn <> 0)`,
  );
  return upserted.rowCount ?? 0;
}
