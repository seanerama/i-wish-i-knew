'use strict';
// iwik egress guard (contracts/runner-pack.md, IWIK_ALLOWED_HOSTS).
//
// Preloaded into the harness process with `NODE_OPTIONS=--require <this file>`.
// Every outbound TCP connection goes through `net.Socket.prototype.connect`
// (http, https, tls, undici/fetch, and raw sockets all end up there), so that
// is the chokepoint: a connection to a host outside IWIK_ALLOWED_HOSTS is
// refused with an `IWIK_EGRESS_DENIED` error, recorded in IWIK_EGRESS_LOG,
// and reported on stderr. `fetch` is also patched to fail early, and
// `child_process` is disabled because a subprocess would not inherit the
// guard's patches.
//
// This is a BEST-EFFORT guard for Node harnesses in v1: it runs inside the
// harness process, which could in principle undo it (Node offers no
// tamper-proof in-process sandbox). A process-level sandbox is a later
// security stage. The guard fails closed: if it cannot install, the harness
// exits 2 (protocol violated) before running any harness code.
const fs = require('node:fs');
const net = require('node:net');
const childProcess = require('node:child_process');

function parseAllowed(raw) {
  if (raw === undefined || raw === null) return [];
  return String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const allowed = parseAllowed(process.env.IWIK_ALLOWED_HOSTS);
const logFile = process.env.IWIK_EGRESS_LOG;

function hostAllowed(hostname, port) {
  if (typeof hostname !== 'string' || hostname === '') return false;
  const bare = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const withPort = port === undefined || port === null ? null : `${bare}:${port}`;
  const bracketed = withPort === null ? null : `[${bare}]:${port}`;
  return allowed.some((e) => e === bare || e === withPort || e === bracketed);
}

function normalizePort(port) {
  if (port === undefined || port === null || port === '') return null;
  const n = Number(port);
  return Number.isFinite(n) ? n : null;
}

function record(api, host, port) {
  const entry = {
    at: new Date().toISOString(),
    api,
    host: String(host),
    port: normalizePort(port),
  };
  if (logFile) {
    try {
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch {
      // The log is advisory; the denial itself does not depend on it.
    }
  }
  try {
    process.stderr.write(`egress denied: ${entry.host}${port ? ':' + port : ''} (${api})\n`);
  } catch {
    // stderr may be closed; nothing else to do.
  }
}

function denial(api, host, port) {
  record(api, host, port);
  const err = new Error(
    `egress denied: ${host}${port ? ':' + port : ''} is not in IWIK_ALLOWED_HOSTS`,
  );
  err.code = 'IWIK_EGRESS_DENIED';
  return err;
}

/** Mirror of net's argument normalization: options object, (port, host), or a pipe path. */
function extractTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === 'object') {
    if (typeof first.path === 'string') return { path: first.path };
    return { host: first.host ?? 'localhost', port: first.port };
  }
  if (typeof first === 'string') {
    const asNumber = Number(first);
    if (!Number.isFinite(asNumber)) return { path: first };
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: asNumber };
  }
  if (typeof first === 'number') {
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: first };
  }
  return { host: 'localhost' };
}

function install() {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const target = extractTarget(args);
    if (target.path !== undefined) {
      const err = denial('net.connect', `unix:${target.path}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    if (!hostAllowed(target.host, target.port)) {
      const err = denial('net.connect', target.host, target.port);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return originalConnect.apply(this, args);
  };

  if (typeof globalThis.fetch === 'function') {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = function guardedFetch(input, init) {
      let url;
      try {
        url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      } catch {
        return originalFetch(input, init);
      }
      const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
      if (!hostAllowed(url.hostname, port)) {
        return Promise.reject(denial('fetch', url.hostname, port));
      }
      return originalFetch(input, init);
    };
  }

  const blocked = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];
  for (const name of blocked) {
    childProcess[name] = function blockedChildProcess() {
      throw denial(`child_process.${name}`, 'subprocess');
    };
  }
}

try {
  install();
} catch (err) {
  process.stderr.write(
    `egress guard failed to install: ${err && err.message ? err.message : err}\n`,
  );
  process.exit(2);
}
