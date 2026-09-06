#!/usr/bin/env node
'use strict';
// Harness for inference-api/latency@1 (contracts/runner-pack.md).
//
// Performs `budget.planned` sequential streaming chat completions against
// `target.url` (OpenAI-compatible `/v1/chat/completions`), measuring
// time-to-first-token and total latency per attempt. Node built-ins only.
//
// Env (set by the runner):
//   IWIK_INPUT          path to input.json
//   IWIK_OUTPUT         writable directory for attempts.jsonl, result.json, context.json
//   IWIK_ALLOWED_HOSTS  comma-separated hosts this harness may contact
//
// input.json: { plan_id, protocol_ref, target: { url, model, api_key?, headers? },
//               context: { <context key>: value }, budget: { planned, max_tokens? },
//               timeout_ms }
//
// Exit codes (contract): 0 completed; 2 protocol violated (first stderr line is
// the reason); 3 target unreachable before any attempt; other = crash.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');

const HARNESS_VERSION = '1.0.0';
const PROTOCOL_REF = 'inference-api/latency@1';
const EXIT_OK = 0;
const EXIT_PROTOCOL_VIOLATED = 2;
const EXIT_UNREACHABLE = 3;

class ProtocolViolation extends Error {}
class Unreachable extends Error {}

const prompts = require('./prompts.json');

// ---------------------------------------------------------------- input

function readInput(env) {
  if (!env.IWIK_INPUT) throw new ProtocolViolation('IWIK_INPUT is not set');
  if (!env.IWIK_OUTPUT) throw new ProtocolViolation('IWIK_OUTPUT is not set');
  let input;
  try {
    input = JSON.parse(fs.readFileSync(env.IWIK_INPUT, 'utf8'));
  } catch (err) {
    throw new ProtocolViolation(`cannot read IWIK_INPUT: ${err.code || err.name}`);
  }
  if (input.protocol_ref !== PROTOCOL_REF) {
    throw new ProtocolViolation(`protocol_ref mismatch: harness implements ${PROTOCOL_REF}`);
  }
  if (!input.target || typeof input.target.url !== 'string') {
    throw new ProtocolViolation('target.url is required');
  }
  const planned = input.budget && input.budget.planned;
  if (!Number.isInteger(planned) || planned < 1) {
    throw new ProtocolViolation('budget.planned must be a positive integer');
  }
  const maxTokens = (input.budget && input.budget.max_tokens) ?? 64;
  if (!Number.isInteger(maxTokens) || maxTokens < 1) {
    throw new ProtocolViolation('budget.max_tokens must be a positive integer');
  }
  const timeoutMs = input.timeout_ms ?? 30000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
    throw new ProtocolViolation('timeout_ms must be a positive integer');
  }
  const context = input.context && typeof input.context === 'object' ? input.context : {};
  // This harness is strictly sequential: an operator asking for concurrency
  // other than 1 cannot be honoured, and silently running at 1 would misreport.
  if (context.concurrency !== undefined && context.concurrency !== 1) {
    throw new ProtocolViolation('this harness only supports concurrency = 1');
  }
  let url;
  try {
    url = new URL(input.target.url);
  } catch {
    throw new ProtocolViolation('target.url is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProtocolViolation('target.url must be http or https');
  }
  const modelRequested =
    (typeof input.target.model === 'string' && input.target.model) ||
    (typeof context['model.requested'] === 'string' && context['model.requested']) ||
    null;
  return {
    planId: input.plan_id,
    url,
    apiKey: typeof input.target.api_key === 'string' ? input.target.api_key : null,
    extraHeaders:
      input.target.headers && typeof input.target.headers === 'object' ? input.target.headers : {},
    modelRequested,
    planned,
    maxTokens,
    timeoutMs,
    context,
  };
}

// ---------------------------------------------------------------- egress guard

function hostAllowed(url, allowedHosts) {
  if (allowedHosts === undefined || allowedHosts === null) return false;
  const entries = String(allowedHosts)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const hostname = url.hostname.toLowerCase();
  const hostWithPort = url.host.toLowerCase();
  const bare = hostname.replace(/^\[|\]$/g, '');
  return entries.some((e) => e === hostname || e === hostWithPort || e === bare);
}

function enforceEgress(url, env) {
  if (!hostAllowed(url, env.IWIK_ALLOWED_HOSTS)) {
    throw new ProtocolViolation('egress denied: target host is not in IWIK_ALLOWED_HOSTS');
  }
}

// ---------------------------------------------------------------- reachability

function defaultPort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function preflight(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: defaultPort(url) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Unreachable('target unreachable: connect timeout'));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Unreachable(`target unreachable: ${err.code || 'connect error'}`));
    });
  });
}

// ---------------------------------------------------------------- one attempt

function classifyStatus(status) {
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return 'http_other';
}

/**
 * One streaming chat completion. Resolves with an attempt record; never rejects
 * (every failure mode becomes a classified failed attempt).
 */
function attempt(cfg, index) {
  const body = JSON.stringify({
    model: cfg.modelRequested ?? undefined,
    messages: [
      { role: 'system', content: prompts.system },
      { role: 'user', content: prompts.prompts[index % prompts.prompts.length] },
    ],
    max_tokens: cfg.maxTokens,
    temperature: 0,
    stream: true,
    stream_options: { include_usage: true },
  });
  const headers = {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    accept: 'text/event-stream',
    'user-agent': `iwik-harness/${HARNESS_VERSION} (${PROTOCOL_REF})`,
    ...cfg.extraHeaders,
  };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const endpoint = new URL('/v1/chat/completions', cfg.url);
  const client = endpoint.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    let ttftMs = null;
    let httpStatus = null;
    let modelReported = null;
    let contentChunks = 0;
    let usage = null;
    let finished = false;
    let sawDone = false;
    let buffer = '';

    const finish = (status, errorClass, reason) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const totalMs = performance.now() - t0;
      resolve({
        attempt_index: index,
        status,
        reason,
        started_at: startedAt,
        ttft_ms: ttftMs === null ? null : round(ttftMs),
        total_ms: round(totalMs),
        http_status: httpStatus,
        error_class: errorClass,
        model_reported: modelReported,
        tokens: {
          completion_tokens: usage ? (usage.completion_tokens ?? null) : contentChunks,
          prompt_tokens: usage ? (usage.prompt_tokens ?? null) : null,
          origin: usage ? 'reported' : 'counted',
        },
      });
    };

    const req = client.request(
      endpoint,
      { method: 'POST', headers, timeout: cfg.timeoutMs },
      (res) => {
        httpStatus = res.statusCode;
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume();
          res.on('end', () =>
            finish('failed', classifyStatus(res.statusCode), `http ${res.statusCode}`),
          );
          res.on('error', () =>
            finish('failed', classifyStatus(res.statusCode), `http ${res.statusCode}`),
          );
          return;
        }
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let sep;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            for (const line of event.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const data = line.slice(5).trim();
              if (data === '[DONE]') {
                sawDone = true;
                continue;
              }
              let parsed;
              try {
                parsed = JSON.parse(data);
              } catch {
                req.destroy();
                finish('failed', 'malformed_response', 'unparseable SSE event');
                return;
              }
              if (modelReported === null && typeof parsed.model === 'string') {
                modelReported = parsed.model;
              }
              const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
              const content = choice && choice.delta ? choice.delta.content : undefined;
              if (typeof content === 'string' && content.length > 0) {
                contentChunks += 1;
                if (ttftMs === null) ttftMs = performance.now() - t0;
              }
              if (parsed.usage && typeof parsed.usage === 'object') usage = parsed.usage;
            }
          }
        });
        res.on('end', () => {
          if (ttftMs === null) return finish('failed', 'malformed_response', 'no content token');
          if (!sawDone)
            return finish('failed', 'malformed_response', 'stream ended without [DONE]');
          finish('succeeded', null, undefined);
        });
        res.on('aborted', () => finish('failed', 'connection', 'response aborted'));
        res.on('error', (err) => finish('failed', 'connection', err.code || 'response error'));
      },
    );
    const timer = setTimeout(() => {
      req.destroy(new Error('timeout'));
      finish('failed', 'timeout', `no completion within ${cfg.timeoutMs} ms`);
    }, cfg.timeoutMs);
    req.on('timeout', () => {
      req.destroy(new Error('timeout'));
      finish('failed', 'timeout', `socket idle for ${cfg.timeoutMs} ms`);
    });
    req.on('error', (err) => {
      if (err && err.message === 'timeout') return;
      finish('failed', 'connection', (err && err.code) || 'request error');
    });
    req.end(body);
  });
}

// ---------------------------------------------------------------- summary

function round(ms) {
  return Math.round(ms * 1000) / 1000;
}

/** Nearest-rank percentile over a sorted ascending array; null when empty. */
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

function distribution(values) {
  const sorted = values.filter((v) => typeof v === 'number').sort((a, b) => a - b);
  return {
    samples: sorted.length,
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function summarize(attempts, planned) {
  const succeeded = attempts.filter((a) => a.status === 'succeeded');
  const failed = attempts.filter((a) => a.status === 'failed');
  const errorClasses = {};
  for (const a of failed) errorClasses[a.error_class] = (errorClasses[a.error_class] || 0) + 1;
  return {
    planned,
    attempted: attempts.length,
    succeeded: succeeded.length,
    failed: failed.length,
    error_rate: attempts.length === 0 ? null : failed.length / attempts.length,
    error_classes: errorClasses,
    ttft_ms: distribution(succeeded.map((a) => a.ttft_ms)),
    total_ms: distribution(succeeded.map((a) => a.total_ms)),
  };
}

// ---------------------------------------------------------------- main

async function main(env) {
  const cfg = readInput(env);
  enforceEgress(cfg.url, env);
  fs.mkdirSync(env.IWIK_OUTPUT, { recursive: true });
  const attemptsPath = path.join(env.IWIK_OUTPUT, 'attempts.jsonl');
  const resultPath = path.join(env.IWIK_OUTPUT, 'result.json');
  const contextPath = path.join(env.IWIK_OUTPUT, 'context.json');

  await preflight(cfg.url, Math.min(cfg.timeoutMs, 5000));

  fs.writeFileSync(attemptsPath, '');
  const attempts = [];
  for (let i = 0; i < cfg.planned; i += 1) {
    const record = await attempt(cfg, i);
    attempts.push(record);
    const line = {
      attempt_index: record.attempt_index,
      status: record.status,
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
      timing: { started_at: record.started_at, ttft_ms: record.ttft_ms, total_ms: record.total_ms },
    };
    fs.appendFileSync(attemptsPath, JSON.stringify(line) + '\n');
  }

  const firstReported = attempts.find((a) => a.model_reported !== null);
  const modelReported = firstReported ? firstReported.model_reported : null;

  const result = {
    protocol_ref: PROTOCOL_REF,
    harness_version: HARNESS_VERSION,
    prompt_set: prompts.id,
    attempts: attempts.map((a) => ({
      attempt_index: a.attempt_index,
      status: a.status,
      ttft_ms: a.ttft_ms,
      total_ms: a.total_ms,
      http_status: a.http_status,
      error_class: a.error_class,
      tokens: a.tokens,
    })),
    summary: summarize(attempts, cfg.planned),
  };
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');

  const context = [
    modelReported === null
      ? { key: 'model.reported', value: null, origin: 'unknown' }
      : { key: 'model.reported', value: modelReported, origin: 'measured' },
    { key: 'concurrency', value: 1, origin: 'measured' },
    { key: 'retry_policy', value: 'none', origin: 'measured' },
    { key: 'max_tokens', value: cfg.maxTokens, unit: 'tokens', origin: 'measured' },
    { key: 'harness.version', value: HARNESS_VERSION, origin: 'measured' },
    { key: 'prompt_set', value: prompts.id, origin: 'measured' },
  ];
  if (cfg.modelRequested !== null) {
    context.push({
      key: 'model.requested',
      value: cfg.modelRequested,
      origin: 'operator_reported',
    });
  }
  fs.writeFileSync(contextPath, JSON.stringify(context, null, 2) + '\n');
  return EXIT_OK;
}

module.exports = { main, hostAllowed, percentile, distribution, summarize, HARNESS_VERSION };

if (require.main === module) {
  main(process.env)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof ProtocolViolation) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = EXIT_PROTOCOL_VIOLATED;
      } else if (err instanceof Unreachable) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = EXIT_UNREACHABLE;
      } else {
        process.stderr.write(`harness crashed: ${err && err.stack ? err.stack : err}\n`);
        process.exitCode = 1;
      }
    });
}
