// Pack, harness, and protocol digests (contracts/runner-pack.md; encoding in
// packs/README.md). This is the shared TypeScript implementation used by the
// service registry; `scripts/pack-digest.js` is the dependency-free CommonJS
// mirror the packs and the runner use, and `test/digest.test.ts` proves the
// two produce byte-identical output.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalize } from './canonical.js';

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Sorted `[relative path, sha256 hex]` pairs for every regular file under `dir`. */
export function listFiles(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(dir, full).split(sep).join('/');
        out.push([rel, sha256Hex(readFileSync(full))]);
      }
    }
  };
  walk(dir);
  out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return out;
}

/** `sha256:<hex>` over the sorted `<path>\t<sha256>\n` lines. */
export function treeDigest(dir: string): string {
  const lines = listFiles(dir).map(([rel, hex]) => `${rel}\t${hex}\n`);
  return 'sha256:' + sha256Hex(lines.join(''));
}

/** `sha256:<hex>` over the raw bytes of one file. */
export function fileDigest(file: string): string {
  return 'sha256:' + sha256Hex(readFileSync(file));
}

/**
 * Digest of a protocol.json document: SHA-256 over the JCS form of the
 * document with its own `protocol_digest` member removed.
 */
export function protocolDigest(protocol: Record<string, unknown>): string {
  const copy: Record<string, unknown> = { ...protocol };
  delete copy['protocol_digest'];
  return 'sha256:' + sha256Hex(Buffer.from(canonicalize(copy), 'utf8'));
}

export interface PackManifest {
  id: string;
  version: string;
  protocols: string[];
}

export interface PackProtocolDigests {
  /** Absolute path of protocol.json. */
  file: string;
  /** The document as committed on disk. */
  current: Record<string, unknown>;
  /** The document with every digest field recomputed from the files. */
  expected: Record<string, unknown>;
}

export interface PackDigests {
  pack_id: string;
  pack_version: string;
  pack_digest: string;
  harness_digest: string;
  /** Keyed by `<name>@<major>` as listed in pack.json. */
  protocols: Record<string, PackProtocolDigests>;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** Every digest for one pack directory, computed from the files on disk. */
export function computePackDigests(packDir: string): PackDigests {
  const pack = readJson(join(packDir, 'pack.json')) as unknown as PackManifest;
  const harnessDigest = treeDigest(join(packDir, 'harness'));
  const protocols: Record<string, PackProtocolDigests> = {};
  for (const entry of pack.protocols) {
    const name = entry.split('@')[0] ?? entry;
    const dir = join(packDir, 'protocols', name);
    const file = join(dir, 'protocol.json');
    const current = readJson(file);
    const compatibility =
      typeof current['compatibility'] === 'object' && current['compatibility'] !== null
        ? (current['compatibility'] as Record<string, unknown>)
        : {};
    const expected: Record<string, unknown> = {
      ...current,
      harness_digest: harnessDigest,
      context_schema_digest: fileDigest(join(dir, 'context.schema.json')),
      result_schema_digest: fileDigest(join(dir, 'result.schema.json')),
      compatibility: { ...compatibility, harness_digests: [harnessDigest] },
    };
    expected['protocol_digest'] = protocolDigest(expected);
    protocols[entry] = { file, current, expected };
  }
  return {
    pack_id: pack.id,
    pack_version: pack.version,
    pack_digest: treeDigest(packDir),
    harness_digest: harnessDigest,
    protocols,
  };
}

/** Names of the digest fields in `current` that differ from `expected`. */
export function staleFields(
  current: Record<string, unknown>,
  expected: Record<string, unknown>,
): string[] {
  const fields = [
    'protocol_digest',
    'harness_digest',
    'context_schema_digest',
    'result_schema_digest',
  ];
  const stale = fields.filter((f) => current[f] !== expected[f]);
  const currentCompat = current['compatibility'] as { harness_digests?: unknown } | undefined;
  const expectedCompat = expected['compatibility'] as { harness_digests?: unknown };
  if (
    JSON.stringify(currentCompat?.harness_digests ?? []) !==
    JSON.stringify(expectedCompat.harness_digests)
  ) {
    stale.push('compatibility.harness_digests');
  }
  return stale;
}
