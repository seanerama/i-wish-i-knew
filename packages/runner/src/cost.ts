// Cost estimation from a pack's `claims.json` `cost_model` (ADR-0003: the
// runner enforces a per-plan budget and refuses to exceed it). The model is
// data the runner evaluates; packs never see the policy. A target the model
// cannot price yields `amount: null`, and the runner then refuses to execute
// (fail closed): a missing estimate is never treated as free.
//
// Model kinds:
//   per_request_tokens   amount = planned * (prompt_tokens_per_request * usd_per_1m_prompt_tokens
//                                            + max_tokens * usd_per_1m_completion_tokens) / 1e6
//                        with the two prices supplied by the operator (`--price k=v`).
//   flat_per_request     amount = planned * per_request_usd
// Every kind prices a `fixture` target at `fixture_per_request_usd` per request
// (0 unless the pack says otherwise).
import type { RunTarget } from '@iwik/contracts';

export interface CostModel {
  version: number;
  currency: 'usd';
  kind: 'per_request_tokens' | 'flat_per_request';
  fixture_per_request_usd: number;
  prompt_tokens_per_request?: number;
  per_request_usd?: number;
  requires_operator_prices: string[];
  formula?: string;
}

export interface CostInputs {
  targetKind: RunTarget['kind'];
  planned: number;
  maxTokens: number;
  /** Operator-supplied prices keyed by the model's input names, e.g. `usd_per_1m_prompt_tokens`. */
  prices?: Record<string, number> | undefined;
}

export interface CostEstimate {
  currency: 'usd';
  /** null when the target cannot be priced; the caller must refuse to execute. */
  amount: number | null;
  /** How the number was reached, or why there is none. Never contains values from the target. */
  basis: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Read `cost_model` out of a parsed claims.json; undefined when the pack declares none. */
export function parseCostModel(claims: Record<string, unknown>): CostModel | undefined {
  const raw = claims['cost_model'];
  if (!isObject(raw)) return undefined;
  const kind = raw['kind'];
  if (kind !== 'per_request_tokens' && kind !== 'flat_per_request') return undefined;
  const prices = Array.isArray(raw['requires_operator_prices'])
    ? (raw['requires_operator_prices'] as unknown[]).filter(
        (p): p is string => typeof p === 'string',
      )
    : [];
  const model: CostModel = {
    version: typeof raw['version'] === 'number' ? raw['version'] : 1,
    currency: 'usd',
    kind,
    fixture_per_request_usd: nonNegative(raw['fixture_per_request_usd']) ?? 0,
    requires_operator_prices: prices,
  };
  const prompt = nonNegative(raw['prompt_tokens_per_request']);
  if (prompt !== undefined) model.prompt_tokens_per_request = prompt;
  const flat = nonNegative(raw['per_request_usd']);
  if (flat !== undefined) model.per_request_usd = flat;
  if (typeof raw['formula'] === 'string') model.formula = raw['formula'];
  return model;
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

export function estimateCost(model: CostModel | undefined, inputs: CostInputs): CostEstimate {
  const { planned, maxTokens, targetKind } = inputs;
  if (targetKind === 'fixture') {
    const per = model?.fixture_per_request_usd ?? 0;
    return {
      currency: 'usd',
      amount: round(planned * per),
      basis: `fixture target: ${planned} requests at ${per} USD each (pack cost model)`,
    };
  }
  if (model === undefined) {
    return {
      currency: 'usd',
      amount: null,
      basis: `the pack declares no cost_model, so a ${targetKind} target cannot be priced`,
    };
  }
  const prices = inputs.prices ?? {};
  const missing = model.requires_operator_prices.filter(
    (name) => nonNegative(prices[name]) === undefined,
  );
  if (missing.length > 0) {
    return {
      currency: 'usd',
      amount: null,
      basis: `operator prices required for a ${targetKind} target: ${missing.join(', ')} (iwik plan --price <name>=<usd>)`,
    };
  }
  if (model.kind === 'flat_per_request') {
    const per = model.per_request_usd ?? nonNegative(prices['per_request_usd']);
    if (per === undefined) {
      return {
        currency: 'usd',
        amount: null,
        basis: 'flat_per_request model without per_request_usd',
      };
    }
    return {
      currency: 'usd',
      amount: round(planned * per),
      basis: `${planned} requests at ${per} USD each`,
    };
  }
  const promptTokens = model.prompt_tokens_per_request ?? 0;
  const promptPrice = prices['usd_per_1m_prompt_tokens'] ?? 0;
  const completionPrice = prices['usd_per_1m_completion_tokens'] ?? 0;
  const amount = round(
    (planned * (promptTokens * promptPrice + maxTokens * completionPrice)) / 1_000_000,
  );
  return {
    currency: 'usd',
    amount,
    basis:
      `${planned} requests x (${promptTokens} prompt tokens x ${promptPrice} USD/1M + ` +
      `${maxTokens} max completion tokens x ${completionPrice} USD/1M); upper bound`,
  };
}
