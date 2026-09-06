// Local execution policy (ADR-0006): `<home>/policy.json`. Read by the runner,
// never by the service. The default denies execution and allows no target,
// so a fresh install cannot run anything until the operator says so.
import { existsSync } from 'node:fs';
import { RunnerError } from './errors.js';
import { DEFAULT_POLICY_JSON, homePaths, readJsonFile, writePrivateJson } from './home.js';

export interface Policy {
  allow_execution: boolean;
  /** Hosts the runner may target: `host` or `host:port` (an http(s) origin is accepted and reduced to its host). */
  allowed_targets: string[];
  /** Recorded per plan; enforced once a pack declares a cost model (stage 5 `plan_test`). */
  budget_per_plan_usd: number;
  allow_disruptive: boolean;
}

export const DEFAULT_POLICY: Readonly<Policy> = Object.freeze({ ...DEFAULT_POLICY_JSON });

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Missing file = default policy. A present but malformed file is an error, never a permissive default. */
export function loadPolicy(home: string): Policy {
  const file = homePaths(home).policy;
  if (!existsSync(file)) return { ...DEFAULT_POLICY };
  let parsed: unknown;
  try {
    parsed = readJsonFile<unknown>(file);
  } catch {
    throw new RunnerError('policy_invalid', `${file} is not valid JSON`);
  }
  if (!isObject(parsed)) throw new RunnerError('policy_invalid', `${file} must be a JSON object`);
  const policy: Policy = { ...DEFAULT_POLICY, allowed_targets: [] };
  const allow = parsed['allow_execution'];
  if (allow !== undefined) {
    if (typeof allow !== 'boolean')
      throw new RunnerError('policy_invalid', 'allow_execution must be a boolean');
    policy.allow_execution = allow;
  }
  const targets = parsed['allowed_targets'];
  if (targets !== undefined) {
    if (!Array.isArray(targets) || !targets.every((t) => typeof t === 'string')) {
      throw new RunnerError('policy_invalid', 'allowed_targets must be an array of strings');
    }
    policy.allowed_targets = targets as string[];
  }
  const budget = parsed['budget_per_plan_usd'];
  if (budget !== undefined) {
    if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
      throw new RunnerError('policy_invalid', 'budget_per_plan_usd must be a non-negative number');
    }
    policy.budget_per_plan_usd = budget;
  }
  const disruptive = parsed['allow_disruptive'];
  if (disruptive !== undefined) {
    if (typeof disruptive !== 'boolean')
      throw new RunnerError('policy_invalid', 'allow_disruptive must be a boolean');
    policy.allow_disruptive = disruptive;
  }
  return policy;
}

export function savePolicy(home: string, policy: Policy): void {
  writePrivateJson(homePaths(home).policy, policy);
}

/** Parse the target URL; only http(s) targets are supported in v1. */
export function parseTarget(target: string): URL {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new RunnerError('target_invalid', 'target must be an http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RunnerError('target_invalid', 'target must be an http(s) URL');
  }
  return url;
}

/** `hostname` or `hostname:port` (port only when explicit in the URL), lowercase. */
export function targetHost(url: URL): string {
  return url.host.toLowerCase();
}

/** Reduce a policy entry to a comparable host: origins become their host. */
export function normalizeTargetEntry(entry: string): string {
  const text = entry.trim().toLowerCase();
  if (text.includes('://')) {
    try {
      return new URL(text).host;
    } catch {
      return text;
    }
  }
  return text;
}

export function targetAllowed(policy: Policy, url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  const host = targetHost(url);
  return policy.allowed_targets.some((entry) => {
    const e = normalizeTargetEntry(entry);
    return e === hostname || e === host;
  });
}

/** Throw `policy_denied` or `target_not_allowed`; returns the parsed target otherwise. */
export function checkExecution(policy: Policy, target: string): URL {
  const url = parseTarget(target);
  if (!policy.allow_execution) {
    throw new RunnerError(
      'policy_denied',
      'policy denies execution (allow_execution is false in policy.json)',
    );
  }
  if (!targetAllowed(policy, url)) {
    throw new RunnerError(
      'target_not_allowed',
      `policy denies target host ${targetHost(url)} (not in allowed_targets)`,
    );
  }
  return url;
}
