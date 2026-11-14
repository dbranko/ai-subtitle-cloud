import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { findUnwritableStorageDirs, type AppConfig } from '@asc/config';
import { getHeartbeatStatus, pingDatabase, type Database } from '@asc/database';
import { buildLiveness, buildReadiness, loggerOptions, type ReadinessCheck } from '@asc/shared';
import { EventHub, type EventHubOptions } from './events.js';
import { registerApiRoutes } from './routes.js';

export interface ApiDeps {
  config: AppConfig;
  db: Database;
  startedAt?: Date;
  /** Built dashboard directory to serve; defaults to apps/dashboard/dist when it exists. */
  dashboardDir?: string | null;
  /** Tuning of the real-time event stream (tests use short intervals). */
  events?: EventHubOptions;
}

/** Requests per minute allowed per client address on the API routes. */
const API_RATE_LIMIT = 600;

/** A worker is reported alive while its heartbeat is younger than 3 intervals. */
const WORKER_STALE_FACTOR = 3;

/** Health endpoints are polled constantly; only log them when something is wrong. */
const QUIET = { logLevel: 'warn' } as const;

export async function buildApp(deps: ApiDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const startedAt = deps.startedAt ?? new Date();
  const app = Fastify({
    logger: config.nodeEnv === 'test' ? false : loggerOptions('api', config.logLevel),
  });

  await app.register(rateLimit, {
    max: API_RATE_LIMIT,
    timeWindow: '1 minute',
    // Health checks and static dashboard files are not limited.
    allowList: (req) => !req.url.startsWith('/api/'),
  });

  const events = new EventHub(db, deps.events);
  // Open event streams would keep the server from shutting down: end them first.
  app.addHook('preClose', () => {
    events.close();
  });
  registerApiRoutes(app, { config, db, events });

  // Liveness: the process is up. Must stay dependency-free and fast.
  app.get('/health', QUIET, () => buildLiveness('api', startedAt));

  // Readiness: the process can do real work. 503 only when a hard dependency failed;
  // a missing worker is "degraded" because the API itself still functions.
  app.get('/health/ready', QUIET, async (_req, reply) => {
    const checks: Record<string, ReadinessCheck> = {};

    try {
      await pingDatabase(db);
      checks.database = { status: 'ok' };
    } catch {
      checks.database = { status: 'fail', detail: 'database is not reachable' };
    }

    const unwritable = await findUnwritableStorageDirs(config);
    checks.storage =
      unwritable.length === 0
        ? { status: 'ok' }
        : { status: 'fail', detail: `not writable: ${unwritable.join(', ')}` };

    if (checks.database.status === 'ok') {
      const maxAge = config.worker.heartbeatIntervalMs * WORKER_STALE_FACTOR;
      const worker = await getHeartbeatStatus(db, 'worker', maxAge);
      checks.worker = worker.alive
        ? { status: 'ok' }
        : {
            status: 'degraded',
            detail:
              worker.ageMs === null
                ? 'worker has never reported a heartbeat'
                : `last worker heartbeat ${Math.round(worker.ageMs / 1000)}s ago`,
          };
    } else {
      checks.worker = { status: 'degraded', detail: 'unknown (database unavailable)' };
    }

    const report = buildReadiness('api', checks);
    return reply.code(report.status === 'fail' ? 503 : 200).send(report);
  });

  const dashboardDir =
    deps.dashboardDir === undefined
      ? resolve(config.rootDir, 'apps', 'dashboard', 'dist')
      : deps.dashboardDir;
  if (dashboardDir !== null && existsSync(resolve(dashboardDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: dashboardDir });
    // SPA fallback: unknown non-API GETs render the dashboard shell.
    app.setNotFoundHandler((req, reply) => {
      const isPage =
        req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/health');
      if (isPage) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not_found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: 'not_found' }));
  }

  return app;
}
