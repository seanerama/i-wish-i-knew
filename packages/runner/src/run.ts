// `iwik run`: policy check, pack verification against the registry (or an
// offline manifest), harness execution under the egress guard, accounting
// derived from attempts.jsonl, context merge, Run assembly, vault write.
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextValue, Run, RunAccounting, RunTarget } from '@iwik/contracts';
import { digest as jcsDigest, validate } from '@iwik/contracts';
import { ApiClient } from './client.js';
import type { FetchLike } from './client.js';
import {
  mergeContext,
  parseContextArgs,
  parseHarnessContext,
  projection,
  validateAgainst,
} from './context.js';
import type { ContextOverride } from './context.js';
import { RunnerError } from './errors.js';
import { spawnHarness } from './harness.js';
import type { SpawnResult } from './harness.js';
import {
  ensurePrivateDir,
  homePaths,
  loadConfig,
  loadToken,
  readJsonFile,
  resolveHome,
  writePrivateFile,
  writePrivateJson,
} from './home.js';
import { defaultPacksDir, loadLocalPack, parseManifest, verifyPack } from './pack.js';
import type { LocalPack, Manifest } from './pack.js';
import { checkExecution, loadPolicy, targetHost } from './policy.js';
import { ulid, ULID_PATTERN } from './ulid.js';
import { artifactFor, readEgressLog, tightenPermissions, vaultPaths } from './vault.js';
import type { RunDraft, VaultMeta } from './vault.js';

export interface RunOptions {
  home?: string;
  protocol: string;
  /** Target URL (http or https). */
  target: string;
  planned?: number;
  /** `key=value` strings or a ready map; values are typed like the CLI types them. */
  context?: readonly string[] | Record<string, ContextValue>;
  targetKind?: RunTarget['kind'];
  /** Verify against the pack's own protocol.json (or `manifest`) instead of the registry. */
  offline?: boolean;
  /** Path to a saved `GET /v1/protocols/{ref}` body; implies offline verification against it. */
  manifest?: string;
  /** Per-attempt timeout passed to the harness (input.timeout_ms). */
  timeoutMs?: number;
  maxTokens?: number;
  /** Name of an environment variable holding the target's API key (never the key itself). */
  apiKeyEnv?: string;
  model?: string;
  investigationId?: string;
  sharingPolicy?: Run['submission']['sharing_policy'];
  planId?: string;
  packsDir?: string;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export interface RunResult {
  run_id: string;
  vault_dir: string;
  execution_status: Run['execution_status'];
  exclusion_reason: string | undefined;
  accounting: RunAccounting;
  harness: SpawnResult;
  context_overrides: ContextOverride[];
  context_unknown: string[];
  egress_violations: unknown[];
  issues: string[];
}

interface AttemptLine {
  status: string;
}

function parseAttempts(file: string): { lines: AttemptLine[]; issues: string[] } {
  const issues: string[] = [];
  if (!existsSync(file)) return { lines: [], issues: ['attempts.jsonl is missing'] };
  const lines: AttemptLine[] = [];
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((raw, i) => {
    if (raw.trim() === '') return;
    try {
      const parsed = JSON.parse(raw) as { status?: unknown };
      if (
        typeof parsed.status === 'string' &&
        ['succeeded', 'failed', 'excluded', 'unobserved'].includes(parsed.status)
      ) {
        lines.push({ status: parsed.status });
      } else {
        issues.push(`attempts.jsonl line ${i + 1} has no valid status`);
      }
    } catch {
      issues.push(`attempts.jsonl line ${i + 1} is not JSON`);
    }
  });
  return { lines, issues };
}

type Remainder = 'excluded' | 'unobserved';

/** Run.accounting from the attempt lines; attempts the harness never reported go to `remainder`. */
export function deriveAccounting(
  lines: readonly AttemptLine[],
  planned: number,
  remainder: Remainder,
): { accounting: RunAccounting; overflow: number } {
  const count = (status: string): number => lines.filter((l) => l.status === status).length;
  const succeeded = count('succeeded');
  const failed = count('failed');
  let excluded = count('excluded');
  let unobserved = count('unobserved');
  const reported = succeeded + failed + excluded + unobserved;
  const overflow = Math.max(0, reported - planned);
  const missing = Math.max(0, planned - reported);
  if (remainder === 'excluded') excluded += missing;
  else unobserved += missing;
  return {
    accounting: {
      planned: overflow > 0 ? reported : planned,
      attempted: succeeded + failed,
      succeeded,
      failed,
      excluded,
      unobserved,
    },
    overflow,
  };
}

async function fetchManifest(
  options: RunOptions,
  home: string,
  local: LocalPack,
): Promise<{
  manifest: Manifest;
  source: VaultMeta['manifest_source'];
  serviceUrl: string | undefined;
}> {
  if (options.manifest !== undefined) {
    let parsed: unknown;
    try {
      parsed = readJsonFile<unknown>(options.manifest);
    } catch {
      throw new RunnerError('manifest_invalid', `cannot read manifest ${options.manifest}`);
    }
    return {
      manifest: parseManifest(parsed, options.manifest),
      source: 'offline',
      serviceUrl: undefined,
    };
  }
  if (options.offline === true) {
    return {
      manifest: parseManifest(local.protocol, 'protocol.json'),
      source: 'offline',
      serviceUrl: undefined,
    };
  }
  const config = loadConfig(home);
  const client = new ApiClient(config.service_url, loadToken(home), options.fetch);
  const res = await client.get<unknown>(`/v1/protocols/${encodeURIComponent(local.ref)}`);
  return {
    manifest: parseManifest(res.body, `${config.service_url}/v1/protocols/${local.ref}`),
    source: 'registry',
    serviceUrl: config.service_url,
  };
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RunnerError('usage', `${name} must be a positive integer`);
  }
  return value;
}

export async function run(options: RunOptions): Promise<RunResult> {
  const env = options.env ?? process.env;
  const home = resolveHome(options.home, env);
  const planned = positiveInt(options.planned, 10, 'planned');
  const timeoutMs = positiveInt(options.timeoutMs, 30000, 'timeout');
  const maxTokens = positiveInt(options.maxTokens, 64, 'max-tokens');
  const targetKind: RunTarget['kind'] = options.targetKind ?? 'service';
  const sharingPolicy = options.sharingPolicy ?? 'private';
  if (options.investigationId !== undefined && !ULID_PATTERN.test(options.investigationId)) {
    throw new RunnerError('usage', 'investigation id must be a ULID');
  }
  const operatorContext = Array.isArray(options.context)
    ? parseContextArgs(options.context)
    : ((options.context as Record<string, ContextValue> | undefined) ?? {});

  // 1. Policy first: a denied run never touches the pack, the registry, or the vault.
  const policy = loadPolicy(home);
  const targetUrl = checkExecution(policy, options.target);
  const allowedHosts = targetHost(targetUrl);

  // 2. Identity: the Run carries this node's id.
  const config = existsSync(homePaths(home).config) ? loadConfig(home) : undefined;
  const nodeId = config?.node_id;
  if (nodeId === undefined) {
    throw new RunnerError(
      'not_initialized',
      'node id is not configured; run "iwik init --node-id <ulid>" with the id issued with your token',
    );
  }

  // 3. Pack and digests.
  const packsDir =
    options.packsDir ?? env['IWIK_PACKS_DIR'] ?? config?.packs_dir ?? defaultPacksDir;
  const local = loadLocalPack(packsDir, options.protocol);
  const { manifest, source, serviceUrl } = await fetchManifest(options, home, local);
  verifyPack(local, manifest);

  // 4. Vault entry and harness input.
  const runId = ulid();
  const paths = vaultPaths(home, runId);
  ensurePrivateDir(paths.dir);
  ensurePrivateDir(paths.output);
  const apiKey = options.apiKeyEnv !== undefined ? env[options.apiKeyEnv] : undefined;
  if (options.apiKeyEnv !== undefined && (apiKey === undefined || apiKey === '')) {
    rmSync(paths.dir, { recursive: true, force: true });
    throw new RunnerError('usage', `environment variable ${options.apiKeyEnv} is not set`);
  }
  const model = options.model ?? operatorContext['model.requested'];
  const target: Record<string, unknown> = { url: targetUrl.toString() };
  if (typeof model === 'string') target['model'] = model;
  if (apiKey !== undefined) target['api_key'] = apiKey;
  const planId = options.planId ?? ulid();
  const input = {
    plan_id: planId,
    protocol_ref: local.ref,
    target,
    context: operatorContext,
    budget: { planned, max_tokens: maxTokens },
    timeout_ms: timeoutMs,
  };
  writePrivateJson(paths.input, input);
  const startedAt = new Date().toISOString();

  // 5. Execute under the guard.
  let harness: SpawnResult;
  try {
    harness = await spawnHarness({
      harnessEntry: local.harnessEntry,
      inputFile: paths.input,
      outputDir: paths.output,
      allowedHosts,
      egressLog: paths.egress,
      stdoutFile: paths.stdout,
      stderrFile: paths.stderr,
      timeoutMs: timeoutMs * (planned + 1),
    });
  } finally {
    // Credentials never persist in the vault beyond the harness's lifetime.
    if (apiKey !== undefined) {
      delete target['api_key'];
      writePrivateJson(paths.input, input);
    }
  }
  const endedAt = new Date().toISOString();
  for (const name of ['attempts.jsonl', 'result.json', 'context.json']) {
    const from = join(paths.output, name);
    if (existsSync(from)) renameSync(from, join(paths.dir, name));
  }

  // 6. Status, accounting, context.
  const issues: string[] = [];
  const egressViolations = readEgressLog(paths.egress);
  const attempts = parseAttempts(paths.attempts);
  issues.push(...attempts.issues);

  let resultValue: Record<string, unknown> = {};
  let resultIssues: string[] = [];
  if (existsSync(paths.result)) {
    try {
      const parsed = readJsonFile<unknown>(paths.result);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const schemaIssues = validateAgainst(
          local.resultSchema,
          local.result_schema_digest,
          parsed,
        );
        if (schemaIssues.length === 0) resultValue = parsed as Record<string, unknown>;
        else resultIssues = schemaIssues.map((i) => `result.json ${i.path} ${i.rule}`);
      } else {
        resultIssues = ['result.json is not an object'];
      }
    } catch {
      resultIssues = ['result.json is not valid JSON'];
    }
  } else {
    resultIssues = ['result.json is missing'];
  }

  let harnessContext: ReturnType<typeof parseHarnessContext> = { fields: [], issues: [] };
  if (existsSync(paths.context)) {
    try {
      harnessContext = parseHarnessContext(readJsonFile<unknown>(paths.context));
    } catch {
      harnessContext = { fields: [], issues: ['context.json is not valid JSON'] };
    }
  }
  issues.push(...harnessContext.issues);
  const merged = mergeContext(manifest.required_context, operatorContext, harnessContext.fields);
  const contextSchemaIssues = validateAgainst(
    local.contextSchema,
    local.context_schema_digest,
    projection(merged.context),
  );

  let status: Run['execution_status'];
  let reason: string | undefined;
  let remainder: Remainder;
  const firstViolation = egressViolations[0] as { host?: unknown; port?: unknown } | undefined;
  if (firstViolation !== undefined) {
    status = 'excluded';
    const host = typeof firstViolation.host === 'string' ? firstViolation.host : 'unknown host';
    const port = typeof firstViolation.port === 'number' ? `:${firstViolation.port}` : '';
    reason = `egress_violation: harness attempted ${host}${port}, outside IWIK_ALLOWED_HOSTS`;
    remainder = 'excluded';
  } else if (harness.timed_out) {
    status = 'failed';
    issues.push(`harness killed after ${timeoutMs * (planned + 1)} ms`);
    remainder = 'unobserved';
  } else if (harness.exit_code === 0) {
    status = 'succeeded';
    remainder = 'excluded';
  } else if (harness.exit_code === 2) {
    status = 'excluded';
    reason = harness.stderr_first_line ?? 'protocol violated (harness exit 2)';
    remainder = 'excluded';
  } else if (harness.exit_code === 3) {
    status = 'unobserved';
    issues.push(harness.stderr_first_line ?? 'target unreachable (harness exit 3)');
    remainder = 'unobserved';
  } else {
    status = 'failed';
    issues.push(
      `harness crashed (exit ${harness.exit_code ?? 'null'}${harness.signal ? `, signal ${harness.signal}` : ''})`,
    );
    remainder = 'unobserved';
  }

  const derived = deriveAccounting(attempts.lines, planned, remainder);
  if (status === 'succeeded') {
    // A harness cannot report success without attempts to back it, a valid
    // result, and known required context (pack context schema: unknown
    // required context is `excluded`, not defaulted).
    const reported = attempts.lines.length;
    if (attempts.issues.length > 0 || reported < planned) {
      status = 'excluded';
      reason = `attempts_missing: harness reported ${reported} of ${planned} planned attempts`;
    } else if (derived.overflow > 0) {
      status = 'excluded';
      reason = `attempts_exceed_planned: harness reported ${reported} attempts for ${planned} planned`;
    } else if (resultIssues.length > 0) {
      status = 'excluded';
      reason = `result_invalid: ${resultIssues[0]}`;
    } else if (merged.unknown.length > 0) {
      status = 'excluded';
      reason = `required_context_unknown: ${merged.unknown.join(', ')}`;
    } else if (contextSchemaIssues.length > 0) {
      status = 'excluded';
      reason = `context_schema_violation: ${contextSchemaIssues.map((i) => `${i.path} ${i.rule}`).join(', ')}`;
    }
  }
  issues.push(...resultIssues.map((i) => `result: ${i}`));
  if (merged.unknown.length > 0)
    issues.push(`required context unknown: ${merged.unknown.join(', ')}`);

  // 7. Assemble the draft Run and the metadata.
  const label = targetUrl.origin;
  const artifacts = [
    artifactFor(paths.attempts, 'attempts', 'application/x-ndjson'),
    artifactFor(paths.stdout, 'stdout', 'text/plain'),
    artifactFor(paths.stderr, 'stderr', 'text/plain'),
    artifactFor(paths.result, 'harness_output', 'application/json'),
  ].filter((a): a is NonNullable<typeof a> => a !== undefined);
  const draft: RunDraft = {
    run_id: runId,
    attempt_id: ulid(),
    node_id: nodeId,
    protocol_ref: local.ref,
    protocol_digest: local.protocol_digest,
    harness_digest: local.harness_digest,
    ...(options.investigationId !== undefined ? { investigation_id: options.investigationId } : {}),
    started_at: startedAt,
    ended_at: endedAt,
    target: { kind: targetKind, label_digest: jcsDigest(label), label },
    execution_status: status,
    ...(reason !== undefined ? { exclusion_reason: reason } : {}),
    accounting: derived.accounting,
    context: merged.context,
    result: resultValue,
    result_schema_digest: local.result_schema_digest,
    artifacts,
    origin: 'measured',
    corroboration: 'unreplicated',
  };
  const meta: VaultMeta = {
    run_id: runId,
    created_at: startedAt,
    protocol_ref: local.ref,
    manifest_source: source,
    service_url: serviceUrl,
    target: { label, kind: targetKind, allowed_hosts: allowedHosts },
    sharing_policy: sharingPolicy,
    harness,
    context_overrides: merged.overrides,
    context_unknown: merged.unknown,
    egress_violations: egressViolations,
    issues,
  };
  writePrivateJson(paths.draft, draft);
  writePrivateJson(paths.meta, meta);
  if (!existsSync(paths.stdout)) writePrivateFile(paths.stdout, '');
  if (!existsSync(paths.stderr)) writePrivateFile(paths.stderr, '');
  tightenPermissions(paths.dir);

  // The draft must be a valid Run once signed; check now with a placeholder
  // submission so a malformed run is caught before anyone tries to preview it.
  const wireTarget = { kind: draft.target.kind, label_digest: draft.target.label_digest };
  const probe: Run = {
    ...draft,
    target: wireTarget,
    submission: {
      signed_at: endedAt,
      key_id: 'probe',
      signature: 'AA==',
      sharing_policy: sharingPolicy,
    },
  };
  const validation = validate('Run', probe);
  if (!validation.ok) {
    throw new RunnerError('run_invalid', `assembled run ${runId} is not a valid Run`, [
      ...validation.errors,
    ]);
  }

  return {
    run_id: runId,
    vault_dir: paths.dir,
    execution_status: status,
    exclusion_reason: reason,
    accounting: derived.accounting,
    harness,
    context_overrides: merged.overrides,
    context_unknown: merged.unknown,
    egress_violations: egressViolations,
    issues,
  };
}
