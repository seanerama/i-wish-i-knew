// Liveness and readiness (contracts/member-api.md): /healthz always answers
// while the process runs; /readyz needs the database and current migrations.
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Pool } from './db.js';
import { migrationsCurrent } from './migrate.js';

export function registerHealth(app: FastifyInstance, pool: Pool, config: Config): void {
  app.get('/healthz', async () => ({ ok: true }));

  app.get('/readyz', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      const current = await migrationsCurrent(pool, config.migrationsDir);
      if (!current) {
        reply.status(503);
        return { ok: false, error: { code: 'not_ready', message: 'migrations are not current' } };
      }
      return { ok: true };
    } catch {
      reply.status(503);
      return { ok: false, error: { code: 'not_ready', message: 'database unreachable' } };
    }
  });
}
