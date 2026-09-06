// `iwik preview`, `iwik submit`, `iwik receipt` (contracts/member-api.md).
// Preview strips the vault-only fields, signs the JCS body, stores the
// preview id and writes the signed Run; submit refuses without a stored
// preview and posts exactly the stored Run with that preview id; both are
// safe to rerun.
import type { Run } from '@iwik/contracts';
import { validate } from '@iwik/contracts';
import { ApiClient } from './client.js';
import type { FetchLike } from './client.js';
import { RunnerError } from './errors.js';
import { homePaths, loadConfig, loadToken, resolveHome } from './home.js';
import { loadKey, signPayload } from './keys.js';
import { contentDigest, signingPayload } from './signing.js';
import {
  readDraft,
  readMeta,
  readPreview,
  readSignedRun,
  writePreview,
  writeReceipt,
  writeSignedRun,
} from './vault.js';
import type { PreviewRecord } from './vault.js';

export interface ClientOptions {
  home?: string;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export interface PreviewOptions extends ClientOptions {
  sharingPolicy?: Run['submission']['sharing_policy'];
}

export interface PreviewResult {
  run_id: string;
  preview_id: string;
  content_digest: string;
  expires_at: string;
  sanitization: unknown;
  would_store: unknown;
  /** Exactly what `iwik submit` will send (minus the preview id). */
  body: { run: Run };
}

export interface SubmitResult {
  run_id: string;
  /** 201 on first acceptance, 200 on an idempotent resubmission. */
  status: number;
  receipt: Record<string, unknown>;
}

function clientFor(home: string, options: ClientOptions): ApiClient {
  const config = loadConfig(home);
  return new ApiClient(config.service_url, loadToken(home), options.fetch);
}

/**
 * Strip the vault-only fields and sign: the wire form of a vault draft.
 * `signed_at` is fixed the first time a run is signed and reused by later
 * previews, so re-previewing an unchanged draft yields the same content
 * digest (Ed25519 is deterministic) and a resubmission stays idempotent
 * instead of turning into a `run_conflict`.
 */
export function wireRun(
  home: string,
  runId: string,
  sharingPolicy: Run['submission']['sharing_policy'],
): Run {
  const draft = readDraft(home, runId);
  const key = loadKey(homePaths(home).key);
  const previous = readSignedRun(home, runId);
  const target = { kind: draft.target.kind, label_digest: draft.target.label_digest };
  const run: Run = {
    ...draft,
    target,
    submission: {
      signed_at: previous?.submission.signed_at ?? new Date().toISOString(),
      key_id: key.key_id,
      signature: 'AA==',
      sharing_policy: sharingPolicy,
    },
  };
  run.submission.signature = signPayload(key, signingPayload(run));
  const validation = validate('Run', run);
  if (!validation.ok) {
    throw new RunnerError('run_invalid', `run ${runId} is not a valid Run`, [...validation.errors]);
  }
  return run;
}

export async function preview(runId: string, options: PreviewOptions = {}): Promise<PreviewResult> {
  const home = resolveHome(options.home, options.env);
  const meta = readMeta(home, runId);
  const run = wireRun(home, runId, options.sharingPolicy ?? meta.sharing_policy);
  const client = clientFor(home, options);
  const res = await client.post<{
    preview_id: string;
    content_digest: string;
    expires_at: string;
    sanitization: unknown;
    would_store: unknown;
  }>('/v1/contributions/preview', { run });
  const body = res.body;
  if (typeof body?.preview_id !== 'string' || typeof body.content_digest !== 'string') {
    throw new RunnerError('api_error', 'preview response lacks preview_id/content_digest');
  }
  const local = contentDigest(run);
  if (body.content_digest !== local) {
    throw new RunnerError(
      'api_error',
      'preview content digest differs from the local digest of the same body (canonicalization drift)',
    );
  }
  const record: PreviewRecord = {
    preview_id: body.preview_id,
    content_digest: body.content_digest,
    expires_at: body.expires_at,
    previewed_at: new Date().toISOString(),
    sanitization: body.sanitization,
    would_store: body.would_store,
  };
  writeSignedRun(home, runId, run);
  writePreview(home, runId, record);
  return {
    run_id: runId,
    preview_id: record.preview_id,
    content_digest: record.content_digest,
    expires_at: record.expires_at,
    sanitization: record.sanitization,
    would_store: record.would_store,
    body: { run },
  };
}

export async function submit(runId: string, options: ClientOptions = {}): Promise<SubmitResult> {
  const home = resolveHome(options.home, options.env);
  readDraft(home, runId);
  const stored = readPreview(home, runId);
  const run = readSignedRun(home, runId);
  if (stored === undefined || run === undefined) {
    throw new RunnerError(
      'preview_required',
      `run ${runId} has no stored preview; run "iwik preview ${runId}" first`,
    );
  }
  if (Date.parse(stored.expires_at) < Date.now()) {
    throw new RunnerError(
      'preview_expired',
      `the preview for run ${runId} expired at ${stored.expires_at}; run "iwik preview ${runId}" again`,
    );
  }
  const client = clientFor(home, options);
  const res = await client.post<Record<string, unknown>>('/v1/runs', {
    preview_id: stored.preview_id,
    run,
  });
  const receipt = res.body ?? {};
  writeReceipt(home, runId, receipt);
  return { run_id: runId, status: res.status, receipt };
}

export async function receipt(
  id: string,
  options: ClientOptions = {},
): Promise<Record<string, unknown>> {
  const home = resolveHome(options.home, options.env);
  const client = clientFor(home, options);
  const res = await client.get<Record<string, unknown>>(`/v1/receipts/${encodeURIComponent(id)}`);
  return res.body ?? {};
}
