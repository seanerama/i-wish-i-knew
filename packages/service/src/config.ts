// Configuration from environment only (stage 2 spec). Nothing here reads a
// file; secrets arrive as env vars and are never logged.
import { createHash, hkdfSync } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SeedIdentity {
  /** Organization name; the org row is created on first boot and found by name after. */
  org: string;
  /** Plaintext node token; stored as its SHA-256 only. */
  nodeToken: string;
  /** Ed25519 public key: base64 of the raw 32 bytes, or a PEM SPKI block. */
  nodePubkey: string;
  /** Optional fixed node id (ULID); generated once when absent. */
  nodeId: string | undefined;
}

export interface Config {
  nodeEnv: string;
  production: boolean;
  port: number;
  host: string;
  databaseUrl: string;
  /** 32-byte key-encryption key. */
  kek: Buffer;
  /** `raw` = 32 bytes given as hex/base64; `derived` = HKDF of a passphrase (non-production only). */
  kekSource: 'raw' | 'derived';
  featureIntake: boolean;
  seed: SeedIdentity | undefined;
  packsDir: string;
  migrationsDir: string;
  logLevel: string;
  /** Extra secret patterns from `IWIK_SECRET_PATTERNS` (JSON array of regex sources). */
  extraSecretPatterns: string[];
  maxStringLength: number;
  previewTtlMs: number;
  /** Secret for the console session cookie signature (derived from the KEK). */
  cookieSecret: string;
  /**
   * `IWIK_TRUST_PROXY`: number of reverse-proxy hops whose X-Forwarded-* headers
   * are trusted (Fastify `trustProxy`). 0 = none (staging, direct on the
   * tailnet); 1 = behind one proxy (production behind Coolify's traefik,
   * ADR-0004) so `request.ip` is the real client for the login rate limit.
   */
  trustProxy: number;
  /** Stage 6: enrollment console, operator bootstrap. Default OFF everywhere. */
  featureEnrollment: boolean;
  /**
   * SHA-256 of `IWIK_OPERATOR_TOKEN`; the presented token is hashed and
   * compared in constant time. Undefined when no operator token is configured,
   * in which case the admin endpoint answers 401 to everyone.
   */
  operatorTokenHash: Buffer | undefined;
  /** Public origin used to build invite URLs (`IWIK_PUBLIC_URL`); path-only when unset. */
  publicUrl: string | undefined;
  /** 32-byte HMAC key for console session cookies, derived from the KEK (HKDF). */
  sessionKey: Buffer;
  /** Invite lifetime in milliseconds (`IWIK_INVITE_TTL_MS`, default 7 days). */
  inviteTtlMs: number;
  /**
   * Stage 7: `POST /v1/withdrawals`, the console withdraw form, and the MCP
   * `withdraw_contribution` tool. Default OFF everywhere (kill switch).
   */
  featureWithdrawal: boolean;
  /**
   * Stage 8: intake dedupe (duplicate receipts, shared-source flags) and the
   * operator cohort endpoint. Default OFF everywhere. The plaintext index
   * projection and the contributions ledger are written regardless, so
   * turning the flag on later needs no backfill.
   */
  featureDedupe: boolean;
  /** Worker poll interval in milliseconds (`IWIK_WORKER_INTERVAL_MS`, default 5 s). */
  workerIntervalMs: number;
  /**
   * Stage 9: the real `POST /v1/evidence/query` (matching, thresholds,
   * differencing defence, versioned calculation). Default OFF everywhere:
   * off, the stage 5 stub answer (`insufficient_evidence` /
   * `no_cooperative_evidence`) continues unchanged.
   */
  featureCooperativeQuery: boolean;
  /**
   * The most candidate runs one query decrypts (`IWIK_QUERY_COHORT_CAP`,
   * default 500). A larger cohort is answered `suppressed` with reason
   * `cohort_too_large` before any body is opened.
   */
  queryCohortCap: number;
}

const here = dirname(fileURLToPath(import.meta.url));
/** packages/service, whether running from src/ (tsx) or dist/ (node). */
export const serviceRoot = resolve(here, '..');
/** Repository root: packs/ and contracts/ live here in the checkout and in the image. */
export const repoRoot = resolve(serviceRoot, '..', '..');

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback;
  const v = value.trim().toLowerCase();
  if (['on', 'true', '1', 'yes', 'enabled'].includes(v)) return true;
  if (['off', 'false', '0', 'no', 'disabled'].includes(v)) return false;
  throw new ConfigError(`unrecognized boolean flag value (expected on/off)`);
}

/**
 * Parse `IWIK_KEK`. Accepts exactly 32 bytes as 64 hex characters or as
 * standard base64. Any other value is a passphrase: in production that is a
 * configuration error; elsewhere a 32-byte key is derived with HKDF-SHA256 so
 * CI and local development work with a plainly-labelled non-secret value.
 */
export function parseKek(
  raw: string | undefined,
  production: boolean,
): { kek: Buffer; source: 'raw' | 'derived' } {
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError('IWIK_KEK is required (32 bytes as hex or base64)');
  }
  const text = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    return { kek: Buffer.from(text, 'hex'), source: 'raw' };
  }
  if (/^[A-Za-z0-9+/]{43}=?$/.test(text)) {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === 32) return { kek: decoded, source: 'raw' };
  }
  if (production) {
    throw new ConfigError(
      'IWIK_KEK must be exactly 32 bytes (64 hex chars or base64) in production',
    );
  }
  const derived = Buffer.from(
    hkdfSync('sha256', Buffer.from(text, 'utf8'), Buffer.from('iwik-kek-salt'), 'iwik-kek-v1', 32),
  );
  return { kek: derived, source: 'derived' };
}

function parseSecretPatterns(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(
      'IWIK_SECRET_PATTERNS must be a JSON array of regular-expression sources',
    );
  }
  if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) {
    throw new ConfigError(
      'IWIK_SECRET_PATTERNS must be a JSON array of regular-expression sources',
    );
  }
  for (const source of parsed as string[]) {
    try {
      new RegExp(source);
    } catch {
      throw new ConfigError('IWIK_SECRET_PATTERNS contains an invalid regular expression');
    }
  }
  return parsed as string[];
}

function parseSeed(env: NodeJS.ProcessEnv): SeedIdentity | undefined {
  const org = env['IWIK_SEED_ORG'];
  const nodeToken = env['IWIK_SEED_NODE_TOKEN'];
  const nodePubkey = env['IWIK_SEED_NODE_PUBKEY'];
  if (!org && !nodeToken && !nodePubkey) return undefined;
  if (!org || !nodeToken || !nodePubkey) {
    throw new ConfigError(
      'IWIK_SEED_ORG, IWIK_SEED_NODE_TOKEN and IWIK_SEED_NODE_PUBKEY must be set together',
    );
  }
  if (nodeToken.length < 16) {
    throw new ConfigError('IWIK_SEED_NODE_TOKEN must be at least 16 characters');
  }
  const nodeId = env['IWIK_SEED_NODE_ID'];
  if (nodeId !== undefined && nodeId !== '' && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(nodeId)) {
    throw new ConfigError('IWIK_SEED_NODE_ID must be a ULID');
  }
  return { org, nodeToken, nodePubkey, nodeId: nodeId === '' ? undefined : nodeId };
}

function parseOperatorToken(raw: string | undefined): Buffer | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (raw.length < 16) throw new ConfigError('IWIK_OPERATOR_TOKEN must be at least 16 characters');
  return createHash('sha256').update(raw, 'utf8').digest();
}

function parsePublicUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const text = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+$/.test(text)) {
    throw new ConfigError('IWIK_PUBLIC_URL must be an http(s) origin without a path');
  }
  return text;
}

function positiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive integer`);
  return n;
}

function nonNegativeInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new ConfigError(`${name} must be an integer >= 0`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const nodeEnv = env['NODE_ENV'] ?? 'development';
  const production = nodeEnv === 'production';
  const databaseUrl = env['DATABASE_URL'];
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');
  const { kek, source } = parseKek(env['IWIK_KEK'], production);
  return {
    nodeEnv,
    production,
    port: positiveInt(env['PORT'], 3000, 'PORT'),
    host: env['HOST'] ?? '0.0.0.0',
    databaseUrl,
    kek,
    kekSource: source,
    featureIntake: flag(env['IWIK_FEATURE_INTAKE'], !production),
    seed: parseSeed(env),
    packsDir: env['IWIK_PACKS_DIR'] ?? resolve(repoRoot, 'packs'),
    migrationsDir: resolve(serviceRoot, 'migrations'),
    logLevel: env['IWIK_LOG_LEVEL'] ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    extraSecretPatterns: parseSecretPatterns(env['IWIK_SECRET_PATTERNS']),
    maxStringLength: positiveInt(env['IWIK_MAX_STRING_LENGTH'], 1024, 'IWIK_MAX_STRING_LENGTH'),
    previewTtlMs: positiveInt(env['IWIK_PREVIEW_TTL_MS'], 60 * 60 * 1000, 'IWIK_PREVIEW_TTL_MS'),
    trustProxy: nonNegativeInt(env['IWIK_TRUST_PROXY'], 0, 'IWIK_TRUST_PROXY'),
    cookieSecret: createHash('sha256')
      .update(Buffer.concat([Buffer.from('iwik-cookie'), kek]))
      .digest('hex'),
    featureEnrollment: flag(env['IWIK_FEATURE_ENROLLMENT'], false),
    operatorTokenHash: parseOperatorToken(env['IWIK_OPERATOR_TOKEN']),
    publicUrl: parsePublicUrl(env['IWIK_PUBLIC_URL']),
    sessionKey: Buffer.from(
      hkdfSync('sha256', kek, Buffer.from('iwik-session-salt'), 'iwik-session-v1', 32),
    ),
    inviteTtlMs: positiveInt(
      env['IWIK_INVITE_TTL_MS'],
      7 * 24 * 60 * 60 * 1000,
      'IWIK_INVITE_TTL_MS',
    ),
    featureWithdrawal: flag(env['IWIK_FEATURE_WITHDRAWAL'], false),
    featureDedupe: flag(env['IWIK_FEATURE_DEDUPE'], false),
    workerIntervalMs: positiveInt(env['IWIK_WORKER_INTERVAL_MS'], 5000, 'IWIK_WORKER_INTERVAL_MS'),
    featureCooperativeQuery: flag(env['IWIK_FEATURE_COOPERATIVE_QUERY'], false),
    queryCohortCap: positiveInt(env['IWIK_QUERY_COHORT_CAP'], 500, 'IWIK_QUERY_COHORT_CAP'),
  };
}
