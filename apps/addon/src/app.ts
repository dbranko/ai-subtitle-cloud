import Fastify, { type FastifyInstance } from 'fastify';
import type { AppConfig } from '@asc/config';
import { pingDatabase, type Database } from '@asc/database';
import { buildLiveness, buildReadiness, loggerOptions, type ReadinessCheck } from '@asc/shared';

export interface AddonDeps {
  config: AppConfig;
  db: Database;
  startedAt?: Date;
}

/** Health endpoints are polled constantly; only log them when something is wrong. */
const QUIET = { logLevel: 'warn' } as const;

/**
 * Phase 0 add-on server: health endpoints only.
 *
 * The Stremio manifest and subtitle handlers (official Stremio Add-on SDK) are
 * implemented in Phase 5, after the async job engine exists. Until then this
 * process deliberately serves no Stremio routes, so it can never hand Stremio
 * something that is not a real subtitle.
 */
export function buildAddonApp(deps: AddonDeps): FastifyInstance {
  const { config, db } = deps;
  const startedAt = deps.startedAt ?? new Date();
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : loggerOptions('addon', config.logLevel),
  });

  app.get('/health', QUIET, () => buildLiveness('addon', startedAt));

  app.get('/health/ready', QUIET, async (_req, reply) => {
    const checks: Record<string, ReadinessCheck> = {};
    try {
      await pingDatabase(db);
      checks.database = { status: 'ok' };
    } catch {
      checks.database = { status: 'fail', detail: 'database is not reachable' };
    }
    const report = buildReadiness('addon', checks);
    return reply.code(report.status === 'fail' ? 503 : 200).send(report);
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  return app;
}
