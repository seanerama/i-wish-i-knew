// Claim rows (stage 10; contracts/evidence-envelope.md `Claim`).
//
// A released receipt's findings become one Claim each: origin `measured`
// (the finding was computed from measurements), corroboration `unreplicated`
// (nobody has reproduced it yet), status `supported` (the cohort supports
// it). The rows are created inside the stage 9 release transaction so the
// receipt can carry their ids on its findings, and `ensureClaimsForReceipt`
// is idempotent on (receipt_id, claim_key), so a receipt that predates this
// migration gets its rows the first time something needs them. A claim names
// its cohort as bands only; it never lists a run.
import type { AnswerReceipt, Claim, ReceiptFinding, ReceiptResult } from '@iwik/contracts';
import { validate } from '@iwik/contracts';
import type { Queryable } from '../../db.js';
import { ulid } from '../../ulid.js';

export interface ClaimRow {
  claim_id: string;
  receipt_id: string | null;
  org_ref: string;
  protocol_ref: string;
  claim_key: string;
  status: Claim['status'];
  origin: Claim['origin'];
  corroboration: Claim['corroboration'];
  payload: ClaimPayload;
  evidence_revision: string | number;
  created_at: Date;
  updated_at: Date;
}

/** The Claim members not held in their own column. */
export interface ClaimPayload {
  statement?: string;
  derivation: Claim['derivation'];
  supporting_runs?: string;
  uncertainty?: string;
  limitations?: string[];
}

export function toClaim(row: ClaimRow): Claim {
  const claim: Claim = {
    claim_id: row.claim_id,
    ...(row.receipt_id !== null ? { receipt_id: row.receipt_id } : {}),
    protocol_ref: row.protocol_ref,
    claim: row.claim_key,
    ...(row.payload.statement !== undefined ? { statement: row.payload.statement } : {}),
    status: row.status,
    origin: row.origin,
    corroboration: row.corroboration,
    derivation: row.payload.derivation,
    ...(row.payload.supporting_runs !== undefined
      ? { supporting_runs: row.payload.supporting_runs }
      : {}),
    ...(row.payload.uncertainty !== undefined ? { uncertainty: row.payload.uncertainty } : {}),
    ...(row.payload.limitations !== undefined ? { limitations: row.payload.limitations } : {}),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
  const check = validate('Claim', claim);
  if (!check.ok) throw new Error('stored claim is not a valid Claim');
  return claim;
}

export interface ReleasedReceiptLike {
  receipt_id: string;
  org_ref: string;
  protocol_ref: string;
  calculation_version: string;
  policy_version: string;
  evidence_revision: number;
  cohort: { orgs: string; runs: string };
  result: Omit<ReceiptResult, 'own_evidence'> | undefined;
}

/** Findings that were actually released (a withheld finding is not a claim). */
export function releasedFindings(result: ReleasedReceiptLike['result']): ReceiptFinding[] {
  return (result?.findings ?? []).filter((f) => f.status === 'released');
}

/**
 * One claim row per released finding, idempotent on (receipt_id, claim_key);
 * returns claim ids by claim key (existing rows included). Bands come from
 * the receipt itself, so nothing exact is written.
 */
export async function ensureClaimsForReceipt(
  db: Queryable,
  receipt: ReleasedReceiptLike,
  ids: Record<string, string> = {},
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const uncertainty = receipt.result?.uncertainty?.kind;
  const limitations = receipt.result?.limitations;
  for (const finding of releasedFindings(receipt.result)) {
    const payload: ClaimPayload = {
      ...(finding.statement !== undefined ? { statement: finding.statement } : {}),
      derivation: {
        method: 'cooperative_release',
        calculation_version: receipt.calculation_version,
        policy_version: receipt.policy_version,
        evidence_revision: receipt.evidence_revision,
        orgs: receipt.cohort.orgs,
        runs: receipt.cohort.runs,
      },
      supporting_runs: receipt.cohort.runs,
      ...(uncertainty !== undefined ? { uncertainty } : {}),
      ...(limitations !== undefined ? { limitations } : {}),
    };
    const claimId = ids[finding.claim] ?? ulid();
    const inserted = await db.query<{ claim_id: string }>(
      `INSERT INTO evidence.claims
         (claim_id, receipt_id, org_ref, protocol_ref, claim_key, status, origin, corroboration,
          payload, evidence_revision)
       VALUES ($1, $2, $3, $4, $5, 'supported', 'measured', 'unreplicated', $6, $7)
       ON CONFLICT (receipt_id, claim_key) WHERE receipt_id IS NOT NULL DO NOTHING
       RETURNING claim_id`,
      [
        claimId,
        receipt.receipt_id,
        receipt.org_ref,
        receipt.protocol_ref,
        finding.claim,
        JSON.stringify(payload),
        receipt.evidence_revision,
      ],
    );
    const row = inserted.rows[0];
    if (row !== undefined) {
      out[finding.claim] = row.claim_id;
      continue;
    }
    const existing = await db.query<{ claim_id: string }>(
      `SELECT claim_id FROM evidence.claims WHERE receipt_id = $1 AND claim_key = $2`,
      [receipt.receipt_id, finding.claim],
    );
    const found = existing.rows[0];
    if (found !== undefined) out[finding.claim] = found.claim_id;
  }
  return out;
}

/**
 * Mint the claim ids for a release before the receipt is written, so the
 * findings can carry them (`claim_id`, additive on ReceiptFinding). The
 * sections are copied: the cached cooperative outcome stays caller-free.
 */
export function stampClaimIds(sections: Omit<ReceiptResult, 'own_evidence'>): {
  sections: Omit<ReceiptResult, 'own_evidence'>;
  ids: Record<string, string>;
} {
  const ids: Record<string, string> = {};
  const findings = (sections.findings ?? []).map((finding) => {
    if (finding.status !== 'released') return finding;
    const claimId = ulid();
    ids[finding.claim] = claimId;
    return { ...finding, claim_id: claimId };
  });
  return { sections: { ...sections, findings }, ids };
}

/**
 * The receipt-side view a stored query receipt (as `findReceipt` returns it)
 * gives `ensureClaimsForReceipt`. The stored payload is the AnswerReceipt
 * the service itself assembled and validated, so the members are read back
 * as such; undefined when it is not a released query receipt.
 */
export function receiptForClaims(
  receipt: Record<string, unknown> & { receipt_id: string; evidence_revision: number },
  orgRef: string,
): ReleasedReceiptLike | undefined {
  if (receipt['kind'] !== 'query' || receipt['status'] !== 'released') return undefined;
  const stored = receipt as unknown as AnswerReceipt;
  const result = stored.result;
  let sections: ReleasedReceiptLike['result'];
  if (result !== undefined) {
    // The caller's own evidence is not part of any claim.
    const rest: ReceiptResult = { ...result };
    delete rest.own_evidence;
    sections = rest;
  }
  return {
    receipt_id: receipt.receipt_id,
    org_ref: orgRef,
    protocol_ref: stored.cohort.protocol_ref,
    calculation_version: stored.calculation_version,
    policy_version: stored.policy_version,
    evidence_revision: receipt.evidence_revision,
    cohort: { orgs: stored.cohort.orgs, runs: stored.cohort.runs },
    result: sections,
  };
}

export async function findClaim(db: Queryable, claimId: string): Promise<ClaimRow | undefined> {
  const res = await db.query<ClaimRow>(`SELECT * FROM evidence.claims WHERE claim_id = $1`, [
    claimId,
  ]);
  return res.rows[0];
}

export async function claimsOfReceipt(db: Queryable, receiptId: string): Promise<ClaimRow[]> {
  const res = await db.query<ClaimRow>(
    `SELECT * FROM evidence.claims WHERE receipt_id = $1 ORDER BY claim_key`,
    [receiptId],
  );
  return res.rows;
}
