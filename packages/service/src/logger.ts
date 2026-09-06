// Structured JSON logs (pino). Request logs carry method, path, status, and
// the caller's org_ref (added by the identity hook). Request and response
// bodies, headers, and query strings are never serialized.
import type { FastifyServerOptions } from 'fastify';
import type { Config } from './config.js';

type LoggerOptions = Exclude<FastifyServerOptions['logger'], boolean | undefined>;

export function loggerOptions(config: Config): LoggerOptions {
  return {
    level: config.logLevel,
    base: { service: 'iwik' },
    serializers: {
      req(request: { id: unknown; method: string; url: string }) {
        return { id: request.id, method: request.method, path: request.url.split('?')[0] };
      },
      res(response: { statusCode: number }) {
        return { statusCode: response.statusCode };
      },
      err(error: Error & { code?: unknown }) {
        return {
          type: error.name,
          message: error.message,
          code: typeof error.code === 'string' ? error.code : undefined,
          stack: error.stack ?? '',
        };
      },
    },
  };
}
