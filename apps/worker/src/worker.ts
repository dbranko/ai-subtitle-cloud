import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AppConfig } from '@asc/config';
import {
  pingDatabase,
  recordHeartbeat,
  type Database,
  type HeartbeatIdentity,
} from '@asc/database';
import { createDefaultTranslatorFactory, JobWorker, type TranslatorFactory } from '@asc/jobs';
import {
  APP_VERSION,
  buildLiveness,
  buildReadiness,
  type Logger,
  type ReadinessCheck,
} from '@asc/shared';

export interface WorkerDeps {
  config: AppConfig;
  db: Database;
  logger: Logger;
  /** Override how translators are built (tests). Default: configured providers, or the mock in mock mode. */
  createTranslator?: TranslatorFactory;
}

export interface RunningWorker {
  identity: HeartbeatIdentity;
  /** Actual port of the health server (differs from config when 0 was requested). */
  healthPort: number;
  jobs: JobWorker;
  stop: () => Promise<void>;
}

/**
 * The worker process: translation jobs, a heartbeat and a health endpoint.
 *
 * The job loop (`JobWorker`) claims and processes jobs from the database. The
 * heartbeat row lets the API report whether a worker is alive. The process
 * instance id doubles as the owner id of job locks.
 */
export async function startWorker(deps: WorkerDeps): Promise<RunningWorker> {
  const { config, db, logger } = deps;
  const startedAt = new Date();
  const identity: HeartbeatIdentity = {
    service: 'worker',
    instanceId: randomUUID(),
    pid: process.pid,
    version: APP_VERSION,
    startedAt,
  };

  let lastBeatOk = false;
  let stopped = false;
  const beat = async () => {
    if (stopped) return;
    try {
      await recordHeartbeat(db, identity);
      lastBeatOk = true;
    } catch (err) {
      lastBeatOk = false;
      logger.error({ err }, 'worker heartbeat failed');
    }
  };
  await beat();
  const timer = setInterval(() => void beat(), config.worker.heartbeatIntervalMs);

  const server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'method_not_allowed' });
    if (req.url === '/health') return send(200, buildLiveness('worker', startedAt));
    if (req.url === '/health/ready') {
      void (async () => {
        const checks: Record<string, ReadinessCheck> = {};
        try {
          await pingDatabase(db);
          checks.database = { status: 'ok' };
        } catch {
          checks.database = { status: 'fail', detail: 'database is not reachable' };
        }
        checks.heartbeat = lastBeatOk
          ? { status: 'ok' }
          : { status: 'fail', detail: 'last heartbeat write failed' };
        const report = buildReadiness('worker', checks);
        send(report.status === 'fail' ? 503 : 200, report);
      })();
      return;
    }
    return send(404, { error: 'not_found' });
  });
  await listen(server, config.worker.healthPort, config.worker.healthHost);
  const healthPort = (server.address() as AddressInfo).port;
  const jobs = new JobWorker({
    db,
    config,
    workerId: identity.instanceId,
    createTranslator: deps.createTranslator ?? createDefaultTranslatorFactory(config),
    logger,
  });
  jobs.start();
  logger.info(
    { instanceId: identity.instanceId, healthPort, mockAi: config.mockAi.enabled },
    'worker started',
  );

  return {
    identity,
    healthPort,
    jobs,
    stop: async () => {
      // Hand running jobs back to the queue first, while the database is still usable.
      await jobs.stop();
      stopped = true;
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      logger.info('worker stopped');
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
}
