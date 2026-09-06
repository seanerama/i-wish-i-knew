// `iwik report <run_id | --protocol ref>`: a local-only report from the
// vault. It reads run.draft.json / vault.json / receipt.json for one run or
// every run of a protocol, derives what the pack's claims.json permits
// (distributions per claim, spread across runs, never a pooled number), the
// accounting, and the missing context, and carries a fixed header saying it
// is local evidence only. It never contacts the service and is never sent.
// The JSON form validates against schema/local-report.schema.json before it
// is returned, so the CLI cannot print a malformed report.
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import addFormatsModule from 'ajv-formats';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RunAccounting, RunTarget } from '@iwik/contracts';
import { RunnerError } from './errors.js';
import { homePaths, loadConfig, resolveHome } from './home.js';
import { defaultPacksDir, loadLocalPack, runnerRoot } from './pack.js';
import { listRuns, readDraft, readMeta, readReceipt } from './vault.js';
import type { RunDraft, VaultMeta } from './vault.js';

export const REPORT_HEADER = 'Local evidence only — not corroborated by the cooperative';
export const REPORT_SCHEMA_PATH = resolve(runnerRoot, 'schema', 'local-report.schema.json');

export interface ReportOptions {
  home?: string;
  /** One run; or */
  runId?: string;
  /** every run of this protocol in the vault. */
  protocol?: string;
  packsDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ReportRun {
  run_id: string;
  plan_id?: string;
  started_at: string;
  ended_at: string;
  target_kind: RunTarget['kind'];
  execution_status: string;
  exclusion_reason?: string;
  exclusion_detail?: string;
  accounting: RunAccounting;
  sharing_policy: string;
  submitted: boolean;
  receipt_id?: string;
  context_unknown: string[];
  issues?: string[];
}

export interface ReportMetric {
  name: string;
  kind: 'distribution' | 'rate' | 'breakdown';
  unit?: string;
  per_run: Array<{ run_id: string; value: unknown }>;
  across_runs: Record<string, unknown>;
}

export interface ReportClaim {
  name: string;
  question: string;
  minimum_per_run?: string;
  eligible_runs: string[];
  below_minimum_runs: string[];
  metrics: ReportMetric[];
}

export interface LocalReport {
  header: typeof REPORT_HEADER;
  scope: 'local';
  corroboration: 'unreplicated';
  generated_at: string;
  protocol_ref: string;
  runs: ReportRun[];
  accounting: {
    runs: {
      total: number;
      succeeded: number;
      failed: number;
      excluded: number;
      unobserved: number;
    };
    attempts: RunAccounting;
  };
  claims: ReportClaim[];
  missing_context: Array<{ key: string; runs: string[] }>;
  limitations: string[];
}

interface MetricSpec {
  name: string;
  path: string;
  kind: ReportMetric['kind'];
  unit?: string;
}

interface ClaimSpec {
  name: string;
  question: string;
  minimum_succeeded?: number;
  minimum_attempted?: number;
  metrics: MetricSpec[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read the claim specs out of claims.json; claims without `derivation.metrics` report nothing. */
export function parseClaims(claims: Record<string, unknown>): ClaimSpec[] {
  const out: ClaimSpec[] = [];
  const list = Array.isArray(claims['claims']) ? (claims['claims'] as unknown[]) : [];
  for (const raw of list) {
    if (!isObject(raw) || typeof raw['name'] !== 'string') continue;
    const derivation = isObject(raw['derivation']) ? raw['derivation'] : {};
    const metrics: MetricSpec[] = [];
    for (const m of Array.isArray(derivation['metrics'])
      ? (derivation['metrics'] as unknown[])
      : []) {
      if (!isObject(m) || typeof m['name'] !== 'string' || typeof m['path'] !== 'string') continue;
      const kind = m['kind'];
      if (kind !== 'distribution' && kind !== 'rate' && kind !== 'breakdown') continue;
      const spec: MetricSpec = { name: m['name'], path: m['path'], kind };
      if (typeof m['unit'] === 'string') spec.unit = m['unit'];
      metrics.push(spec);
    }
    const spec: ClaimSpec = {
      name: raw['name'],
      question: typeof raw['question'] === 'string' ? raw['question'] : '',
      metrics,
    };
    const minSucceeded = derivation['minimum_succeeded_attempts_per_run'];
    if (typeof minSucceeded === 'number') spec.minimum_succeeded = minSucceeded;
    const minAttempted = derivation['minimum_attempts_per_run'];
    if (typeof minAttempted === 'number') spec.minimum_attempted = minAttempted;
    out.push(spec);
  }
  return out;
}

/** JSON-pointer lookup (RFC 6901) into a result object; undefined when absent. */
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

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function spread(values: number[]): {
  runs: number;
  min: number | null;
  median: number | null;
  max: number | null;
} {
  return {
    runs: values.length,
    min: values.length ? Math.min(...values) : null,
    median: median(values),
    max: values.length ? Math.max(...values) : null,
  };
}

const DISTRIBUTION_KEYS = ['samples', 'min', 'p50', 'p90', 'p95', 'p99', 'max'];

/** Spread of per-run values across eligible runs; never a pooled number. */
export function acrossRuns(kind: ReportMetric['kind'], values: unknown[]): Record<string, unknown> {
  if (kind === 'distribution') {
    const out: Record<string, unknown> = { runs: values.length };
    for (const key of DISTRIBUTION_KEYS) {
      const numbers = values
        .map((v) => (isObject(v) ? v[key] : undefined))
        .filter((n): n is number => typeof n === 'number');
      out[key] = spread(numbers);
    }
    return out;
  }
  if (kind === 'rate') {
    return spread(values.filter((v): v is number => typeof v === 'number'));
  }
  const totals: Record<string, number> = {};
  for (const v of values) {
    if (!isObject(v)) continue;
    for (const [k, n] of Object.entries(v)) {
      if (typeof n === 'number') totals[k] = (totals[k] ?? 0) + n;
    }
  }
  return { runs: values.length, totals };
}

let validator: ValidateFunction | undefined;

/** Validate a report against schema/local-report.schema.json; issues are `{ path, rule }` only. */
export function validateReport(report: unknown): Array<{ path: string; rule: string }> {
  if (validator === undefined) {
    const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
    addFormatsModule.default(ajv);
    validator = ajv.compile(JSON.parse(readFileSync(REPORT_SCHEMA_PATH, 'utf8')));
  }
  if (validator(report)) return [];
  return (validator.errors ?? []).map((e) => ({ path: e.instancePath, rule: e.keyword }));
}

function reportRun(
  draft: RunDraft,
  meta: VaultMeta,
  receipt: Record<string, unknown> | undefined,
): ReportRun {
  const run: ReportRun = {
    run_id: draft.run_id,
    ...(meta.plan_id !== undefined ? { plan_id: meta.plan_id } : {}),
    started_at: draft.started_at,
    ended_at: draft.ended_at,
    target_kind: draft.target.kind,
    execution_status: draft.execution_status,
    ...(draft.exclusion_reason !== undefined ? { exclusion_reason: draft.exclusion_reason } : {}),
    ...(meta.exclusion_detail !== undefined ? { exclusion_detail: meta.exclusion_detail } : {}),
    accounting: draft.accounting,
    sharing_policy: meta.sharing_policy,
    submitted: receipt !== undefined,
    ...(receipt !== undefined && typeof receipt['receipt_id'] === 'string'
      ? { receipt_id: receipt['receipt_id'] }
      : {}),
    context_unknown: meta.context_unknown,
  };
  if (meta.issues.length > 0) run.issues = meta.issues;
  return run;
}

export function report(options: ReportOptions): LocalReport {
  const env = options.env ?? process.env;
  const home = resolveHome(options.home, env);
  if ((options.runId === undefined) === (options.protocol === undefined)) {
    throw new RunnerError('usage', 'give exactly one of a run id or --protocol <ref>');
  }
  const ids = options.runId !== undefined ? [options.runId] : listRuns(home);
  const entries: Array<{
    draft: RunDraft;
    meta: VaultMeta;
    receipt: Record<string, unknown> | undefined;
  }> = [];
  for (const id of ids) {
    let draft: RunDraft;
    let meta: VaultMeta;
    try {
      draft = readDraft(home, id);
      meta = readMeta(home, id);
    } catch (err) {
      if (options.runId !== undefined) throw err;
      continue; // a vault entry without metadata is not reportable
    }
    if (options.protocol !== undefined && draft.protocol_ref !== options.protocol) continue;
    entries.push({ draft, meta, receipt: readReceipt(home, id) });
  }
  if (entries.length === 0) {
    throw new RunnerError(
      'report_empty',
      `no runs of ${options.protocol ?? options.runId} in the vault (${homePaths(home).vault})`,
    );
  }
  const protocolRef =
    options.protocol ?? (entries[0] as (typeof entries)[number]).draft.protocol_ref;

  const config = existsSync(homePaths(home).config) ? loadConfig(home) : undefined;
  const packsDir =
    options.packsDir ?? env['IWIK_PACKS_DIR'] ?? config?.packs_dir ?? defaultPacksDir;
  const limitations: string[] = [
    'Every run comes from this node alone; nothing here is replicated or corroborated by another organization.',
    'Attempts inside a run are samples within one run, never independent observations (ADR-0003).',
  ];
  let claimSpecs: ClaimSpec[] = [];
  let permitted: string[] = [];
  try {
    const local = loadLocalPack(packsDir, protocolRef);
    claimSpecs = parseClaims(local.claims);
    permitted = [...local.protocol.permitted_claims];
  } catch (err) {
    limitations.push(
      `pack for ${protocolRef} not available locally (${err instanceof RunnerError ? err.code : 'error'}); claims not derived`,
    );
  }

  const runs = entries.map((e) => reportRun(e.draft, e.meta, e.receipt));
  const count = (status: string): number =>
    runs.filter((r) => r.execution_status === status).length;
  const attempts: RunAccounting = {
    planned: 0,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    excluded: 0,
    unobserved: 0,
  };
  for (const r of runs) {
    for (const key of Object.keys(attempts) as Array<keyof RunAccounting>)
      attempts[key] += r.accounting[key];
  }

  const claims: ReportClaim[] = [];
  for (const spec of claimSpecs) {
    if (!permitted.includes(spec.name)) continue;
    const succeeded = entries.filter((e) => e.draft.execution_status === 'succeeded');
    const eligible: typeof entries = [];
    const below: string[] = [];
    for (const e of succeeded) {
      const a = e.draft.accounting;
      const meets =
        (spec.minimum_succeeded === undefined || a.succeeded >= spec.minimum_succeeded) &&
        (spec.minimum_attempted === undefined || a.attempted >= spec.minimum_attempted);
      if (meets) eligible.push(e);
      else below.push(e.draft.run_id);
    }
    const metrics: ReportMetric[] = spec.metrics.map((m) => {
      const perRun = eligible.map((e) => ({
        run_id: e.draft.run_id,
        value: pointer(e.draft.result, m.path) ?? null,
      }));
      const metric: ReportMetric = {
        name: m.name,
        kind: m.kind,
        per_run: perRun,
        across_runs: acrossRuns(
          m.kind,
          perRun.map((p) => p.value),
        ),
      };
      if (m.unit !== undefined) metric.unit = m.unit;
      return metric;
    });
    const minimum =
      spec.minimum_succeeded !== undefined
        ? `${spec.minimum_succeeded} succeeded attempts`
        : spec.minimum_attempted !== undefined
          ? `${spec.minimum_attempted} attempts`
          : undefined;
    claims.push({
      name: spec.name,
      question: spec.question,
      ...(minimum !== undefined ? { minimum_per_run: minimum } : {}),
      eligible_runs: eligible.map((e) => e.draft.run_id),
      below_minimum_runs: below,
      metrics,
    });
  }

  const missing = new Map<string, string[]>();
  for (const r of runs) {
    for (const key of r.context_unknown) {
      const list = missing.get(key) ?? [];
      list.push(r.run_id);
      missing.set(key, list);
    }
  }
  if (runs.some((r) => r.target_kind === 'fixture')) {
    limitations.push(
      'Runs against a fixture target emulate an endpoint; they are never releasable to a cooperative cohort.',
    );
  }
  if (runs.some((r) => r.execution_status !== 'succeeded')) {
    limitations.push(
      'Excluded, failed, and unobserved runs contribute to accounting only, never to a claim.',
    );
  }

  const out: LocalReport = {
    header: REPORT_HEADER,
    scope: 'local',
    corroboration: 'unreplicated',
    generated_at: new Date().toISOString(),
    protocol_ref: protocolRef,
    runs,
    accounting: {
      runs: {
        total: runs.length,
        succeeded: count('succeeded'),
        failed: count('failed'),
        excluded: count('excluded'),
        unobserved: count('unobserved'),
      },
      attempts,
    },
    claims,
    missing_context: [...missing.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, ids]) => ({ key, runs: ids })),
    limitations,
  };
  const issues = validateReport(out);
  if (issues.length > 0) {
    throw new RunnerError(
      'run_invalid',
      'assembled report does not match the report schema',
      issues,
    );
  }
  return out;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  return String(value);
}

/** Markdown rendering of a report; the first line is the local-only header. */
export function renderMarkdown(r: LocalReport): string {
  const lines: string[] = [];
  lines.push(`# ${r.header}`);
  lines.push('');
  lines.push(
    `Protocol: \`${r.protocol_ref}\` · generated ${r.generated_at} · scope: ${r.scope} · corroboration: ${r.corroboration}`,
  );
  lines.push('');
  lines.push('## Runs');
  lines.push('');
  lines.push(
    '| run | status | planned | attempted | succeeded | failed | excluded | unobserved | target | submitted |',
  );
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const run of r.runs) {
    const a = run.accounting;
    const status =
      run.exclusion_reason !== undefined
        ? `${run.execution_status} (${run.exclusion_reason})`
        : run.execution_status;
    lines.push(
      `| ${run.run_id} | ${status} | ${a.planned} | ${a.attempted} | ${a.succeeded} | ${a.failed} | ${a.excluded} | ${a.unobserved} | ${run.target_kind} | ${run.submitted ? (run.receipt_id ?? 'yes') : 'no'} |`,
    );
  }
  lines.push('');
  const ra = r.accounting.runs;
  const aa = r.accounting.attempts;
  lines.push(
    `Runs: ${ra.total} total, ${ra.succeeded} succeeded, ${ra.failed} failed, ${ra.excluded} excluded, ${ra.unobserved} unobserved.`,
  );
  lines.push(
    `Attempts: ${aa.planned} planned, ${aa.attempted} attempted, ${aa.succeeded} succeeded, ${aa.failed} failed, ${aa.excluded} excluded, ${aa.unobserved} unobserved.`,
  );
  for (const run of r.runs) {
    if (run.exclusion_detail !== undefined)
      lines.push(`- ${run.run_id}: ${run.exclusion_detail} (vault-only detail)`);
  }
  lines.push('');
  lines.push('## Claims (permitted by the protocol)');
  lines.push('');
  if (r.claims.length === 0) lines.push('_No claims derived._');
  for (const claim of r.claims) {
    lines.push(`### ${claim.name}`);
    lines.push('');
    lines.push(claim.question);
    lines.push('');
    lines.push(
      `Eligible runs: ${claim.eligible_runs.length}` +
        (claim.minimum_per_run !== undefined
          ? ` (minimum per run: ${claim.minimum_per_run})`
          : '') +
        (claim.below_minimum_runs.length > 0
          ? `; below minimum: ${claim.below_minimum_runs.join(', ')}`
          : ''),
    );
    lines.push('');
    for (const metric of claim.metrics) {
      const unit = metric.unit !== undefined ? ` (${metric.unit})` : '';
      lines.push(`**${metric.name}**${unit}, ${metric.kind}`);
      lines.push('');
      if (metric.kind === 'distribution') {
        lines.push('| run | samples | min | p50 | p90 | p95 | p99 | max |');
        lines.push('|---|---|---|---|---|---|---|---|');
        for (const p of metric.per_run) {
          const v = isObject(p.value) ? p.value : {};
          lines.push(
            `| ${p.run_id} | ${fmt(v['samples'])} | ${fmt(v['min'])} | ${fmt(v['p50'])} | ${fmt(v['p90'])} | ${fmt(v['p95'])} | ${fmt(v['p99'])} | ${fmt(v['max'])} |`,
          );
        }
        const across = metric.across_runs;
        const cells = DISTRIBUTION_KEYS.slice(1).map((k) => {
          const s = isObject(across[k]) ? (across[k] as Record<string, unknown>) : {};
          return `${fmt(s['min'])}..${fmt(s['max'])}`;
        });
        lines.push(
          `| **across ${fmt(across['runs'])} runs (min..max)** | | ${cells.join(' | ')} |`,
        );
      } else if (metric.kind === 'rate') {
        for (const p of metric.per_run) lines.push(`- ${p.run_id}: ${fmt(p.value)}`);
        const s = metric.across_runs;
        lines.push(
          `- across ${fmt(s['runs'])} runs: min ${fmt(s['min'])}, median ${fmt(s['median'])}, max ${fmt(s['max'])}`,
        );
      } else {
        const totals = isObject(metric.across_runs['totals'])
          ? (metric.across_runs['totals'] as Record<string, unknown>)
          : {};
        const parts = Object.entries(totals).map(([k, v]) => `${k}: ${fmt(v)}`);
        lines.push(
          `- totals across ${fmt(metric.across_runs['runs'])} runs: ${parts.length > 0 ? parts.join(', ') : 'none'}`,
        );
      }
      lines.push('');
    }
  }
  lines.push('## Missing context');
  lines.push('');
  if (r.missing_context.length === 0)
    lines.push('_Every required context key was known in every run._');
  for (const m of r.missing_context)
    lines.push(`- \`${m.key}\` unknown in ${m.runs.length} run(s): ${m.runs.join(', ')}`);
  lines.push('');
  lines.push('## Limitations');
  lines.push('');
  for (const l of r.limitations) lines.push(`- ${l}`);
  lines.push('');
  return lines.join('\n');
}
