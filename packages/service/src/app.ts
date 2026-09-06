// Build the Fastify instance (ADR-0001 modular monolith). server.ts listens;
// tests inject requests without a socket.
import fastifyCookie from '@fastify/cookie';
import fastifyFormbody from '@fastify/formbody';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { createPool } from './db.js';
import type { Pool } from './db.js';
import { registerErrorHandling } from './errors.js';
import { registerHealth } from './health.js';
import { loggerOptions } from './logger.js';
import { migrationsCurrent } from './migrate.js';
import { registerConsoleRoutes, viewsDir } from './modules/console/index.js';
import { Envelope } from './modules/crypto/index.js';
import { registerEnrollmentRoutes } from './modules/enrollment/index.js';
import { FailureWindow } from './modules/identity/ratelimit.js';
import { registerIdentity, seedIdentity } from './modules/identity/index.js';
import { registerIntakeRoutes } from './modules/intake/index.js';
import { loadRegistry, registerRegistryRoutes } from './modules/registry/index.js';
import type { Registry } from './modules/registry/index.js';
import { buildOpenApi } from './openapi.js';

export interface AppContext {
  config: Config;
  pool: Pool;
  registry: Registry;
  envelope: Envelope;
  /** Every registered route, for the OpenAPI coverage test. */
  routes: Array<{ method: string; url: string }>;
  /** Console login failure window (stage 6 rate limit); per process. */
  loginFailures: FailureWindow;
}

declare module 'fastify' {
  interface FastifyInstance {
    iwik: AppContext;
  }
}

export async function buildApp(config: Config): Promise<FastifyInstance> {
  const pool = createPool(config.databaseUrl);
  const registry = loadRegistry(config.packsDir);
  const envelope = new Envelope(pool, config.kek);
  const routes: AppContext['routes'] = [];
  const loginFailures = new FailureWindow();

  const app = Fastify({
    logger: loggerOptions(config),
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: false,
  });
  app.decorate('iwik', { config, pool, registry, envelope, routes, loginFailures });
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (method === 'HEAD') continue;
      routes.push({ method, url: route.url });
    }
  });

  registerErrorHandling(app);
  await app.register(fastifyCookie, { secret: config.cookieSecret });
  await app.register(fastifyFormbody);
  await app.register(fastifyView, {
    engine: { eta: new Eta({ views: viewsDir }) },
    root: viewsDir,
    viewExt: 'eta',
    production: config.production,
  });

  registerIdentity(app, pool);
  registerHealth(app, pool, config);
  registerRegistryRoutes(app, registry);
  registerIntakeRoutes(app, { pool, envelope, registry, config });
  registerConsoleRoutes(app, { pool, config, registry, loginFailures });
  registerEnrollmentRoutes(app, { pool, config });

  const openapi = buildOpenApi();
  app.get('/v1/openapi.json', async () => openapi);

  app.addHook('onReady', async () => {
    if (config.seed !== undefined) {
      if (!(await migrationsCurrent(pool, config.migrationsDir))) {
        throw new Error('cannot seed identity: migrations are not current (run migrate first)');
      }
      const seeded = await seedIdentity(pool, config.seed);
      app.log.info({ org_ref: seeded.org.org_ref, node_id: seeded.node_id }, 'seed identity ready');
    }
    app.log.info(
      {
        protocols: registry.size,
        intake: config.featureIntake ? 'enabled' : 'disabled',
        enrollment: config.featureEnrollment ? 'enabled' : 'disabled',
        operator_token: config.operatorTokenHash === undefined ? 'unset' : 'set',
        kek: config.kekSource,
      },
      'service ready',
    );
  });
  app.addHook('onClose', async () => {
    await pool.end();
  });

  return app;
}
