// agent-tools v1 — the ten tools of contracts/agent-tools.md, each with an
// input schema and an output schema (the common envelope around a per-tool
// `data` shape). `tools` is the ordered map the schema builder, the MCP
// adapter, and the contract test all use, so the committed JSON under
// contracts/schema/v1/tools/ and the adapter's validators cannot disagree.
//
// Frozen: tool names, required inputs, and the envelope do not change; new
// optional inputs and new tools are additive.
import { Type } from '@sinclair/typebox';
import type { Static, TSchema } from '@sinclair/typebox';
import { AnswerReceipt } from '../answer-receipt.js';
import {
  ContextKey,
  Count,
  Digest,
  OpaqueObject,
  ProtocolRef,
  StringEnum,
  Timestamp,
  Ulid,
} from '../common.js';
import { ContextValue } from '../context.js';
import { ProtocolVersion } from '../protocol-version.js';
import { ExecutionStatus, Run, RunAccounting, SharingPolicy, TargetKind } from '../run.js';
import { toolOutput } from './envelope.js';

export * from './envelope.js';

export type ToolScope = 'query' | 'submit' | 'publish' | 'local_policy';
export type ToolSideEffect = 'read' | 'local_write' | 'paid' | 'remote_write';

export interface ToolDefinition<I extends TSchema = TSchema, O extends TSchema = TSchema> {
  description: string;
  /** Cloud scope the tool needs, or `local_policy` for execution (ADR-0006). */
  scope: ToolScope;
  side_effect: ToolSideEffect;
  input: I;
  output: O;
}

function define<I extends TSchema, O extends TSchema>(
  d: ToolDefinition<I, O>,
): ToolDefinition<I, O> {
  return d;
}

// --------------------------------------------------------------------- shared

/** `GET /v1/protocols/{ref}`: the ProtocolVersion plus the registry's pack pointer. */
export const ProtocolManifest = Type.Object(
  {
    ...ProtocolVersion.properties,
    pack: Type.Optional(
      Type.Object(
        {
          id: Type.Optional(Type.String()),
          version: Type.Optional(Type.String()),
          pack_digest: Type.Optional(Digest),
          download: Type.Optional(OpaqueObject('Download pointer')),
        },
        { additionalProperties: true },
      ),
    ),
  },
  { additionalProperties: false, description: 'ProtocolVersion with its pack pointer' },
);
export type ProtocolManifest = Static<typeof ProtocolManifest>;

export const ContextMap = Type.Record(ContextKey, ContextValue, {
  description: 'Operator-supplied context, keyed by dotted context key',
});
export type ContextMap = Static<typeof ContextMap>;

export const PlanTarget = Type.Object(
  {
    url: Type.String({ minLength: 1, description: 'Target base URL (http or https)' }),
    kind: TargetKind,
  },
  { additionalProperties: false },
);
export type PlanTarget = Static<typeof PlanTarget>;

export const EstimatedCost = Type.Object(
  {
    currency: Type.Literal('usd'),
    amount: Type.Union([Type.Number({ minimum: 0 }), Type.Null()], {
      description:
        "null when the pack's cost model cannot price this target; the runner then refuses to execute (fail closed)",
    }),
    basis: Type.String({ description: 'How the estimate was computed, or why it could not be' }),
    budget_per_plan_usd: Type.Number({ minimum: 0 }),
    within_budget: Type.Union([Type.Boolean(), Type.Null()]),
  },
  { additionalProperties: false },
);
export type EstimatedCost = Static<typeof EstimatedCost>;

export const PlanSummary = Type.Object(
  {
    plan_id: Ulid,
    created_at: Timestamp,
    protocol_ref: ProtocolRef,
    protocol_digest: Digest,
    target: PlanTarget,
    question: Type.String(),
    context: ContextMap,
    required_context: Type.Object(
      {
        known: Type.Array(ContextKey),
        unknown: Type.Array(ContextKey, {
          description:
            'Required keys nobody supplied yet; the run is excluded unless the harness measures them',
        }),
      },
      { additionalProperties: false },
    ),
    planned: Type.Integer({ minimum: 1 }),
    max_tokens: Type.Integer({ minimum: 1 }),
    timeout_ms: Type.Integer({ minimum: 1 }),
    sharing_policy: SharingPolicy,
    investigation_id: Type.Optional(Ulid),
    api_key_env: Type.Optional(
      Type.String({
        minLength: 1,
        description: 'NAME of the environment variable holding the target API key; never the key',
      }),
    ),
    estimated_cost: EstimatedCost,
    resolves: Type.Object(
      { claims: Type.Array(Type.String()), statement: Type.String() },
      { additionalProperties: false },
    ),
    execution: Type.Object(
      {
        allowed: Type.Boolean({ description: 'Whether local policy allows run_test right now' }),
        reasons: Type.Array(Type.String()),
        next_step: Type.String(),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false, description: 'A saved plan under ~/.iwik/plans/<plan_id>.json' },
);
export type PlanSummary = Static<typeof PlanSummary>;

/**
 * `POST /v1/withdrawals` reason vocabulary (stage 7, additive). Enums only
 * gain members.
 */
export const WithdrawalReasonCode = StringEnum(
  ['member_request', 'data_error', 'policy_change'] as const,
  'Withdrawal reason: member_request | data_error | policy_change',
);
export type WithdrawalReasonCode = Static<typeof WithdrawalReasonCode>;

// ---------------------------------------------------------------------- tools

export const tools = {
  get_protocol: define({
    description:
      'Read one accepted protocol version: procedure identity, required context, permitted claims.',
    scope: 'query',
    side_effect: 'read',
    input: Type.Object({ protocol_ref: ProtocolRef }, { additionalProperties: false }),
    output: toolOutput(ProtocolManifest, 'GET /v1/protocols/{ref}'),
  }),
  query_evidence: define({
    description:
      'Ask the cooperative for evidence on a protocol under context filters. Returns a released AnswerReceipt, or ok:false with insufficient_evidence or suppressed and a next step.',
    scope: 'query',
    side_effect: 'read',
    input: Type.Object(
      {
        protocol_ref: ProtocolRef,
        investigation_id: Type.Optional(Ulid),
        context_filters: Type.Optional(
          Type.Record(Type.String(), ContextValue, {
            description: 'Context filters by context key',
          }),
        ),
        as_of_revision: Type.Optional(Count),
      },
      { additionalProperties: false },
    ),
    output: toolOutput(
      Type.Object({ receipt: AnswerReceipt }, { additionalProperties: false }),
      'POST /v1/evidence/query',
    ),
  }),
  plan_test: define({
    description:
      'Plan a local test: choose protocol, target, and context; saves the plan locally and returns its id, estimated cost, and what uncertainty it resolves. Never executes.',
    scope: 'query',
    side_effect: 'local_write',
    input: Type.Object(
      {
        protocol_ref: ProtocolRef,
        target: PlanTarget,
        question: Type.String({ minLength: 1 }),
        context: Type.Optional(ContextMap),
        planned: Type.Optional(Type.Integer({ minimum: 1 })),
        max_tokens: Type.Optional(Type.Integer({ minimum: 1 })),
        timeout_ms: Type.Optional(Type.Integer({ minimum: 1 })),
        prices: Type.Optional(
          Type.Record(Type.String(), Type.Number({ minimum: 0 }), {
            description:
              "Operator-supplied prices the pack's cost model needs for non-fixture targets, keyed by the model's input names",
          }),
        ),
        investigation_id: Type.Optional(Ulid),
        sharing_policy: Type.Optional(SharingPolicy),
        api_key_env: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              'NAME of the environment variable on the node that holds the target API key; the key itself never passes through a tool',
          }),
        ),
      },
      { additionalProperties: false },
    ),
    output: toolOutput(PlanSummary, 'runner: plan saved under ~/.iwik/plans/'),
  }),
  run_test: define({
    description:
      'Execute a saved plan under local policy. Denied unless policy.json allows execution for the target and the estimate fits the budget; the denial carries the exact iwik command for the operator.',
    scope: 'local_policy',
    side_effect: 'paid',
    input: Type.Object({ plan_id: Ulid }, { additionalProperties: false }),
    output: toolOutput(
      Type.Object(
        {
          run_id: Ulid,
          plan_id: Ulid,
          execution_status: ExecutionStatus,
          exclusion_reason: Type.Optional(Type.String()),
          accounting: RunAccounting,
          context_unknown: Type.Array(ContextKey),
          issues: Type.Array(Type.String()),
          estimated_cost_usd: Type.Number({ minimum: 0 }),
          next_step: Type.String(),
        },
        { additionalProperties: false },
      ),
      'runner: iwik run --plan',
    ),
  }),
  preview_contribution: define({
    description:
      'Dry-run intake for a run in the vault: validation, sanitization report, and exactly what would be sent.',
    scope: 'submit',
    side_effect: 'read',
    input: Type.Object(
      { run_id: Ulid, sharing_policy: Type.Optional(SharingPolicy) },
      { additionalProperties: false },
    ),
    output: toolOutput(
      Type.Object(
        {
          run_id: Ulid,
          preview_id: Ulid,
          content_digest: Digest,
          expires_at: Timestamp,
          sanitization: Type.Unknown(),
          would_store: Type.Unknown(),
          run: Run,
        },
        { additionalProperties: false },
      ),
      'POST /v1/contributions/preview',
    ),
  }),
  submit_run: define({
    description: 'Submit the previewed run; refuses without a preview. Safe to repeat.',
    scope: 'submit',
    side_effect: 'remote_write',
    input: Type.Object({ run_id: Ulid }, { additionalProperties: false }),
    output: toolOutput(
      Type.Object(
        {
          run_id: Ulid,
          status: Type.Integer({ description: '201 accepted, 200 already accepted' }),
          receipt: OpaqueObject('Intake receipt'),
        },
        { additionalProperties: false },
      ),
      'POST /v1/runs',
    ),
  }),
  get_receipt: define({
    description: "Re-read one of your organization's receipts (intake or query).",
    scope: 'query',
    side_effect: 'read',
    input: Type.Object({ receipt_id: Ulid }, { additionalProperties: false }),
    output: toolOutput(
      Type.Object(
        { receipt: OpaqueObject('Intake or answer receipt') },
        { additionalProperties: false },
      ),
      'GET /v1/receipts/{id}',
    ),
  }),
  challenge_finding: define({
    description: 'File a structured challenge against a released finding (milestone 0.3).',
    scope: 'publish',
    side_effect: 'remote_write',
    input: Type.Object(
      {
        receipt_id: Ulid,
        grounds: Type.Object(
          { kind: Type.String({ minLength: 1 }), rationale: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
    output: toolOutput(
      Type.Object({ challenge_id: Ulid }, { additionalProperties: false }),
      'POST /v1/challenges',
    ),
  }),
  report_outcome: define({
    description: 'Report an observed outcome against a prior released prediction (milestone 0.3).',
    scope: 'publish',
    side_effect: 'remote_write',
    input: Type.Object(
      {
        receipt_id: Ulid,
        observation: OpaqueObject("What was observed, in the protocol's vocabulary"),
        observed_at: Timestamp,
      },
      { additionalProperties: false },
    ),
    output: toolOutput(
      Type.Object({ outcome_id: Ulid }, { additionalProperties: false }),
      'POST /v1/outcomes',
    ),
  }),
  withdraw_contribution: define({
    description:
      'Withdraw your own runs; effective at the next evidence revision. Every run id must belong to your organization; the service never says which one was not.',
    scope: 'publish',
    side_effect: 'remote_write',
    input: Type.Object(
      {
        run_ids: Type.Array(Ulid, { minItems: 1, maxItems: 100 }),
        reason: Type.Optional(
          Type.String({
            description:
              'Legacy free-text reason (stage 5). Never sent to the service: it is used only when it exactly equals a reason_code value.',
          }),
        ),
        // Stage 7 (additive): the member-api reason vocabulary; defaults to member_request.
        reason_code: Type.Optional(WithdrawalReasonCode),
      },
      { additionalProperties: false },
    ),
    output: toolOutput(
      Type.Object(
        {
          withdrawal_id: Ulid,
          // Stage 7 (additive): the evidence revision at which the withdrawal took effect.
          effective_revision: Type.Optional(Count),
        },
        { additionalProperties: false },
      ),
      'POST /v1/withdrawals',
    ),
  }),
} as const;

export type ToolName = keyof typeof tools;
export const toolNames = Object.keys(tools) as ToolName[];

export type ToolInput<N extends ToolName> = Static<(typeof tools)[N]['input']>;
export type ToolOutput<N extends ToolName> = Static<(typeof tools)[N]['output']>;
