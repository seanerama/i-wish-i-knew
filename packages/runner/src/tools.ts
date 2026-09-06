// The ten agent tools (contracts/agent-tools.md), each a thin projection of
// one member-api call or one local runner action, wrapped in the common
// envelope `{ ok: true, data } | { ok: false, error: { code, message,
// next_step } }`. Inputs and outputs are validated against the generated
// schemas in contracts/schema/v1/tools/. Nothing here bypasses the disclosure
// policy or the local execution policy: `run_test` is denied unless
// policy.json allows it and answers with the exact `iwik run --plan` command.
import type {
  AnswerReceipt,
  ToolErrorEnvelope,
  ToolInput,
  ToolName,
  ToolOutput,
} from '@iwik/contracts';
import { toolNames, validateTool } from '@iwik/contracts';
import { ApiClient } from './client.js';
import type { FetchLike } from './client.js';
import { ApiError, RunnerError } from './errors.js';
import type { ErrorDetail } from './errors.js';
import { loadConfig, loadToken, resolveHome } from './home.js';
import { loadPlan, plan, planSummary, runPlanCommand } from './plan.js';
import { loadPolicy, parseTarget, targetHost } from './policy.js';
import { runPlan } from './run.js';
import { preview, receipt, submit } from './submit.js';

export interface ToolContext {
  home?: string;
  packsDir?: string;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

export type Envelope<N extends ToolName = ToolName> = ToolOutput<N>;

/** Tools that exist on the surface but whose service side lands in milestone 0.3. */
export const NOT_YET_AVAILABLE: ReadonlySet<ToolName> = new Set<ToolName>([
  'challenge_finding',
  'report_outcome',
  'withdraw_contribution',
]);

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

function notYetAvailable(tool: ToolName, anchor: string): ToolErrorEnvelope {
  return fail(
    'not_yet_available',
    `${tool} is not available in milestone 0.2 (local investigation); nothing was sent`,
    `Milestone 0.3 (protected cooperative: challenge and outcome ledger, withdrawals) adds the service side of ${tool}. Keep ${anchor} for when it lands.`,
  );
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
    const reasons = (answer.suppression_reasons ?? []).join(', ') || 'none given';
    const filters = Object.keys(input.context_filters ?? {});
    return fail(
      answer.status,
      `${answer.status === 'insufficient_evidence' ? 'no cooperative evidence' : 'answer ' + answer.status} for ${input.protocol_ref}` +
        ` (receipt ${answer.receipt_id}, evidence revision ${answer.evidence_revision}, cohort orgs ${answer.cohort.orgs}, runs ${answer.cohort.runs}, reasons: ${reasons})`,
      answer.status === 'insufficient_evidence'
        ? `Tell the user honestly that the commons has no shareable evidence for this question yet. To resolve it locally: call plan_test with protocol_ref ${input.protocol_ref}, the target, and the question` +
            (filters.length > 0 ? ` (context: ${filters.join(', ')})` : '') +
            `; the operator then runs the returned iwik run --plan command, and iwik report <run_id> shows the local result. Re-read this receipt later with get_receipt ${answer.receipt_id}.`
        : `The cooperative withheld the answer (${reasons}). Explain that suppression protects members; broaden the context filters or wait for more contributors, and re-read with get_receipt ${answer.receipt_id}.`,
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

  async challenge_finding(input) {
    return notYetAvailable('challenge_finding', `receipt ${input.receipt_id} and your grounds`);
  },

  async report_outcome(input) {
    return notYetAvailable('report_outcome', `receipt ${input.receipt_id} and the observation`);
  },

  async withdraw_contribution(input) {
    return notYetAvailable('withdraw_contribution', `the run ids (${input.run_ids.length})`);
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
