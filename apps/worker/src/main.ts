import { assertBindAllowed, describeConfig, ensureStorageDirs, loadConfig } from '@asc/config';
import { openDatabase } from '@asc/database';
import { createLogger } from '@asc/shared';
import { startWorker } from './worker.js';

async function main(): Promise<void> {
  const config = loadConfig();
  assertBindAllowed(config, 'worker', config.worker.healthHost);
  ensureStorageDirs(config);
  const logger = createLogger('worker', config.logLevel);
  logger.info({ config: describeConfig(config) }, 'worker starting');

  const db = await openDatabase({ file: config.paths.databaseFile });
  const worker = await startWorker({ config, db, logger });

  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'worker shutting down');
    void worker
      .stop()
      .then(() => db.$disconnect())
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
