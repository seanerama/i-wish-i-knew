// Runner test scaffolding: a temporary IWIK_HOME per test file, pack copies
// that can be tampered with (digests rewritten or deliberately left stale),
// and a stub target from the inference-api pack.
import { createRequire } from 'node:module';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computePackDigests } from '@iwik/contracts';
import { init, savePolicy } from '../src/index.js';
import type { Policy } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');
export const packsDir = join(repoRoot, 'packs');
export const packDir = join(packsDir, 'inference-api');
export const cliPath = join(repoRoot, 'packages', 'runner', 'bin', 'iwik.cjs');

export const NODE_ID = '01ARZ3NDEKTSV4RRFFQ69G5N0D';
export const TEST_TOKEN = 'test-only-node-token-' + 'b'.repeat(24);

const require = createRequire(import.meta.url);
interface StubHandle {
  url: string;
  port: number;
  host: string;
  stub: { stats: { errors: number; completions: number; requests: number } };
  close: () => Promise<void>;
}
const stubModule = require(join(packDir, 'fixtures', 'stub-server', 'index.js')) as {
  startStub: (options?: Record<string, unknown>) => Promise<StubHandle>;
};
export const startStub = stubModule.startStub;

const created: string[] = [];

export function tempDir(prefix = 'iwik-runner-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export function cleanupTemp(): void {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface TestHome {
  home: string;
  pubkey: string;
  tokenFile: string;
}

/** A fresh home: initialised with a token file and node id, execution still denied. */
export function makeHome(serviceUrl = 'http://127.0.0.1:1'): TestHome {
  const base = tempDir();
  const tokenFile = join(base, 'token.txt');
  writeFileSync(tokenFile, TEST_TOKEN + '\n', { mode: 0o600 });
  const home = join(base, 'home');
  const result = init({ home, serviceUrl, tokenFile, nodeId: NODE_ID });
  return { home, pubkey: result.pubkey, tokenFile };
}

export function allow(home: string, ...targets: string[]): void {
  const policy: Policy = {
    allow_execution: true,
    allowed_targets: targets,
    budget_per_plan_usd: 0,
    allow_disruptive: false,
  };
  savePolicy(home, policy);
}

/** Copy the inference-api pack into a temp packs dir; returns that packs dir. */
export function copyPack(): { packsDir: string; packDir: string } {
  const dir = tempDir('iwik-packs-');
  const dst = join(dir, 'inference-api');
  cpSync(packDir, dst, {
    recursive: true,
    filter: (src) => !src.includes(`${join(packDir, 'test')}`),
  });
  return { packsDir: dir, packDir: dst };
}

/** Rewrite every protocol.json digest field of a (modified) pack copy so it is self-consistent. */
export function rewriteDigests(dir: string): void {
  const digests = computePackDigests(dir);
  for (const { file, expected } of Object.values(digests.protocols)) {
    writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
  }
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export const OPERATOR_CONTEXT = {
  'model.requested': 'stub-model',
  concurrency: 1,
  cache_disabled: true,
  client_region: 'local',
};
