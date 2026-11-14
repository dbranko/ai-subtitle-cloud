import { assertBindAllowed, describeConfig, ensureStorageDirs, loadConfig } from '@asc/config';
import { openDatabase } from '@asc/database';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  assertBindAllowed(config, 'api', config.api.host);
  ensureStorageDirs(config);

  const db = await openDatabase({ file: config.paths.databaseFile });
  const app = await buildApp({ config, db });
  app.log.info({ config: describeConfig(config) }, 'api starting');

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'api shutting down');
    void app
      .close()
      .then(() => db.$disconnect())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: config.api.host, port: config.api.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
