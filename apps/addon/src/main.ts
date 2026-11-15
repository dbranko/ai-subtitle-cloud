import { assertBindAllowed, describeConfig, ensureStorageDirs, loadConfig } from '@asc/config';
import { openDatabase } from '@asc/database';
import { buildAddonApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  assertBindAllowed(config, 'addon', config.addon.host);
  ensureStorageDirs(config);

  const db = await openDatabase({ file: config.paths.databaseFile });
  const app = await buildAddonApp({ config, db });
  app.log.info({ config: describeConfig(config) }, 'addon starting');

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'addon shutting down');
    void app
      .close()
      .then(() => db.$disconnect())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ host: config.addon.host, port: config.addon.port });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
