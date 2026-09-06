// HTTP entrypoint: `node packages/service/dist/server.js`.
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const app = await buildApp(config);
  const shutdown = (signal: string): void => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  await app.listen({ port: config.port, host: config.host });
}

main().catch((err: unknown) => {
  process.stderr.write(
    `service failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
