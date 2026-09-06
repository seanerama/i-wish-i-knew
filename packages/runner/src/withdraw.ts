// `iwik withdraw` and the `withdraw_contribution` tool (contracts/member-api.md
// `POST /v1/withdrawals`, ADR-0002 §6). The node asks the service to withdraw
// its organization's runs; the withdrawal takes effect at the next evidence
// revision and receipts issued earlier read `stale`. Only ids and a reason
// code from the fixed vocabulary cross the wire: never free text.
import { ApiClient } from './client.js';
import { RunnerError } from './errors.js';
import type { ErrorDetail } from './errors.js';
import { loadConfig, loadToken, resolveHome } from './home.js';
import type { ClientOptions } from './submit.js';
import { ULID_PATTERN } from './ulid.js';

export const WITHDRAWAL_REASON_CODES = ['member_request', 'data_error', 'policy_change'] as const;
export type WithdrawalReasonCode = (typeof WITHDRAWAL_REASON_CODES)[number];

export function isWithdrawalReasonCode(value: unknown): value is WithdrawalReasonCode {
  return (
    typeof value === 'string' && (WITHDRAWAL_REASON_CODES as readonly string[]).includes(value)
  );
}

export interface WithdrawOptions extends ClientOptions {
  /** Defaults to `member_request`. */
  reasonCode?: WithdrawalReasonCode;
}

export interface WithdrawResult {
  withdrawal_id: string;
  effective_revision: number;
  /** 201 when newly recorded, 200 when the same set was already withdrawn. */
  status: number;
  /** The ids sent: de-duplicated and sorted, the service's idempotency unit. */
  run_ids: string[];
  reason_code: WithdrawalReasonCode;
}

export async function withdraw(
  runIds: readonly string[],
  options: WithdrawOptions = {},
): Promise<WithdrawResult> {
  const home = resolveHome(options.home, options.env);
  const reasonCode = options.reasonCode ?? 'member_request';
  const issues: ErrorDetail[] = [];
  runIds.forEach((id, i) => {
    if (!ULID_PATTERN.test(id)) issues.push({ path: `/run_ids/${i}`, rule: 'pattern' });
  });
  if (runIds.length === 0) issues.push({ path: '/run_ids', rule: 'minItems' });
  if (!isWithdrawalReasonCode(reasonCode)) issues.push({ path: '/reason_code', rule: 'enum' });
  if (issues.length > 0) {
    throw new RunnerError(
      'usage',
      `withdraw needs one or more run ids (ULIDs) and a reason from: ${WITHDRAWAL_REASON_CODES.join(', ')}`,
      issues,
    );
  }
  const ids = [...new Set(runIds)].sort();
  const config = loadConfig(home);
  const client = new ApiClient(config.service_url, loadToken(home), options.fetch);
  const res = await client.post<{ withdrawal_id?: unknown; effective_revision?: unknown }>(
    '/v1/withdrawals',
    { run_ids: ids, reason_code: reasonCode },
  );
  const body = res.body ?? {};
  if (
    typeof body.withdrawal_id !== 'string' ||
    typeof body.effective_revision !== 'number' ||
    !Number.isInteger(body.effective_revision)
  ) {
    throw new RunnerError(
      'api_error',
      'withdrawal response lacks withdrawal_id/effective_revision',
    );
  }
  return {
    withdrawal_id: body.withdrawal_id,
    effective_revision: body.effective_revision,
    status: res.status,
    run_ids: ids,
    reason_code: reasonCode,
  };
}
