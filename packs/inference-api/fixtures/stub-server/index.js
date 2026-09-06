#!/usr/bin/env node
'use strict';
// Stub OpenAI-compatible chat endpoint (ADR-0003 "Fixture server").
//
// Emulates `POST /v1/chat/completions` (streaming and non-streaming) with a
// configurable first-token delay, an injected error rate drawn from a seeded
// RNG, and a configurable reported model name. Records every request and
// exposes `GET /__stub/stats` for tests. Node built-ins only.
//
// Configuration (CLI flag wins over env var):
//   --port N          STUB_PORT         listen port (default 0 = ephemeral)
//   --host H          STUB_HOST         bind address (default 127.0.0.1)
//   --delay-ms N      STUB_DELAY_MS     delay before the first token (default 20)
//   --token-delay-ms  STUB_TOKEN_DELAY_MS delay between streamed tokens (default 1)
//   --error-rate F    STUB_ERROR_RATE   probability in [0,1] of an injected HTTP 500 (default 0)
//   --model-name S    STUB_MODEL_NAME   model reported in responses (default stub-model)
//   --seed N          STUB_SEED         RNG seed (default 1)
//   --tokens N        STUB_TOKENS       completion tokens per response (default 8)
//
// When run directly it prints one JSON line `{"port":N,"host":H}` to stdout
// once listening. Programmatic use: `const { startStub } = require(...)`.
const http = require('node:http');

/** Deterministic PRNG (mulberry32); good enough for reproducible error injection. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text === '') return resolve(null);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createStub(options = {}) {
  const config = {
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 0,
    delayMs: options.delayMs ?? 20,
    tokenDelayMs: options.tokenDelayMs ?? 1,
    errorRate: options.errorRate ?? 0,
    modelName: options.modelName ?? 'stub-model',
    seed: options.seed ?? 1,
    tokens: options.tokens ?? 8,
  };
  const rng = mulberry32(config.seed);
  const stats = {
    requests: 0,
    completions: 0,
    succeeded: 0,
    errors: 0,
    bad_requests: 0,
    by_path: {},
    log: [],
  };

  async function handleCompletion(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      stats.bad_requests += 1;
      return sendJson(res, 400, {
        error: { message: 'invalid JSON', type: 'invalid_request_error' },
      });
    }
    if (!body || !Array.isArray(body.messages)) {
      stats.bad_requests += 1;
      return sendJson(res, 400, {
        error: { message: 'messages[] is required', type: 'invalid_request_error' },
      });
    }
    stats.completions += 1;
    if (rng() < config.errorRate) {
      stats.errors += 1;
      return sendJson(res, 500, {
        error: { message: 'injected failure', type: 'server_error', code: 'stub_injected' },
      });
    }
    stats.succeeded += 1;
    const id = `chatcmpl-stub-${stats.completions}`;
    const created = Math.floor(Date.now() / 1000);
    const nTokens = Math.max(1, Math.min(config.tokens, body.max_tokens ?? config.tokens));
    const words = [];
    for (let i = 0; i < nTokens; i += 1) words.push(i === 0 ? 'stub' : ` token${i}`);
    const promptTokens = body.messages.reduce(
      (n, m) =>
        n +
        String(m.content ?? '')
          .split(/\s+/)
          .filter(Boolean).length,
      0,
    );
    const usage = {
      prompt_tokens: promptTokens,
      completion_tokens: nTokens,
      total_tokens: promptTokens + nTokens,
    };

    await sleep(config.delayMs);
    if (res.destroyed || res.writableEnded) return;

    if (body.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const chunk = (delta, finish) =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: config.modelName,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      res.write(chunk({ role: 'assistant', content: words[0] }, null));
      for (let i = 1; i < words.length; i += 1) {
        if (config.tokenDelayMs > 0) await sleep(config.tokenDelayMs);
        if (res.destroyed) return;
        res.write(chunk({ content: words[i] }, null));
      }
      res.write(chunk({}, 'stop'));
      if (body.stream_options && body.stream_options.include_usage === true) {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: config.modelName,
            choices: [],
            usage,
          })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
      return;
    }

    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: config.modelName,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: words.join('') },
          finish_reason: 'stop',
        },
      ],
      usage,
    });
  }

  const server = http.createServer((req, res) => {
    stats.requests += 1;
    const path = (req.url || '/').split('?')[0];
    stats.by_path[path] = (stats.by_path[path] || 0) + 1;
    stats.log.push({ method: req.method, path, at: new Date().toISOString() });

    if (req.method === 'GET' && path === '/__stub/stats') {
      return sendJson(res, 200, { ...stats, config });
    }
    if (req.method === 'POST' && path === '/__stub/reset') {
      stats.requests = 0;
      stats.completions = 0;
      stats.succeeded = 0;
      stats.errors = 0;
      stats.bad_requests = 0;
      stats.by_path = {};
      stats.log = [];
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && path === '/v1/models') {
      return sendJson(res, 200, {
        object: 'list',
        data: [{ id: config.modelName, object: 'model', owned_by: 'stub' }],
      });
    }
    if (req.method === 'POST' && path === '/v1/chat/completions') {
      handleCompletion(req, res).catch(() => {
        if (!res.headersSent) sendJson(res, 500, { error: { message: 'stub crashed' } });
        else res.destroy();
      });
      return;
    }
    sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error' } });
  });

  return {
    server,
    config,
    stats,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          const address = server.address();
          resolve({
            host: config.host,
            port: address.port,
            url: `http://${config.host}:${address.port}`,
          });
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

/** Start a stub and resolve with `{ stub, url, port, host, close }`. */
async function startStub(options = {}) {
  const stub = createStub(options);
  const bound = await stub.listen();
  return { stub, ...bound, close: () => stub.close() };
}

function parseArgs(argv, env) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    const key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    flags[key] = value;
  }
  const pick = (flag, envName, parse, fallback) => {
    const raw = flags[flag] ?? env[envName];
    return raw === undefined ? fallback : parse(raw);
  };
  return {
    host: pick('host', 'STUB_HOST', String, '127.0.0.1'),
    port: pick('port', 'STUB_PORT', Number, 0),
    delayMs: pick('delay-ms', 'STUB_DELAY_MS', Number, 20),
    tokenDelayMs: pick('token-delay-ms', 'STUB_TOKEN_DELAY_MS', Number, 1),
    errorRate: pick('error-rate', 'STUB_ERROR_RATE', Number, 0),
    modelName: pick('model-name', 'STUB_MODEL_NAME', String, 'stub-model'),
    seed: pick('seed', 'STUB_SEED', Number, 1),
    tokens: pick('tokens', 'STUB_TOKENS', Number, 8),
  };
}

module.exports = { createStub, startStub, parseArgs, mulberry32 };

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2), process.env);
  startStub(options)
    .then(({ host, port, close }) => {
      process.stdout.write(JSON.stringify({ host, port }) + '\n');
      const stop = () => close().then(() => process.exit(0));
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    })
    .catch((err) => {
      process.stderr.write(`stub-server: ${err.message}\n`);
      process.exit(1);
    });
}
