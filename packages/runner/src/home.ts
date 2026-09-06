// The runner home (`IWIK_HOME`, default `~/.iwik`): config.json (service URL,
// node id, packs dir), token (0600), key.ed25519 (0600), policy.json, vault/,
// plans/. Directories are created 0700 and files 0600; nothing here is ever
// written with a wider mode.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ApiClient } from './client.js';
import { RunnerError } from './errors.js';
import { generateKey, loadKey } from './keys.js';
import { ULID_PATTERN } from './ulid.js';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

export interface RunnerConfig {
  service_url: string;
  /** The node id the service knows this runner by; required for `run`. */
  node_id?: string;
  /** Directory holding domain packs; defaults to the repository's packs/ in development. */
  packs_dir?: string;
}

export interface HomePaths {
  home: string;
  config: string;
  token: string;
  key: string;
  policy: string;
  vault: string;
  plans: string;
}

export function resolveHome(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  const chosen = explicit ?? env['IWIK_HOME'];
  if (chosen !== undefined && chosen !== '') return resolve(chosen);
  return join(homedir(), '.iwik');
}

export function homePaths(home: string): HomePaths {
  return {
    home,
    config: join(home, 'config.json'),
    token: join(home, 'token'),
    key: join(home, 'key.ed25519'),
    policy: join(home, 'policy.json'),
    vault: join(home, 'vault'),
    plans: join(home, 'plans'),
  };
}

/** mkdir -p with mode 0700, then chmod in case the directory pre-existed or umask interfered. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
}

/** Write a file with mode 0600 (chmod afterwards so an existing file is tightened too). */
export function writePrivateFile(file: string, data: string | Buffer): void {
  writeFileSync(file, data, { mode: FILE_MODE });
  chmodSync(file, FILE_MODE);
}

export function writePrivateJson(file: string, value: unknown): void {
  writePrivateFile(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJsonFile<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadConfig(home: string): RunnerConfig {
  const paths = homePaths(home);
  if (!existsSync(paths.config)) {
    throw new RunnerError('not_initialized', `no config at ${paths.config}; run "iwik init" first`);
  }
  let parsed: unknown;
  try {
    parsed = readJsonFile<unknown>(paths.config);
  } catch {
    throw new RunnerError('config_invalid', `${paths.config} is not valid JSON`);
  }
  if (!isObject(parsed) || typeof parsed['service_url'] !== 'string') {
    throw new RunnerError('config_invalid', `${paths.config} must carry a service_url string`);
  }
  const config: RunnerConfig = { service_url: parsed['service_url'] };
  if (typeof parsed['node_id'] === 'string') config.node_id = parsed['node_id'];
  if (typeof parsed['packs_dir'] === 'string') config.packs_dir = parsed['packs_dir'];
  return config;
}

export function saveConfig(home: string, config: RunnerConfig): void {
  writePrivateJson(homePaths(home).config, config);
}

/** The node token, trimmed. Never log or print the returned value. */
export function loadToken(home: string): string {
  const file = homePaths(home).token;
  if (!existsSync(file)) {
    throw new RunnerError(
      'not_initialized',
      `no node token at ${file}; run "iwik init --token-file <path>"`,
    );
  }
  const token = readFileSync(file, 'utf8').trim();
  if (token === '') throw new RunnerError('not_initialized', `node token file ${file} is empty`);
  return token;
}

export interface InitOptions {
  home?: string;
  serviceUrl: string;
  /** File whose trimmed contents become the node token (copied to `<home>/token`, 0600). */
  tokenFile?: string;
  /** The node id issued with the token (ULID). */
  nodeId?: string;
  packsDir?: string;
}

export interface InitResult {
  home: string;
  /** base64 of the raw 32-byte Ed25519 public key: the enrollment form. */
  pubkey: string;
  key_id: string;
  key_created: boolean;
  token_stored: boolean;
  node_id: string | undefined;
  service_url: string;
}

/**
 * Create or update the home. Idempotent: an existing signing key is kept, an
 * existing policy is kept, config fields are merged. Prints nothing; the CLI
 * decides what to show (never the private key or the token).
 */
export function init(options: InitOptions): InitResult {
  const home = resolveHome(options.home);
  const paths = homePaths(home);
  let serviceUrl: string;
  try {
    const url = new URL(options.serviceUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
    serviceUrl = url.toString().replace(/\/+$/, '');
  } catch {
    throw new RunnerError('usage', 'service URL must be an http(s) URL');
  }
  if (options.nodeId !== undefined && !ULID_PATTERN.test(options.nodeId)) {
    throw new RunnerError('usage', 'node id must be a ULID');
  }
  ensurePrivateDir(home);
  ensurePrivateDir(paths.vault);
  ensurePrivateDir(paths.plans);

  const existing = existsSync(paths.config) ? loadConfig(home) : undefined;
  const config: RunnerConfig = { ...(existing ?? {}), service_url: serviceUrl };
  if (options.nodeId !== undefined) config.node_id = options.nodeId;
  if (options.packsDir !== undefined) {
    config.packs_dir = isAbsolute(options.packsDir) ? options.packsDir : resolve(options.packsDir);
  }
  saveConfig(home, config);

  let tokenStored = false;
  if (options.tokenFile !== undefined) {
    let token: string;
    try {
      token = readFileSync(options.tokenFile, 'utf8').trim();
    } catch {
      throw new RunnerError('usage', 'token file is not readable');
    }
    if (token === '') throw new RunnerError('usage', 'token file is empty');
    writePrivateFile(paths.token, token + '\n');
    tokenStored = true;
  }

  let keyCreated = false;
  if (!existsSync(paths.key)) {
    writePrivateFile(paths.key, generateKey());
    keyCreated = true;
  } else {
    chmodSync(paths.key, FILE_MODE);
  }
  const key = loadKey(paths.key);

  if (!existsSync(paths.policy)) {
    writePrivateJson(paths.policy, DEFAULT_POLICY_JSON);
  }

  return {
    home,
    pubkey: key.pubkey,
    key_id: key.key_id,
    key_created: keyCreated,
    token_stored: tokenStored,
    node_id: config.node_id,
    service_url: serviceUrl,
  };
}

/** The default policy document as written by `iwik init` (see policy.ts). */
export const DEFAULT_POLICY_JSON = {
  allow_execution: false,
  allowed_targets: [] as string[],
  budget_per_plan_usd: 0,
  allow_disruptive: false,
};

export interface WhoAmI {
  node_id: string;
  org_display_name: string;
  scopes: string[];
}

/**
 * `GET /v1/whoami` (contracts/member-api.md, node identity endpoint): learn
 * the node id the service knows this token by and store it in config.json,
 * so `iwik init` needs no `--node-id` when a token is available. Throws a
 * RunnerError (api_error / not_initialized) when the service cannot answer;
 * the CLI reports that and keeps the home usable offline.
 */
export async function discoverNode(
  home: string,
  fetchImpl?: typeof fetch,
): Promise<WhoAmI & { updated: boolean }> {
  const config = loadConfig(home);
  const token = loadToken(home);
  const client = new ApiClient(config.service_url, token, fetchImpl);
  const res = await client.get<Partial<WhoAmI>>('/v1/whoami');
  const body = res.body ?? {};
  if (typeof body.node_id !== 'string' || !ULID_PATTERN.test(body.node_id)) {
    throw new RunnerError('api_error', 'whoami response lacks a node_id');
  }
  const scopes = Array.isArray(body.scopes)
    ? body.scopes.filter((s): s is string => typeof s === 'string')
    : [];
  const updated = config.node_id !== body.node_id;
  if (updated) saveConfig(home, { ...config, node_id: body.node_id });
  return {
    node_id: body.node_id,
    org_display_name: typeof body.org_display_name === 'string' ? body.org_display_name : '',
    scopes,
    updated,
  };
}
