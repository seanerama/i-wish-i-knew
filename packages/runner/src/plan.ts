// `iwik plan` / `plan_test`: choose protocol, target, and context; write
// `<home>/plans/<plan_id>.json` with the required context (unknowns listed),
// the estimated cost from the pack's cost model, and what uncertainty the
// test resolves. A plan never executes anything and never contacts the
// service: `iwik run --plan <id>` executes it under policy.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ContextValue, PlanSummary, RunTarget, SharingPolicy } from '@iwik/contracts';
import { validateTool } from '@iwik/contracts';
import { parseContextArgs } from './context.js';
import { estimateCost, parseCostModel } from './cost.js';
import { RunnerError } from './errors.js';
import {
  ensurePrivateDir,
  homePaths,
  loadConfig,
  readJsonFile,
  resolveHome,
  writePrivateJson,
} from './home.js';
import { defaultPacksDir, loadLocalPack } from './pack.js';
import { loadPolicy, parseTarget, targetAllowed, targetHost } from './policy.js';
import type { Policy } from './policy.js';
import { ulid, ULID_PATTERN } from './ulid.js';

export interface PlanOptions {
  home?: string;
  protocol: string;
  target: string;
  targetKind?: RunTarget['kind'];
  question: string;
  context?: readonly string[] | Record<string, ContextValue>;
  planned?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Operator-supplied prices for the pack's cost model (`--price k=v`). */
  prices?: Record<string, number>;
  /** Name of the environment variable holding the target API key (never the key). */
  apiKeyEnv?: string;
  investigationId?: string;
  sharingPolicy?: SharingPolicy;
  packsDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** What `plans/<plan_id>.json` holds: the summary plus what `iwik run --plan` needs. */
export interface PlanRecord extends PlanSummary {
  prices?: Record<string, number>;
  packs_dir?: string;
  /** Runs executed from this plan, newest last. */
  runs: Array<{ run_id: string; started_at: string; execution_status: string }>;
}

function positiveInt(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new RunnerError('usage', `${name} must be a positive integer`);
  }
  return value;
}

/** `iwik run --plan <id>` for the operator, with the policy prerequisites spelled out. */
export function runPlanCommand(planId: string, host: string, policy: Policy, url: URL): string {
  const steps: string[] = [];
  if (!policy.allow_execution) steps.push('iwik policy set allow_execution true');
  if (!targetAllowed(policy, url)) steps.push(`iwik policy allow-target ${host}`);
  const command = `iwik run --plan ${planId}`;
  if (steps.length === 0) return command;
  return `${command} (the operator runs this on the node after: ${steps.join('; ')})`;
}

/** Evaluate the local policy for a plan: allowed now, or what is missing. */
export function planExecution(
  planId: string,
  targetUrl: URL,
  policy: Policy,
  withinBudget: boolean | null,
): PlanSummary['execution'] {
  const reasons: string[] = [];
  const host = targetHost(targetUrl);
  if (!policy.allow_execution) reasons.push('policy.json has allow_execution false');
  if (!targetAllowed(policy, targetUrl))
    reasons.push(`target host ${host} is not in allowed_targets`);
  if (withinBudget === null) {
    reasons.push('no cost estimate for this target (the runner refuses to execute without one)');
  } else if (!withinBudget) {
    reasons.push('estimated cost exceeds budget_per_plan_usd');
  }
  let next = runPlanCommand(planId, host, policy, targetUrl);
  if (withinBudget === null) {
    next += '; supply the prices the pack cost model needs (iwik plan --price <name>=<usd>)';
  } else if (!withinBudget) {
    next += '; raise the budget first: iwik policy set budget_per_plan_usd <usd>';
  }
  return { allowed: reasons.length === 0, reasons, next_step: next };
}

export function planPath(home: string, planId: string): string {
  if (!ULID_PATTERN.test(planId)) throw new RunnerError('usage', 'plan id must be a ULID');
  return join(homePaths(home).plans, `${planId}.json`);
}

export function plan(options: PlanOptions): PlanRecord {
  const env = options.env ?? process.env;
  const home = resolveHome(options.home, env);
  if (options.question.trim() === '') throw new RunnerError('usage', 'question must not be empty');
  const planned = positiveInt(options.planned, 10, 'planned');
  const maxTokens = positiveInt(options.maxTokens, 64, 'max-tokens');
  const timeoutMs = positiveInt(options.timeoutMs, 30000, 'timeout');
  const targetKind = options.targetKind ?? 'service';
  const sharingPolicy = options.sharingPolicy ?? 'private';
  if (options.investigationId !== undefined && !ULID_PATTERN.test(options.investigationId)) {
    throw new RunnerError('usage', 'investigation id must be a ULID');
  }
  const targetUrl = parseTarget(options.target);
  const context = Array.isArray(options.context)
    ? parseContextArgs(options.context)
    : ((options.context as Record<string, ContextValue> | undefined) ?? {});

  const config = existsSync(homePaths(home).config) ? loadConfig(home) : undefined;
  const packsDir =
    options.packsDir ?? env['IWIK_PACKS_DIR'] ?? config?.packs_dir ?? defaultPacksDir;
  const local = loadLocalPack(packsDir, options.protocol);
  const policy = loadPolicy(home);

  const required = local.protocol.required_context;
  const known = required.filter((key) => context[key] !== undefined && context[key] !== null);
  const unknown = required.filter((key) => !known.includes(key));

  const estimate = estimateCost(parseCostModel(local.claims), {
    targetKind,
    planned,
    maxTokens,
    prices: options.prices,
  });
  const withinBudget =
    estimate.amount === null ? null : estimate.amount <= policy.budget_per_plan_usd;

  const planId = ulid();
  const claims = local.protocol.permitted_claims;
  const record: PlanRecord = {
    plan_id: planId,
    created_at: new Date().toISOString(),
    protocol_ref: local.ref,
    protocol_digest: local.protocol_digest,
    target: { url: targetUrl.toString(), kind: targetKind },
    question: options.question,
    context,
    required_context: { known, unknown },
    planned,
    max_tokens: maxTokens,
    timeout_ms: timeoutMs,
    sharing_policy: sharingPolicy,
    ...(options.investigationId !== undefined ? { investigation_id: options.investigationId } : {}),
    estimated_cost: {
      currency: 'usd',
      amount: estimate.amount,
      basis: estimate.basis,
      budget_per_plan_usd: policy.budget_per_plan_usd,
      within_budget: withinBudget,
    },
    resolves: {
      claims: [...claims],
      statement:
        `One local ${local.protocol.kind} measurement of ${claims.join(' and ')} for ${local.ref} ` +
        `against a ${targetKind} target (${planned} planned attempts). It resolves what this node ` +
        `observes under the supplied context; it does not resolve cooperative corroboration ` +
        `(local evidence only, unreplicated)` +
        (unknown.length > 0
          ? `. Required context still unknown: ${unknown.join(', ')}; unless the harness measures ` +
            `these, the run is excluded rather than defaulted`
          : '') +
        (targetKind === 'fixture' ? '. A fixture run is never releasable to a cohort' : '') +
        '.',
    },
    execution: planExecution(planId, targetUrl, policy, withinBudget),
    ...(options.prices !== undefined ? { prices: options.prices } : {}),
    ...(options.apiKeyEnv !== undefined ? { api_key_env: options.apiKeyEnv } : {}),
    ...(options.packsDir !== undefined ? { packs_dir: options.packsDir } : {}),
    runs: [],
  };
  const check = validateTool('plan_test', 'output', { ok: true, data: planSummary(record) });
  if (!check.ok) {
    throw new RunnerError(
      'plan_invalid',
      'assembled plan is not a valid plan summary',
      check.errors,
    );
  }
  ensurePrivateDir(homePaths(home).plans);
  writePrivateJson(planPath(home, planId), record);
  return record;
}

/** The agent-facing projection of a plan record (what `plan_test` returns). */
export function planSummary(record: PlanRecord): PlanSummary {
  const summary: Record<string, unknown> = { ...record };
  for (const key of ['prices', 'packs_dir', 'runs']) delete summary[key];
  return summary as unknown as PlanSummary;
}

export function loadPlan(home: string, planId: string): PlanRecord {
  const file = planPath(home, planId);
  if (!existsSync(file)) {
    throw new RunnerError('plan_not_found', `no plan ${planId} under ${homePaths(home).plans}`);
  }
  let parsed: unknown;
  try {
    parsed = readJsonFile<unknown>(file);
  } catch {
    throw new RunnerError('plan_invalid', `plan ${planId} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new RunnerError('plan_invalid', `plan ${planId} is not an object`);
  }
  const record = parsed as PlanRecord;
  const check = validateTool('plan_test', 'output', { ok: true, data: planSummary(record) });
  if (!check.ok || record.plan_id !== planId) {
    throw new RunnerError(
      'plan_invalid',
      `plan ${planId} does not match the plan shape`,
      check.errors,
    );
  }
  if (!Array.isArray(record.runs)) record.runs = [];
  return record;
}

export function savePlan(home: string, record: PlanRecord): void {
  writePrivateJson(planPath(home, record.plan_id), record);
}

/** Every plan id, newest first. */
export function listPlans(home: string): string[] {
  const dir = homePaths(home).plans;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && ULID_PATTERN.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5))
    .sort()
    .reverse();
}
