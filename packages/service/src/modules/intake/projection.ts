// The plaintext index projection of a Run (stage 8): what intake writes next
// to the ciphertext so stage 9 can form a cohort without decrypting bodies.
// Everything here is derived from fields the run already carries; the
// projection is the ONLY plaintext copy of any part of the body, and it is
// limited to the protocol's `required_context` keys (contracts/
// evidence-envelope.md: "matching required context fields" are the
// compatibility test, so they are the only keys a cohort filter can name).
//
// measurement_digest recipe (the dedupe key):
//
//   "sha256:" + hex(SHA-256(JCS({
//     protocol_digest:     run.protocol_digest,
//     target_label_digest: run.target.label_digest,
//     result:              run.result,
//     attempts_summary:    run.accounting
//   })))
//
// JCS is RFC 8785 via `canonicalize` in @iwik/contracts (the same function
// that produces the signing payload and the protocol digest). The digest
// deliberately ignores run_id, attempt_id, node_id, timestamps, context,
// artifacts, and the signature: two uploads of the same measurement from two
// nodes of one organization differ only in those and must collide.
import type { ContextOrigin, ContextValue, Run } from '@iwik/contracts';
import { digest } from '@iwik/contracts';
import type { ErrorDetail } from '../../errors.js';
import { sanitizeValue } from './sanitize.js';
import type { SanitizeOptions } from './sanitize.js';

/** Bump when the projection changes shape; rows carry the version they were projected with. */
export const INDEX_VERSION = 1;

export interface IndexedField {
  value: ContextValue;
  origin: ContextOrigin;
}

/** `index_context`: one entry per required key, never anything else. */
export type IndexContext = Record<string, IndexedField>;

export function measurementDigest(run: Run): string {
  return digest({
    protocol_digest: run.protocol_digest,
    target_label_digest: run.target.label_digest,
    result: run.result,
    attempts_summary: run.accounting,
  });
}

export interface Projection {
  index_context: IndexContext;
  /**
   * Sanitization findings on the projected values (rule `secret_pattern` or
   * `string_too_long`, path `/context/<key>`), for the caller to reject
   * (intake) or redact (backfill). A run that passed intake cannot trip
   * these; a row that predates a stricter pattern list can.
   */
  issues: ErrorDetail[];
}

/**
 * Project `run.context` onto `requiredContext`. A required key that is
 * absent is emitted as `{ value: null, origin: "unknown" }`, as the contract
 * says a missing required field must be, never dropped; a key that is not
 * required is never projected, whatever the run carries. When the same key
 * appears twice the first field wins (intake does not reject repeats).
 */
export function projectIndexContext(
  run: Run,
  requiredContext: readonly string[],
  sanitize: SanitizeOptions,
): Projection {
  const fields = new Map<string, IndexedField>();
  for (const field of run.context) {
    if (!fields.has(field.key)) fields.set(field.key, { value: field.value, origin: field.origin });
  }
  const projected: IndexContext = {};
  const issues: ErrorDetail[] = [];
  for (const key of requiredContext) {
    const found = fields.get(key) ?? { value: null, origin: 'unknown' as const };
    // Only the value is member data; the key is registry vocabulary.
    const scan = sanitizeValue(found.value, sanitize);
    if (scan.issues.length > 0) {
      for (const issue of scan.issues) issues.push({ path: `/context/${key}`, rule: issue.rule });
    }
    projected[key] = found;
  }
  return { index_context: projected, issues };
}

/** The projection with every offending value replaced by `null` / `unknown` (backfill). */
export function redactProjection(projection: Projection): IndexContext {
  const out: IndexContext = { ...projection.index_context };
  for (const issue of projection.issues) {
    const key = issue.path.replace(/^\/context\//, '');
    if (key in out) out[key] = { value: null, origin: 'unknown' };
  }
  return out;
}

export function isFixtureRun(run: Run): boolean {
  return run.target.kind === 'fixture';
}
