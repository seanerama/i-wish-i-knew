// Protocol registry: every pack under packs/ loaded at boot with digests
// recomputed from the files (contracts/runner-pack.md, packs/README.md). A
// committed protocol.json whose digests are stale refuses to load: the
// registry never serves a ProtocolVersion the files do not back.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ProtocolVersion } from '@iwik/contracts';
import { computePackDigests, staleFields, validate } from '@iwik/contracts';
import { ApiError } from '../../errors.js';
import { requireScope } from '../identity/index.js';

export interface RegistryEntry {
  protocol: ProtocolVersion;
  pack: {
    id: string;
    version: string;
    pack_digest: string;
    /** Repository-relative pack directory; the download pointer until packs are served. */
    path: string;
  };
  contextSchema: Record<string, unknown>;
  resultSchema: Record<string, unknown>;
  claims: Record<string, unknown>;
}

export class RegistryError extends Error {
  override name = 'RegistryError';
}

export class Registry {
  private readonly byRef = new Map<string, RegistryEntry>();

  constructor(entries: RegistryEntry[]) {
    for (const entry of entries) this.byRef.set(entry.protocol.ref, entry);
  }

  list(): RegistryEntry[] {
    return [...this.byRef.values()].sort((a, b) => a.protocol.ref.localeCompare(b.protocol.ref));
  }

  get(ref: string): RegistryEntry | undefined {
    return this.byRef.get(ref);
  }

  get size(): number {
    return this.byRef.size;
  }
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
}

export function loadRegistry(packsDir: string): Registry {
  if (!existsSync(packsDir)) throw new RegistryError(`packs directory not found: ${packsDir}`);
  const entries: RegistryEntry[] = [];
  for (const dirent of readdirSync(packsDir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) continue;
    const packDir = join(packsDir, dirent.name);
    if (!existsSync(join(packDir, 'pack.json'))) continue;
    const digests = computePackDigests(packDir);
    for (const [entry, { current, expected }] of Object.entries(digests.protocols)) {
      const stale = staleFields(current, expected);
      if (stale.length > 0) {
        throw new RegistryError(
          `${digests.pack_id}/${entry}: protocol.json digests are stale (${stale.join(', ')}); ` +
            'run node scripts/pack-digest.js <pack-dir> --write',
        );
      }
      const result = validate('ProtocolVersion', current);
      if (!result.ok) {
        const issues = result.errors.map((e) => `${e.path}:${e.rule}`).join(', ');
        throw new RegistryError(`${digests.pack_id}/${entry}: protocol.json invalid (${issues})`);
      }
      const protocol = current as unknown as ProtocolVersion;
      const name = entry.split('@')[0] ?? entry;
      const protocolDir = join(packDir, 'protocols', name);
      entries.push({
        protocol,
        pack: {
          id: digests.pack_id,
          version: digests.pack_version,
          pack_digest: digests.pack_digest,
          path: `packs/${dirent.name}`,
        },
        contextSchema: readJson(join(protocolDir, 'context.schema.json')),
        resultSchema: readJson(join(protocolDir, 'result.schema.json')),
        claims: readJson(join(protocolDir, 'claims.json')),
      });
    }
  }
  return new Registry(entries);
}

export function protocolResponse(entry: RegistryEntry): Record<string, unknown> {
  return {
    ...entry.protocol,
    pack: {
      id: entry.pack.id,
      version: entry.pack.version,
      pack_digest: entry.pack.pack_digest,
      download: { kind: 'repository_path', path: entry.pack.path },
    },
  };
}

export function registerRegistryRoutes(app: FastifyInstance, registry: Registry): void {
  app.get('/v1/protocols', { preHandler: requireScope('query') }, async () => ({
    protocols: registry.list().map((e) => e.protocol),
  }));

  const one = (ref: string): Record<string, unknown> => {
    const entry = registry.get(ref);
    if (entry === undefined) throw new ApiError(404, 'not_found');
    return protocolResponse(entry);
  };

  // `inference-api/latency@1` contains a slash: accept both the two-segment
  // form and the percent-encoded single segment.
  app.get<{ Params: { pack: string; protocol: string } }>(
    '/v1/protocols/:pack/:protocol',
    { preHandler: requireScope('query') },
    async (request) => one(`${request.params.pack}/${request.params.protocol}`),
  );
  app.get<{ Params: { ref: string } }>(
    '/v1/protocols/:ref',
    { preHandler: requireScope('query') },
    async (request) => one(request.params.ref),
  );
}
