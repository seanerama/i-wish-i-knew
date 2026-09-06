// Runner errors: one code, one fixed exit status, and an optional detail list
// in the member-api `{ path, rule }` shape. Messages never carry token or key
// material and never echo a submitted value; API errors carry only the
// service's error envelope, which obeys the same rule.
export type RunnerErrorCode =
  | 'not_initialized'
  | 'config_invalid'
  | 'policy_invalid'
  | 'policy_denied'
  | 'target_not_allowed'
  | 'target_invalid'
  | 'pack_not_found'
  | 'pack_invalid'
  | 'manifest_invalid'
  | 'protocol_not_accepted'
  | 'harness_digest_mismatch'
  | 'protocol_digest_mismatch'
  | 'result_schema_digest_mismatch'
  | 'context_schema_digest_mismatch'
  | 'pack_digest_mismatch'
  | 'context_invalid'
  | 'run_not_found'
  | 'run_invalid'
  | 'preview_required'
  | 'preview_expired'
  | 'api_error'
  | 'usage';

/** Process exit status per error family (`iwik` exits nonzero with a one-line reason). */
export const EXIT_CODES: Record<RunnerErrorCode, number> = {
  usage: 2,
  policy_denied: 3,
  target_not_allowed: 3,
  target_invalid: 3,
  harness_digest_mismatch: 4,
  protocol_digest_mismatch: 4,
  result_schema_digest_mismatch: 4,
  context_schema_digest_mismatch: 4,
  pack_digest_mismatch: 4,
  protocol_not_accepted: 4,
  pack_not_found: 4,
  pack_invalid: 4,
  manifest_invalid: 4,
  api_error: 5,
  preview_required: 6,
  preview_expired: 6,
  run_not_found: 6,
  run_invalid: 6,
  not_initialized: 7,
  config_invalid: 7,
  policy_invalid: 7,
  context_invalid: 2,
};

export interface ErrorDetail {
  path: string;
  rule: string;
}

export class RunnerError extends Error {
  override name = 'RunnerError';
  readonly code: RunnerErrorCode;
  readonly exitCode: number;
  readonly details: ErrorDetail[] | undefined;

  constructor(code: RunnerErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.code = code;
    this.exitCode = EXIT_CODES[code];
    this.details = details;
  }
}

/** A non-2xx answer from the service, carrying its error envelope only. */
export class ApiError extends RunnerError {
  override name = 'ApiError';
  readonly status: number;
  /** `error.code` from the envelope (or `http_<status>` when the body was not an envelope). */
  readonly apiCode: string;
  /** The raw response body, for diagnostics; the service never echoes submitted values. */
  readonly body: string;

  constructor(
    status: number,
    apiCode: string,
    message: string,
    details: ErrorDetail[],
    body: string,
  ) {
    super('api_error', `${apiCode}: ${message} (HTTP ${status})`, details);
    this.status = status;
    this.apiCode = apiCode;
    this.body = body;
  }
}

export function isRunnerError(err: unknown): err is RunnerError {
  return err instanceof RunnerError;
}
