// The vault: `<home>/vault/<run_id>/`, directory 0700, every file 0600.
//
//   run.draft.json   the assembled Run without `submission` and with the
//                    vault-only `target.label` (written by `iwik run`)
//   run.json         the signed, sanitized Run exactly as previewed/submitted
//                    (written by `iwik preview`)
//   preview.json     preview_id, content digest, expiry, sanitization report
//   receipt.json     the intake receipt (written by `iwik submit`)
//   input.json       what the harness was given (credentials removed after the run)
//   stdout, stderr   harness output
//   attempts.jsonl, result.json, context.json   harness outputs (moved up from output/)
//   output/          anything else the harness wrote
//   egress.jsonl     egress-guard denials, one JSON line each
//   vault.json       runner metadata: harness exit, overrides, issues, target
import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactCommitment, Run, RunTarget } from '@iwik/contracts';
import { fileDigest } from '@iwik/contracts';
import { RunnerError } from './errors.js';
import { DIR_MODE, FILE_MODE, homePaths, readJsonFile, writePrivateJson } from './home.js';
import { ULID_PATTERN } from './ulid.js';

export interface VaultPaths {
  dir: string;
  draft: string;
  run: string;
  preview: string;
  receipt: string;
  input: string;
  stdout: string;
  stderr: string;
  attempts: string;
  result: string;
  context: string;
  output: string;
  egress: string;
  meta: string;
}

export function vaultPaths(home: string, runId: string): VaultPaths {
  if (!ULID_PATTERN.test(runId)) throw new RunnerError('usage', 'run id must be a ULID');
  const dir = join(homePaths(home).vault, runId);
  return {
    dir,
    draft: join(dir, 'run.draft.json'),
    run: join(dir, 'run.json'),
    preview: join(dir, 'preview.json'),
    receipt: join(dir, 'receipt.json'),
    input: join(dir, 'input.json'),
    stdout: join(dir, 'stdout'),
    stderr: join(dir, 'stderr'),
    attempts: join(dir, 'attempts.jsonl'),
    result: join(dir, 'result.json'),
    context: join(dir, 'context.json'),
    output: join(dir, 'output'),
    egress: join(dir, 'egress.jsonl'),
    meta: join(dir, 'vault.json'),
  };
}

/** The Run before signing: no `submission`, and the target keeps its vault-only label. */
export type RunDraft = Omit<Run, 'submission' | 'target'> & {
  target: RunTarget & { label: string };
};

/**
 * The fixed vocabulary of `Run.exclusion_reason` on the wire. Anything more
 * specific (a host name, a harness stderr line, a context key) is vault-only
 * detail in `VaultMeta.exclusion_detail`.
 */
export const EXCLUSION_REASONS = [
  'egress_denied',
  'harness_protocol_violation',
  'attempt_count_mismatch',
  'result_schema_invalid',
  'required_context_unknown',
  'context_schema_violation',
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface VaultMeta {
  run_id: string;
  /** The plan this run executed (an ad-hoc `iwik run` mints one). */
  plan_id?: string;
  created_at: string;
  protocol_ref: string;
  manifest_source: 'registry' | 'offline';
  service_url: string | undefined;
  target: { label: string; kind: RunTarget['kind']; allowed_hosts: string };
  sharing_policy: Run['submission']['sharing_policy'];
  /** Estimate from the pack's cost model that the budget check accepted. */
  estimated_cost_usd?: number;
  /** Vault-only explanation of `exclusion_reason`; never leaves the node. */
  exclusion_detail?: string | undefined;
  harness: {
    exit_code: number | null;
    signal: string | null;
    timed_out: boolean;
    duration_ms: number;
    stderr_first_line: string | null;
  };
  context_overrides: unknown[];
  context_unknown: string[];
  egress_violations: unknown[];
  /** Runner observations that shaped execution_status; never values from the target. */
  issues: string[];
}

export interface PreviewRecord {
  preview_id: string;
  content_digest: string;
  expires_at: string;
  previewed_at: string;
  sanitization: unknown;
  would_store: unknown;
}

export function readDraft(home: string, runId: string): RunDraft {
  const paths = vaultPaths(home, runId);
  if (!existsSync(paths.draft)) {
    throw new RunnerError('run_not_found', `no run ${runId} in the vault (${paths.dir})`);
  }
  return readJsonFile<RunDraft>(paths.draft);
}

export function readMeta(home: string, runId: string): VaultMeta {
  const paths = vaultPaths(home, runId);
  if (!existsSync(paths.meta)) {
    throw new RunnerError('run_not_found', `no run ${runId} in the vault (${paths.dir})`);
  }
  return readJsonFile<VaultMeta>(paths.meta);
}

export function readPreview(home: string, runId: string): PreviewRecord | undefined {
  const file = vaultPaths(home, runId).preview;
  return existsSync(file) ? readJsonFile<PreviewRecord>(file) : undefined;
}

export function readSignedRun(home: string, runId: string): Run | undefined {
  const file = vaultPaths(home, runId).run;
  return existsSync(file) ? readJsonFile<Run>(file) : undefined;
}

export function writePreview(home: string, runId: string, record: PreviewRecord): void {
  writePrivateJson(vaultPaths(home, runId).preview, record);
}

export function writeSignedRun(home: string, runId: string, run: Run): void {
  writePrivateJson(vaultPaths(home, runId).run, run);
}

export function writeReceipt(home: string, runId: string, receipt: unknown): void {
  writePrivateJson(vaultPaths(home, runId).receipt, receipt);
}

export function readReceipt(home: string, runId: string): Record<string, unknown> | undefined {
  const file = vaultPaths(home, runId).receipt;
  return existsSync(file) ? readJsonFile<Record<string, unknown>>(file) : undefined;
}

/** Tighten every file under `dir` to 0600 and every directory to 0700 (harness outputs arrive with the umask default). */
export function tightenPermissions(dir: string): void {
  chmodSync(dir, DIR_MODE);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) tightenPermissions(full);
    else if (entry.isFile()) chmodSync(full, FILE_MODE);
  }
}

export function artifactFor(
  file: string,
  kind: ArtifactCommitment['kind'],
  mediaType: string,
): ArtifactCommitment | undefined {
  if (!existsSync(file)) return undefined;
  return {
    digest: fileDigest(file),
    kind,
    size_bytes: statSync(file).size,
    media_type: mediaType,
    access: 'vault_only',
  };
}

/** Every run id in the vault, newest first by ULID order. */
export function listRuns(home: string): string[] {
  const vault = homePaths(home).vault;
  if (!existsSync(vault)) return [];
  return readdirSync(vault)
    .filter((name) => ULID_PATTERN.test(name))
    .sort()
    .reverse();
}

export function readEgressLog(file: string): unknown[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return { raw: line };
      }
    });
}
