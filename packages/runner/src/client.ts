// member-api client over the built-in fetch. Bearer token from the home;
// every non-2xx answer becomes an ApiError carrying the service's error
// envelope (codes, paths, rules; never values).
import { ApiError, RunnerError } from './errors.js';
import type { ErrorDetail } from './errors.js';

export type FetchLike = typeof fetch;

export interface ApiResponse<T> {
  status: number;
  body: T;
}

interface ErrorEnvelope {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

function envelopeOf(text: string): { code: string; message: string; details: ErrorDetail[] } {
  try {
    const parsed = JSON.parse(text) as ErrorEnvelope;
    const error = parsed.error ?? {};
    const details = Array.isArray(error.details)
      ? error.details
          .filter(
            (d): d is ErrorDetail =>
              typeof d === 'object' &&
              d !== null &&
              typeof (d as ErrorDetail).path === 'string' &&
              typeof (d as ErrorDetail).rule === 'string',
          )
          .map((d) => ({ path: d.path, rule: d.rule }))
      : [];
    return {
      code: typeof error.code === 'string' ? error.code : 'unknown',
      message: typeof error.message === 'string' ? error.message : 'no error message',
      details,
    };
  } catch {
    return { code: 'unknown', message: 'non-JSON error body', details: [] };
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string, token: string, fetchImpl: FetchLike = globalThis.fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async get<T>(path: string): Promise<ApiResponse<T>> {
    return this.call<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<ApiResponse<T>> {
    return this.call<T>('POST', path, body);
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'application/json',
    };
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(this.baseUrl + path, init);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new RunnerError('api_error', `service unreachable at ${this.baseUrl}: ${reason}`);
    }
    const text = await res.text();
    if (res.status < 200 || res.status >= 300) {
      const env = envelopeOf(text);
      const code = env.code === 'unknown' ? `http_${res.status}` : env.code;
      throw new ApiError(res.status, code, env.message, env.details, text);
    }
    let parsed: T;
    try {
      parsed = (text === '' ? null : JSON.parse(text)) as T;
    } catch {
      throw new RunnerError('api_error', `service answered ${res.status} with a non-JSON body`);
    }
    return { status: res.status, body: parsed };
  }
}
