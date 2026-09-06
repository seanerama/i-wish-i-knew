// The member-api error envelope (contracts/member-api.md):
//   { error: { code, message, details: [ { path, rule } ] } }
// Messages are fixed per code and details carry JSON paths and rule names
// only. No submitted value is ever interpolated into an error body.
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export interface ErrorDetail {
  path: string;
  rule: string;
}

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: ErrorDetail[] };
}

const MESSAGES: Record<string, string> = {
  bad_json: 'request body is not valid JSON',
  bad_request: 'request is malformed',
  bad_signature: 'submission signature does not verify against the node key',
  feature_disabled: 'this feature is disabled on this deployment',
  internal: 'internal error',
  not_found: 'resource not found',
  not_ready: 'service is not ready',
  preview_expired: 'preview has expired; preview again',
  preview_mismatch: 'preview content digest does not match the submitted body',
  preview_not_found: 'preview not found for this organization',
  run_conflict: 'run_id already exists with different content',
  scope_required: 'token lacks the required scope',
  unauthorized: 'missing, unknown, or revoked token',
  validation_failed: 'submission failed validation',
};

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly details: ErrorDetail[] | undefined;
  readonly headers: Record<string, string> | undefined;

  constructor(
    status: number,
    code: string,
    options: { details?: ErrorDetail[]; headers?: Record<string, string> } = {},
  ) {
    super(MESSAGES[code] ?? code);
    this.status = status;
    this.code = code;
    this.details = options.details;
    this.headers = options.headers;
  }

  toEnvelope(): ErrorEnvelope {
    const error: ErrorEnvelope['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

export function scopeRequired(scope: string): ApiError {
  // The scope name is contract vocabulary, never a submitted value.
  return new ApiError(403, 'scope_required', { details: [{ path: '', rule: `scope:${scope}` }] });
}

function isFastifyError(err: unknown): err is FastifyError {
  return typeof err === 'object' && err !== null && 'code' in err && 'statusCode' in err;
}

/** Register the envelope-shaped error and not-found handlers on the instance. */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    reply.status(404).send(new ApiError(404, 'not_found').toEnvelope());
  });

  app.setErrorHandler((err: unknown, request: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ApiError) {
      if (err.headers) reply.headers(err.headers);
      reply.status(err.status).send(err.toEnvelope());
      return;
    }
    if (isFastifyError(err)) {
      const code = err.code;
      if (code === 'FST_ERR_CTP_INVALID_JSON_BODY' || code === 'FST_ERR_CTP_EMPTY_JSON_BODY') {
        reply.status(400).send(new ApiError(400, 'bad_json').toEnvelope());
        return;
      }
      if (err.validation !== undefined) {
        const details: ErrorDetail[] = err.validation.map((v) => ({
          path: v.instancePath,
          rule: v.keyword,
        }));
        reply.status(422).send(new ApiError(422, 'validation_failed', { details }).toEnvelope());
        return;
      }
      const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
      if (status >= 400 && status < 500) {
        reply.status(status).send(new ApiError(status, 'bad_request').toEnvelope());
        return;
      }
    }
    // Log the error (never the request body: the serializers only carry
    // method/url/id) and answer with a fixed envelope.
    request.log.error({ err }, 'unhandled error');
    reply.status(500).send(new ApiError(500, 'internal').toEnvelope());
  });
}
