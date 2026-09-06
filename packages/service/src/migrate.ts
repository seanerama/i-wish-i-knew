// Migrations: `node-pg-migrate` over the SQL files in ../migrations.
//
//   node packages/service/dist/migrate.js     apply pending migrations (up)
//
// Also used by `/readyz` to answer "are migrations current?".
import { readdirSync } from 'node:fs';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runner } from 'node-pg-migrate';
import { ConfigError, serviceRoot } from './config.js';
import type { Queryable } from './db.js';

export const MIGRATIONS_TABLE = 'pgmigrations';
export const defaultMigrationsDir = resolve(serviceRoot, 'migrations');

/** Migration names (file basenames without extension) in run order. */
export function migrationNames(dir: string = defaultMigrationsDir): string[] {
  return readdirSync(dir)
    .filter((f) => ['.sql', '.js', '.cjs', '.mjs'].includes(extname(f)))
    .map((f) => basename(f, extname(f)))
    .sort();
}

export interface MigrateOptions {
  dir?: string;
  log?: (message: string) => void;
}

/** Apply every pending migration. Safe to call repeatedly. */
export async function migrateUp(
  databaseUrl: string,
  options: MigrateOptions = {},
): Promise<string[]> {
  const applied = await runner({
    databaseUrl,
    dir: options.dir ?? defaultMigrationsDir,
    direction: 'up',
    migrationsTable: MIGRATIONS_TABLE,
    checkOrder: true,
    log: options.log ?? (() => {}),
  });
  return applied.map((m) => m.name);
}

/** True when every migration file has a row in the migrations table. */
export async function migrationsCurrent(
  db: Queryable,
  dir: string = defaultMigrationsDir,
): Promise<boolean> {
  const exists = await db.query<{ ok: boolean }>(`SELECT to_regclass($1) IS NOT NULL AS ok`, [
    `public.${MIGRATIONS_TABLE}`,
  ]);
  if (!exists.rows[0]?.ok) return false;
  const rows = await db.query<{ name: string }>(`SELECT name FROM ${MIGRATIONS_TABLE}`);
  const applied = new Set(rows.rows.map((r) => r.name));
  return migrationNames(dir).every((name) => applied.has(name));
}

async function main(): Promise<void> {
  // Only DATABASE_URL is needed here; the KEK and seeds belong to the server.
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) throw new ConfigError('DATABASE_URL is required');
  const applied = await migrateUp(databaseUrl, {
    dir: defaultMigrationsDir,
    log: (m) => process.stdout.write(m + '\n'),
  });
  const summary = applied.length === 0 ? '(none pending)' : applied.join(', ');
  process.stdout.write(`migrations applied: ${summary}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`migrate failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
