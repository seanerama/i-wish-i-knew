// Pack loading and digest verification (contracts/runner-pack.md). Every
// digest comes from the shared implementation in @iwik/contracts; the runner
// refuses to execute a pack whose harness digest is not listed in the
// manifest's `compatibility.harness_digests`, or whose protocol, schema, or
// pack digests differ from the manifest.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProtocolVersion } from '@iwik/contracts';
import { computePackDigests, validate } from '@iwik/contracts';
import type { PackDigests } from '@iwik/contracts';
import { RunnerError } from './errors.js';

const here = dirname(fileURLToPath(import.meta.url));
/** packages/runner, whether running from src/ (tsx) or dist/ (node). */
export const runnerRoot = resolve(here, '..');
/** The repository's packs/ directory: the development default for `packs_dir`. */
export const defaultPacksDir = resolve(runnerRoot, '..', '..', 'packs');

export interface ProtocolRefParts {
  pack: string;
  name: string;
  major: number;
  entry: string;
}

export function parseProtocolRef(ref: string): ProtocolRefParts {
  const match = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)@([1-9][0-9]*)$/.exec(ref);
  if (match === null) {
    throw new RunnerError('usage', 'protocol ref must look like <pack>/<protocol>@<major>');
  }
  const pack = match[1] as string;
  const name = match[2] as string;
  const major = Number(match[3]);
  return { pack, name, major, entry: `${name}@${major}` };
}

export interface LocalPack {
  ref: string;
  packDir: string;
  protocolDir: string;
  harnessEntry: string;
  /** protocol.json as committed in the pack. */
  protocol: ProtocolVersion;
  /** Digests recomputed from the files on disk. */
  digests: PackDigests;
  /** The local harness tree digest. */
  harness_digest: string;
  /** The local protocol digest (recomputed, with the local harness digest folded in). */
  protocol_digest: string;
  context_schema_digest: string;
  result_schema_digest: string;
  contextSchema: Record<string, unknown>;
  resultSchema: Record<string, unknown>;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function loadLocalPack(packsDir: string, ref: string): LocalPack {
  const parts = parseProtocolRef(ref);
  const packDir = join(packsDir, parts.pack);
  if (!existsSync(join(packDir, 'pack.json'))) {
    throw new RunnerError('pack_not_found', `pack ${parts.pack} not found under ${packsDir}`);
  }
  const protocolDir = join(packDir, 'protocols', parts.name);
  const protocolFile = join(protocolDir, 'protocol.json');
  const harnessEntry = join(packDir, 'harness', 'index.js');
  if (!existsSync(protocolFile) || !existsSync(harnessEntry)) {
    throw new RunnerError('pack_not_found', `protocol ${ref} not found in pack ${parts.pack}`);
  }
  let digests: PackDigests;
  try {
    digests = computePackDigests(packDir);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RunnerError('pack_invalid', `cannot digest pack ${parts.pack}: ${reason}`);
  }
  if (!digests.protocols[parts.entry]) {
    throw new RunnerError(
      'pack_invalid',
      `pack.json of ${parts.pack} does not list ${parts.entry}`,
    );
  }
  const computed = digests.protocols[parts.entry];
  const current = computed?.current ?? {};
  const expected = computed?.expected ?? {};
  const validation = validate('ProtocolVersion', current);
  if (!validation.ok) {
    throw new RunnerError('pack_invalid', `${ref}: protocol.json is not a ProtocolVersion`, [
      ...validation.errors,
    ]);
  }
  const protocol = current as unknown as ProtocolVersion;
  if (protocol.ref !== ref) {
    throw new RunnerError('pack_invalid', `${ref}: protocol.json carries a different ref`);
  }
  return {
    ref,
    packDir,
    protocolDir,
    harnessEntry,
    protocol,
    digests,
    harness_digest: digests.harness_digest,
    protocol_digest: String(expected['protocol_digest']),
    context_schema_digest: String(expected['context_schema_digest']),
    result_schema_digest: String(expected['result_schema_digest']),
    contextSchema: readJson(join(protocolDir, 'context.schema.json')),
    resultSchema: readJson(join(protocolDir, 'result.schema.json')),
  };
}

/** A ProtocolVersion as served by `GET /v1/protocols/{ref}` (with its pack pointer) or a saved copy. */
export interface Manifest extends ProtocolVersion {
  pack?: { id?: string; version?: string; pack_digest?: string };
}

export function parseManifest(value: unknown, source: string): Manifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RunnerError('manifest_invalid', `${source}: manifest is not an object`);
  }
  const record = value as Record<string, unknown>;
  const { pack, ...protocol } = record;
  const validation = validate('ProtocolVersion', protocol);
  if (!validation.ok) {
    throw new RunnerError('manifest_invalid', `${source}: manifest is not a ProtocolVersion`, [
      ...validation.errors,
    ]);
  }
  const manifest: Manifest = protocol as unknown as ProtocolVersion;
  if (typeof pack === 'object' && pack !== null) {
    manifest.pack = pack as NonNullable<Manifest['pack']>;
  }
  return manifest;
}

/**
 * Compare the local files with the manifest. Order matters for the error the
 * operator sees: a tampered harness reports `harness_digest_mismatch` even
 * though it also changes the protocol digest.
 */
export function verifyPack(local: LocalPack, manifest: Manifest): void {
  if (manifest.ref !== local.ref) {
    throw new RunnerError('manifest_invalid', `manifest is for ${manifest.ref}, not ${local.ref}`);
  }
  if (!manifest.compatibility.harness_digests.includes(local.harness_digest)) {
    throw new RunnerError(
      'harness_digest_mismatch',
      `harness digest ${local.harness_digest} is not listed in compatibility.harness_digests for ${local.ref}`,
    );
  }
  if (manifest.protocol_digest !== local.protocol_digest) {
    throw new RunnerError(
      'protocol_digest_mismatch',
      `protocol digest of the local pack differs from the manifest for ${local.ref}`,
    );
  }
  if (manifest.result_schema_digest !== local.result_schema_digest) {
    throw new RunnerError(
      'result_schema_digest_mismatch',
      `result.schema.json differs from the manifest for ${local.ref}`,
    );
  }
  if (manifest.context_schema_digest !== local.context_schema_digest) {
    throw new RunnerError(
      'context_schema_digest_mismatch',
      `context.schema.json differs from the manifest for ${local.ref}`,
    );
  }
  const packDigest = manifest.pack?.pack_digest;
  if (typeof packDigest === 'string' && packDigest !== local.digests.pack_digest) {
    throw new RunnerError(
      'pack_digest_mismatch',
      `pack digest of the local pack differs from the registry's for ${local.ref}`,
    );
  }
  if (manifest.status !== 'accepted') {
    throw new RunnerError(
      'protocol_not_accepted',
      `protocol ${local.ref} has status ${manifest.status}; only accepted protocols run`,
    );
  }
}
