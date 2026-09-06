// `iwik challenge`, `iwik predict`, `iwik outcome` and the tools behind them
// (contracts/member-api.md `POST /v1/challenges`, `POST /v1/outcomes`;
// contracts/agent-tools.md `challenge_finding`, `register_prediction`,
// `report_outcome`). Everything that crosses the wire is an id, a value from
// a fixed vocabulary, a date, a number, or the one bounded challenge note.
// Responses are validated against the envelope schemas before they are
// returned, so a service that answered with something else is refused.
import type {
  Challenge,
  ChallengeGrounds,
  ChallengeStatement,
  ChallengeTarget,
  EvaluationRule,
  Outcome,
  OutcomeResult,
  Prediction,
  PredictionTarget,
} from '@iwik/contracts';
import { CHALLENGE_NOTE_MAX_LENGTH, validate } from '@iwik/contracts';
import { ApiClient } from './client.js';
import { RunnerError } from './errors.js';
import type { ErrorDetail } from './errors.js';
import { loadConfig, loadToken, resolveHome } from './home.js';
import type { ClientOptions } from './submit.js';
import { ULID_PATTERN } from './ulid.js';

export const CHALLENGE_GROUNDS = [
  'method',
  'context_mismatch',
  'data_error',
  'replication_failed',
  'affiliation',
] as const;
export const CHALLENGE_DIRECTIONS = ['higher', 'lower', 'different'] as const;
export const EVALUATION_RULES = [
  'own_measurement',
  'cooperative_requery',
  'operational_observation',
] as const;
export const OUTCOME_RESULTS = ['met', 'not_met', 'indeterminate'] as const;
export { CHALLENGE_NOTE_MAX_LENGTH };

const VOCAB_RE = /^[a-z][a-z0-9_]*$/;
const CONTEXT_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const ISO_DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

export function isChallengeGrounds(value: unknown): value is ChallengeGrounds {
  return oneOf(CHALLENGE_GROUNDS, value);
}

export function isEvaluationRule(value: unknown): value is EvaluationRule {
  return oneOf(EVALUATION_RULES, value);
}

export function isOutcomeResult(value: unknown): value is OutcomeResult {
  return oneOf(OUTCOME_RESULTS, value);
}

function usage(message: string, details: ErrorDetail[]): RunnerError {
  return new RunnerError('usage', message, details);
}

function clientOf(options: ClientOptions): ApiClient {
  const home = resolveHome(options.home, options.env);
  const config = loadConfig(home);
  return new ApiClient(config.service_url, loadToken(home), options.fetch);
}

// ---------------------------------------------------------------- challenges

/** `claim:<ulid>` names a claim; a bare ULID names a receipt. */
export function parseChallengeTarget(text: string): ChallengeTarget {
  const claim = /^claim:([0-9A-HJKMNP-TV-Z]{26})$/.exec(text.trim());
  if (claim !== null) return { kind: 'claim', id: claim[1] as string };
  const receipt = /^(?:receipt:)?([0-9A-HJKMNP-TV-Z]{26})$/.exec(text.trim());
  if (receipt !== null) return { kind: 'receipt', id: receipt[1] as string };
  throw usage('challenge target must be a receipt id or claim:<claim id>', [
    { path: '/target', rule: 'pattern' },
  ]);
}

/** Validate a statement locally: fixed vocabulary, one bounded note. */
export function checkStatement(statement: ChallengeStatement): ErrorDetail[] {
  const issues: ErrorDetail[] = [];
  for (const key of ['claim', 'metric', 'statistic'] as const) {
    const value = statement[key];
    if (value !== undefined && (!VOCAB_RE.test(value) || value.length > 64)) {
      issues.push({ path: `/statement/${key}`, rule: 'pattern' });
    }
  }
  if (statement.context_key !== undefined && !CONTEXT_KEY_RE.test(statement.context_key)) {
    issues.push({ path: '/statement/context_key', rule: 'pattern' });
  }
  if (statement.direction !== undefined && !oneOf(CHALLENGE_DIRECTIONS, statement.direction)) {
    issues.push({ path: '/statement/direction', rule: 'enum' });
  }
  if (
    statement.replication_run_id !== undefined &&
    !ULID_PATTERN.test(statement.replication_run_id)
  ) {
    issues.push({ path: '/statement/replication_run_id', rule: 'pattern' });
  }
  if (statement.note !== undefined && statement.note.length > CHALLENGE_NOTE_MAX_LENGTH) {
    issues.push({ path: '/statement/note', rule: 'maxLength' });
  }
  return issues;
}

export interface ChallengeOptions extends ClientOptions {
  grounds: ChallengeGrounds;
  statement?: ChallengeStatement;
}

export async function challenge(
  target: ChallengeTarget,
  options: ChallengeOptions,
): Promise<Challenge> {
  const issues: ErrorDetail[] = [];
  if (!ULID_PATTERN.test(target.id)) issues.push({ path: '/target/id', rule: 'pattern' });
  if (!isChallengeGrounds(options.grounds)) issues.push({ path: '/grounds', rule: 'enum' });
  const statement = options.statement ?? {};
  issues.push(...checkStatement(statement));
  if (issues.length > 0) {
    throw usage(
      `challenge needs a target id, grounds from: ${CHALLENGE_GROUNDS.join(', ')}, and a note of at most ${CHALLENGE_NOTE_MAX_LENGTH} characters`,
      issues,
    );
  }
  const res = await clientOf(options).post<unknown>('/v1/challenges', {
    target,
    grounds: options.grounds,
    statement,
  });
  const check = validate('Challenge', res.body);
  if (!check.ok) throw new RunnerError('api_error', 'challenge response is not a valid Challenge');
  return res.body as Challenge;
}

// --------------------------------------------------------------- predictions

/** `<claim>[.<metric>[.<statistic>]]` plus an optional threshold. */
export function parsePredictionTarget(
  spec: string,
  threshold: { below?: number; above?: number; within?: number; unit?: string } = {},
): PredictionTarget {
  const parts = spec.trim().split('.');
  const issues: ErrorDetail[] = [];
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => !VOCAB_RE.test(p))) {
    issues.push({ path: '/target', rule: 'pattern' });
  }
  const chosen = (['below', 'above', 'within'] as const).filter((k) => threshold[k] !== undefined);
  if (chosen.length > 1) issues.push({ path: '/target/comparator', rule: 'oneOf' });
  for (const k of chosen) {
    const v = threshold[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      issues.push({ path: '/target/value', rule: 'type' });
    }
  }
  if (threshold.unit !== undefined && !/^[a-z%/0-9_]{1,16}$/.test(threshold.unit)) {
    issues.push({ path: '/target/unit', rule: 'pattern' });
  }
  if (issues.length > 0) {
    throw usage(
      'prediction target is <claim>[.<metric>[.<statistic>]] with at most one of --below, --above, --within',
      issues,
    );
  }
  const [claim, metric, statistic] = parts as [string, string?, string?];
  const comparator = chosen[0];
  return {
    claim,
    ...(metric !== undefined ? { metric } : {}),
    ...(statistic !== undefined ? { statistic } : {}),
    ...(comparator !== undefined ? { comparator, value: threshold[comparator] as number } : {}),
    ...(threshold.unit !== undefined ? { unit: threshold.unit } : {}),
  };
}

export interface PredictOptions extends ClientOptions {
  receiptId: string;
  target: PredictionTarget;
  /** `YYYY-MM-DD`. */
  horizon: string;
  probability?: number;
  evaluationRule: EvaluationRule;
}

export async function predict(options: PredictOptions): Promise<Prediction> {
  const issues: ErrorDetail[] = [];
  if (!ULID_PATTERN.test(options.receiptId)) {
    issues.push({ path: '/prediction/based_on_receipt_id', rule: 'pattern' });
  }
  if (!ISO_DATE_RE.test(options.horizon) || Number.isNaN(Date.parse(options.horizon))) {
    issues.push({ path: '/prediction/horizon', rule: 'pattern' });
  }
  if (
    options.probability !== undefined &&
    (!Number.isFinite(options.probability) || options.probability < 0 || options.probability > 1)
  ) {
    issues.push({ path: '/prediction/probability', rule: 'range' });
  }
  if (!isEvaluationRule(options.evaluationRule)) {
    issues.push({ path: '/prediction/evaluation_rule', rule: 'enum' });
  }
  if (issues.length > 0) {
    throw usage(
      `predict needs a receipt id, a horizon date (YYYY-MM-DD), an optional probability in [0, 1], and a rule from: ${EVALUATION_RULES.join(', ')}`,
      issues,
    );
  }
  const res = await clientOf(options).post<unknown>('/v1/outcomes', {
    prediction: {
      based_on_receipt_id: options.receiptId,
      target: options.target,
      horizon: options.horizon,
      ...(options.probability !== undefined ? { probability: options.probability } : {}),
      evaluation_rule: options.evaluationRule,
    },
  });
  const check = validate('Prediction', res.body);
  if (!check.ok)
    throw new RunnerError('api_error', 'prediction response is not a valid Prediction');
  return res.body as Prediction;
}

// ------------------------------------------------------------------ outcomes

export interface OutcomeOptions extends ClientOptions {
  result: OutcomeResult;
  environmentChanged: boolean;
  /** Defaults to now. */
  observedAt?: string;
  /** The receipt the prediction was based on, restated for a mismatch check. */
  receiptId?: string;
  evaluationRunId?: string;
}

export async function outcome(predictionId: string, options: OutcomeOptions): Promise<Outcome> {
  const issues: ErrorDetail[] = [];
  if (!ULID_PATTERN.test(predictionId)) issues.push({ path: '/prediction_id', rule: 'pattern' });
  if (!isOutcomeResult(options.result)) issues.push({ path: '/observed/result', rule: 'enum' });
  const observedAt = options.observedAt ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(observedAt))) {
    issues.push({ path: '/observed/observed_at', rule: 'format' });
  }
  if (options.receiptId !== undefined && !ULID_PATTERN.test(options.receiptId)) {
    issues.push({ path: '/based_on_receipt_id', rule: 'pattern' });
  }
  if (options.evaluationRunId !== undefined && !ULID_PATTERN.test(options.evaluationRunId)) {
    issues.push({ path: '/observed/evaluation_run_id', rule: 'pattern' });
  }
  if (issues.length > 0) {
    throw usage(
      `outcome needs a prediction id and a result from: ${OUTCOME_RESULTS.join(', ')}`,
      issues,
    );
  }
  const res = await clientOf(options).post<unknown>('/v1/outcomes', {
    prediction_id: predictionId,
    observed: {
      observed_at: new Date(Date.parse(observedAt)).toISOString(),
      result: options.result,
      environment_changed: options.environmentChanged,
      ...(options.evaluationRunId !== undefined
        ? { evaluation_run_id: options.evaluationRunId }
        : {}),
    },
    ...(options.receiptId !== undefined ? { based_on_receipt_id: options.receiptId } : {}),
  });
  const check = validate('Outcome', res.body);
  if (!check.ok) throw new RunnerError('api_error', 'outcome response is not a valid Outcome');
  return res.body as Outcome;
}
