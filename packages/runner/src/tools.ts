// The agent tools (contracts/agent-tools.md: the ten frozen tools plus the
// stage 10 addition register_prediction), each a thin projection of one
// member-api call or one local runner action, wrapped in the common
// envelope `{ ok: true, data } | { ok: false, error: { code, message,
// next_step } }`. Inputs and outputs are validated against the generated
// schemas in contracts/schema/v1/tools/. Nothing here bypasses the disclosure
// policy or the local execution policy: `run_test` is denied unless
// policy.json allows it and answers with the exact `iwik run --plan` command.
import type {
  AnswerReceipt,
  ChallengeStatement,
  ToolErrorEnvelope,
  ToolInput,
  ToolName,
  ToolOutput,
} from '@iwik/contracts';
import { toolNames, validateTool } from '@iwik/contracts';
import { ApiClient } from './client.js';
import type { FetchLike } from './client.js';
import { nextStepFor } from './cooperative.js';
import { ApiError, RunnerError } from './errors.js';
import type { ErrorDetail } from './errors.js';
import { loadConfig, loadToken, resolveHome } from './home.js';
import {
  CHALLENGE_GROUNDS,
  CHALLENGE_NOTE_MAX_LENGTH,
  EVALUATION_RULES,
  OUTCOME_RESULTS,
  challenge,
  isChallengeGrounds,
  isOutcomeResult,
  outcome,
  predict,
} from './ledger.js';
import { loadPlan, plan, planSummary, runPlanCommand } from './plan.js';
import { loadPolicy, parseTarget, targetHost } from './policy.js';
import { runPlan } from './run.js';
import { preview, receipt, submit } from './submit.js';
import { ULID_PATTERN } from './ulid.js';
import { WITHDRAWAL_REASON_CODES, isWithdrawalReasonCode, withdraw } from './withdraw.js';

export interface ToolContext {
  home?: string;
  packsDir?: string;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export type Envelope<N extends ToolName = ToolName> = ToolOutput<N>;

/**
 * Tools whose service side has not landed. Empty since stage 10 wired
 * challenge_finding and report_outcome; kept so callers that consult it
 * keep working.
 */
export const NOT_YET_AVAILABLE: ReadonlySet<ToolName> = new Set<ToolName>();

const LEDGER_FLAG_STEP =
  'The challenge and outcome ledger is disabled on this deployment (IWIK_FEATURE_CHALLENGE=off); nothing was sent. Ask the operator to enable it, then call the tool again.';

function fail(code: string, message: string, nextStep?: string): ToolErrorEnvelope {
  return {
    ok: false,
    error: { code, message, ...(nextStep !== undefined ? { next_step: nextStep } : {}) },
  };
}

function ok<N extends ToolName>(data: Extract<ToolOutput<N>, { ok: true }>['data']): ToolOutput<N> {
  return { ok: true, data } as ToolOutput<N>;
}

function detailText(details: ErrorDetail[] | undefined): string {
  if (details === undefined || details.length === 0) return '';
  return (
    ' Details (path rule): ' + details.map((d) => `${d.path || '/'} ${d.rule}`).join('; ') + '.'
  );
}

const API_NEXT_STEPS: Record<string, string> = {
  scope_required:
    'Issue this node a token that carries the required scope in the console (/org), save it, and run: iwik init --service <url> --token-file <path>.',
  unauthorized:
    'The node token is missing, unknown, or revoked. Issue a new token in the console (/org) and run: iwik init --service <url> --token-file <path>.',
  node_revoked:
    'This node was revoked. Register a new node in the console (/org), issue it a token, and run iwik init again.',
  validation_failed:
    'Fix the fields at the listed paths and retry; submitted values are never echoed.',
  feature_disabled:
    'Intake is disabled on this deployment (IWIK_FEATURE_INTAKE); ask the operator.',
  preview_mismatch: 'Call preview_contribution for this run again, then submit_run.',
  preview_expired: 'Call preview_contribution for this run again, then submit_run.',
  preview_not_found: 'Call preview_contribution for this run first, then submit_run.',
  run_conflict:
    'This run_id was already accepted with different content; run the protocol again (a new run_id) instead of editing the stored run.',
  not_found: 'Check the id; only receipts and runs of your own organization are visible.',
  rate_limited: 'Wait for the Retry-After period before querying again.',
};

const RUNNER_NEXT_STEPS: Partial<Record<RunnerError['code'], string>> = {
  not_initialized:
    'Run on the node: iwik init --service <service url> --token-file <path to the node token>.',
  config_invalid: 'Fix ~/.iwik/config.json or run iwik init again.',
  policy_invalid:
    'Fix ~/.iwik/policy.json (iwik policy show) or delete it to restore the default deny-all policy.',
  preview_required: 'Call preview_contribution with this run_id first, then submit_run.',
  preview_expired: 'Call preview_contribution with this run_id again, then submit_run.',
  run_not_found: 'Check the run_id: iwik vault lists the runs on this node.',
  plan_not_found: 'Call plan_test first; it returns the plan_id to execute.',
  plan_invalid: 'The saved plan is malformed; call plan_test again to write a fresh one.',
  pack_not_found:
    'Install the domain pack under the packs directory (iwik init --packs-dir <dir>) and retry.',
  harness_digest_mismatch:
    'The local pack differs from the registry; check out the pack version the registry lists and retry.',
  protocol_digest_mismatch:
    'The local pack differs from the registry; check out the registry version and retry.',
  pack_digest_mismatch:
    'The local pack differs from the registry; check out the registry version and retry.',
  protocol_not_accepted:
    'Only accepted protocol versions run; pick one from get_protocol / GET /v1/protocols.',
  usage: 'Check the input values against the tool description and retry.',
  context_invalid: 'Context keys are dotted lowercase (e.g. model.requested) with scalar values.',
  api_error: 'Check that the service URL in ~/.iwik/config.json is reachable from this node.',
};

/** Map any thrown error to the error envelope; never echoes private values. */
export function errorEnvelope(err: unknown, nextStep?: string): ToolErrorEnvelope {
  if (err instanceof ApiError) {
    const next = nextStep ?? API_NEXT_STEPS[err.apiCode] ?? RUNNER_NEXT_STEPS.api_error;
    return fail(err.apiCode, err.message + detailText(err.details), next);
  }
  if (err instanceof RunnerError) {
    return fail(
      err.code,
      err.message + detailText(err.details),
      nextStep ?? RUNNER_NEXT_STEPS[err.code],
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return fail('internal', `unexpected runner error: ${message}`, 'Report this as a runner bug.');
}

function clientFor(home: string, ctx: ToolContext): ApiClient {
  const config = loadConfig(home);
  return new ApiClient(config.service_url, loadToken(home), ctx.fetch);
}

/** Common service answers of the ledger endpoints, with the operator's next step. */
function ledgerError(err: unknown, tool: string): ToolErrorEnvelope {
  if (err instanceof ApiError) {
    if (err.apiCode === 'feature_disabled') return errorEnvelope(err, LEDGER_FLAG_STEP);
    if (err.apiCode === 'not_found') {
      return errorEnvelope(
        err,
        `The receipt, claim, prediction, or run named is not one of your organization's (the service does not say which) and nothing was recorded. Use ids from get_receipt, query_evidence, register_prediction, or iwik vault and call ${tool} again.`,
      );
    }
    if (err.apiCode === 'rate_limited') {
      return errorEnvelope(
        err,
        'At most 5 challenges per organization per rolling 24 hours; the earlier ones stand. Wait for the Retry-After period, and consider whether one challenge with a precise statement covers the objection.',
      );
    }
  }
  return errorEnvelope(err);
}

type Handler<N extends ToolName> = (
  input: ToolInput<N>,
  ctx: ToolContext,
  home: string,
) => Promise<ToolOutput<N>>;

const handlers: { [N in ToolName]: Handler<N> } = {
  async get_protocol(input, ctx, home) {
    const res = await clientFor(home, ctx).get<Record<string, unknown>>(
      `/v1/protocols/${encodeURIComponent(input.protocol_ref)}`,
    );
    return ok<'get_protocol'>(
      res.body as Extract<ToolOutput<'get_protocol'>, { ok: true }>['data'],
    );
  },

  async query_evidence(input, ctx, home) {
    const res = await clientFor(home, ctx).post<AnswerReceipt>('/v1/evidence/query', input);
    const answer = res.body;
    if (answer.status === 'released') return ok<'query_evidence'>({ receipt: answer });
    // Stage 9: the receipt (own evidence included) is re-readable with
    // get_receipt; the envelope carries the bands, the reasons, and the step.
    const reasons = (answer.suppression_reasons ?? []).join(', ') || 'none given';
    return fail(
      answer.status,
      `${answer.status === 'insufficient_evidence' ? 'no cooperative evidence' : 'answer ' + answer.status} for ${input.protocol_ref}` +
        ` (receipt ${answer.receipt_id}, evidence revision ${answer.evidence_revision}, cohort orgs ${answer.cohort.orgs}, runs ${answer.cohort.runs}, reasons: ${reasons})`,
      nextStepFor(answer, input.protocol_ref),
    );
  },

  async plan_test(input, ctx, home) {
    const record = plan({
      home,
      protocol: input.protocol_ref,
      target: input.target.url,
      targetKind: input.target.kind,
      question: input.question,
      ...(input.context !== undefined ? { context: input.context } : {}),
      ...(input.planned !== undefined ? { planned: input.planned } : {}),
      ...(input.max_tokens !== undefined ? { maxTokens: input.max_tokens } : {}),
      ...(input.timeout_ms !== undefined ? { timeoutMs: input.timeout_ms } : {}),
      ...(input.prices !== undefined ? { prices: input.prices } : {}),
      ...(input.api_key_env !== undefined ? { apiKeyEnv: input.api_key_env } : {}),
      ...(input.investigation_id !== undefined ? { investigationId: input.investigation_id } : {}),
      ...(input.sharing_policy !== undefined ? { sharingPolicy: input.sharing_policy } : {}),
      ...(ctx.packsDir !== undefined ? { packsDir: ctx.packsDir } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    });
    return ok<'plan_test'>(planSummary(record));
  },

  async run_test(input, ctx, home) {
    // Policy first, with the operator's command in every denial. The same
    // checks run again inside `run()`; this pass only shapes the answer.
    const record = loadPlan(home, input.plan_id);
    const policy = loadPolicy(home);
    const url = parseTarget(record.target.url);
    const command = runPlanCommand(record.plan_id, targetHost(url), policy, url);
    try {
      const result = await runPlan(record.plan_id, {
        home,
        ...(ctx.packsDir !== undefined ? { packsDir: ctx.packsDir } : {}),
        ...(ctx.fetch !== undefined ? { fetch: ctx.fetch } : {}),
        ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      });
      const next =
        result.execution_status === 'succeeded'
          ? `Read the local report with iwik report ${result.run_id} (local evidence only). To contribute, call preview_contribution then submit_run with run_id ${result.run_id}.`
          : `The run is ${result.execution_status}` +
            (result.exclusion_reason !== undefined ? ` (${result.exclusion_reason})` : '') +
            `; iwik report ${result.run_id} shows the accounting and the vault holds the detail. Fix the cause and plan again rather than submitting a non-succeeded run as evidence.`;
      return ok<'run_test'>({
        run_id: result.run_id,
        plan_id: result.plan_id,
        execution_status: result.execution_status,
        ...(result.exclusion_reason !== undefined
          ? { exclusion_reason: result.exclusion_reason }
          : {}),
        accounting: result.accounting,
        context_unknown: result.context_unknown,
        issues: result.issues,
        estimated_cost_usd: result.estimated_cost.amount ?? 0,
        next_step: next,
      });
    } catch (err) {
      if (err instanceof RunnerError) {
        if (err.code === 'policy_denied' || err.code === 'target_not_allowed') {
          return errorEnvelope(err, command);
        }
        if (err.code === 'budget_exceeded') {
          return errorEnvelope(
            err,
            `${command}; raise the budget first: iwik policy set budget_per_plan_usd <usd> (estimate ${record.estimated_cost.amount ?? 'unknown'} USD)`,
          );
        }
        if (err.code === 'budget_unknown') {
          return errorEnvelope(
            err,
            `Plan again with the prices the pack cost model needs (plan_test prices: ${record.estimated_cost.basis}), then ${command}`,
          );
        }
      }
      return errorEnvelope(err);
    }
  },

  async preview_contribution(input, ctx, home) {
    const result = await preview(input.run_id, {
      home,
      ...(input.sharing_policy !== undefined ? { sharingPolicy: input.sharing_policy } : {}),
      ...(ctx.fetch !== undefined ? { fetch: ctx.fetch } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    });
    return ok<'preview_contribution'>({
      run_id: result.run_id,
      preview_id: result.preview_id,
      content_digest: result.content_digest,
      expires_at: result.expires_at,
      sanitization: result.sanitization,
      would_store: result.would_store,
      run: result.body.run,
    });
  },

  async submit_run(input, ctx, home) {
    const result = await submit(input.run_id, {
      home,
      ...(ctx.fetch !== undefined ? { fetch: ctx.fetch } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    });
    return ok<'submit_run'>({
      run_id: result.run_id,
      status: result.status,
      receipt: result.receipt,
    });
  },

  async get_receipt(input, ctx, home) {
    const body = await receipt(input.receipt_id, {
      home,
      ...(ctx.fetch !== undefined ? { fetch: ctx.fetch } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
    });
    return ok<'get_receipt'>({ receipt: body });
  },

  async challenge_finding(input, ctx, home) {
    // The frozen input names the grounds as { kind, rationale }: `kind` must
    // be one of the structured grounds and `rationale` is the one bounded
    // note (operator-only). Nothing else free-form is sent.
    if (!isChallengeGrounds(input.grounds.kind)) {
      return fail(
        'validation_failed',
        'grounds.kind is not one of the structured grounds. Details (path rule): /grounds/kind enum.',
        `Choose grounds.kind from: ${CHALLENGE_GROUNDS.join(', ')} and call challenge_finding again.`,
      );
    }
    if (input.grounds.rationale.length > CHALLENGE_NOTE_MAX_LENGTH) {
      return fail(
        'validation_failed',
        `grounds.rationale is longer than ${CHALLENGE_NOTE_MAX_LENGTH} characters. Details (path rule): /statement/note maxLength.`,
        `Shorten grounds.rationale to at most ${CHALLENGE_NOTE_MAX_LENGTH} characters (it is a note for the operator, not the objection itself; put the objection in statement) and call challenge_finding again.`,
      );
    }
    const statement: ChallengeStatement = {
      ...(input.statement ?? {}),
      note: input.grounds.rationale,
    };
    const target =
      input.claim_id !== undefined
        ? { kind: 'claim' as const, id: input.claim_id }
        : { kind: 'receipt' as const, id: input.receipt_id };
    try {
      const filed = await challenge(target, {
        home,
        grounds: input.grounds.kind,
        statement,
        ...(ctx.fetch !== undefined ? { fetch: ctx.fetch } : {}),
        ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      });
      return ok<'challenge_finding'>({
        challenge_id: filed.challenge_id,
        status: filed.status,
        grounds: filed.grounds,
        filed_at: filed.filed_at,
      });
    } catch (err) {
      if (err instanceof ApiError && err.apiCode === 'validation_failed') {
        return errorEnvelope(
          err,
          'Fix the listed fields: grounds.kind from the structured grounds, statement fields in the pack vocabulary, a note of at most 500 characters with no secrets, and a receipt whose answer was released.',
        );
      }
      return ledgerError(err, 'challenge_finding');
    }
  },

  async report_outcome(input, ctx, home) {
    // The frozen input is { receipt_id, observation, observed_at }; the
    // structured members (stage 10, additive) may come at the top level or
    // inside `observation`. The prediction must exist first.
    const observation = input.observation as Record<string, unknown>;
    const predictionId = input.prediction_id ?? observation['prediction_id'];
    const result = input.result ?? observation['result'];
    const environmentChanged = input.environment_changed ?? observation['environment_changed'];
    const evaluationRunId = input.evaluation_run_id ?? observation['evaluation_run_id'];
    if (typeof predictionId !== 'string' || !ULID_PATTERN.test(predictionId)) {
      return fail(
        'validation_failed',
        'report_outcome needs the prediction_id of a prediction registered earlier. Details (path rule): /prediction_id required.',
        'Call register_prediction with the receipt, target, horizon, and evaluation rule BEFORE acting; then report the outcome against the prediction_id it returns.',
      );
    }
    if (!isOutcomeResult(result)) {
      return fail(
        'validation_failed',
        'result is not one of the outcome results. Details (path rule): /result enum.',
        `Set result (or observation.result) to one of: ${OUTCOME_RESULTS.join(', ')}. Use environment_changed: true when the environment moved, instead of calling the prediction wrong.`,
      );
    }
    try {
      const recorded = await outcome(predictionId, {
        home,
        result,
        environmentChanged: environmentChanged === true,
        observedAt: input.observed_at,
        receiptId: input.receipt_id,
        ...(typeof evaluationRunId === 'string' ? { evaluationRunId } : {}),
        ...(ctx.fetch !== undefined ? { fetch: ctx.fetch } : {}),
        ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      });
      return ok<'report_outcome'>({
        outcome_id: recorded.outcome_id,
        prediction_id: recorded.prediction.prediction_id,
        result: recorded.observed.result,
        environment_changed: recorded.observed.environment_changed,
        recorded_at: recorded.recorded_at,
      });
    } catch (err) {
      if (err instanceof ApiError && err.apiCode === 'outcome_exists') {
        return errorEnvelope(
          err,
          'This prediction already has its observation; a prediction is judged exactly once. Register a new prediction for a new expectation.',
        );
      }
      if (err instanceof ApiError && err.apiCode === 'target_mismatch') {
        return errorEnvelope(
          err,
          'receipt_id must be the receipt the prediction was registered against; the registered prediction cannot be changed. Use the receipt from register_prediction, or register a new prediction.',
        );
      }
      return ledgerError(err, 'report_outcome');
    }
  },

  async register_prediction(input, ctx, home) {
    try {
      const registered = await predict({
        home,
        receiptId: input.receipt_id,
        target: input.target,
        horizon: input.horizon,
        ...(input.probability !== undefined ? { probability: input.probability } : {}),
        evaluationRule: input.evaluation_rule,
        ...(ctx.fetch !== undefined ? { fetch: ctx.fetch } : {}),
        ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      });
      return ok<'register_prediction'>({
        prediction_id: registered.prediction_id,
        registered_at: registered.registered_at,
        horizon: registered.horizon,
        evaluation_rule: registered.evaluation_rule,
      });
    } catch (err) {
      if (err instanceof ApiError && err.apiCode === 'validation_failed') {
        return errorEnvelope(
          err,
          `Fix the listed fields: target.claim must be one of the protocol's permitted claims (get_protocol), horizon a date (YYYY-MM-DD) not in the past, probability in [0, 1], evaluation_rule one of ${EVALUATION_RULES.join(', ')}.`,
        );
      }
      return ledgerError(err, 'register_prediction');
    }
  },

  async withdraw_contribution(input, ctx, home) {
    // The legacy free-text `reason` is never sent; it counts only when it is
    // exactly a vocabulary value. `reason_code` (stage 7, additive) wins.
    const reasonCode =
      input.reason_code ??
      (isWithdrawalReasonCode(input.reason) ? input.reason : undefined) ??
      'member_request';
    try {
      const result = await withdraw(input.run_ids, {
        home,
        reasonCode,
        ...(ctx.fetch !== undefined ? { fetch: ctx.fetch } : {}),
        ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      });
      return ok<'withdraw_contribution'>({
        withdrawal_id: result.withdrawal_id,
        effective_revision: result.effective_revision,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.apiCode === 'feature_disabled') {
          return errorEnvelope(
            err,
            'Withdrawal is disabled on this deployment (IWIK_FEATURE_WITHDRAWAL=off); nothing was withdrawn. Ask the operator to enable it, then call withdraw_contribution again.',
          );
        }
        if (err.apiCode === 'not_found') {
          return errorEnvelope(
            err,
            'At least one run id is not a run of your organization (the service does not say which) and nothing was withdrawn. Check the ids with iwik vault and call withdraw_contribution again with only your own run ids.',
          );
        }
        if (err.apiCode === 'validation_failed') {
          return errorEnvelope(
            err,
            `Send 1-100 run ids (ULIDs) and a reason_code from: ${WITHDRAWAL_REASON_CODES.join(', ')}.`,
          );
        }
      }
      return errorEnvelope(err);
    }
  },
};

export function isToolName(name: string): name is ToolName {
  return (toolNames as string[]).includes(name);
}

/**
 * Validate the input, run the tool, validate the output. Every failure is an
 * envelope, never a thrown error, so the agent always gets a `next_step`.
 */
export async function callTool<N extends ToolName>(
  name: N,
  input: unknown,
  ctx: ToolContext = {},
): Promise<ToolOutput<N>> {
  const inputCheck = validateTool(name, 'input', input ?? {});
  if (!inputCheck.ok) {
    return fail(
      'validation_failed',
      `input does not match the ${name} schema.` + detailText(inputCheck.errors),
      `Fix the listed fields (contracts/schema/v1/tools/${name}.input.schema.json) and call ${name} again.`,
    ) as ToolOutput<N>;
  }
  let envelope: ToolOutput<N>;
  try {
    const home = resolveHome(ctx.home, ctx.env);
    envelope = await (handlers[name] as Handler<N>)(input as ToolInput<N>, ctx, home);
  } catch (err) {
    envelope = errorEnvelope(err) as ToolOutput<N>;
  }
  const outputCheck = validateTool(name, 'output', envelope);
  if (!outputCheck.ok) {
    return fail(
      'internal',
      `${name} produced an output that does not match its schema.` + detailText(outputCheck.errors),
      'Report this as a runner bug; nothing beyond this message was returned.',
    ) as ToolOutput<N>;
  }
  return envelope;
}
