import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@asc/config';
import { createTestDatabase, getHeartbeatStatus, type TestDatabase } from '@asc/database';
import { createLogger, type LivenessReport, type ReadinessReport } from '@asc/shared';
import { startWorker, type RunningWorker } from './worker.js';

let t: TestDatabase;
let worker: RunningWorker | undefined;

const config = loadConfig({
  env: { NODE_ENV: 'test', WORKER_HEALTH_PORT: '1', WORKER_HEARTBEAT_INTERVAL_MS: '250' },
  rootDir: mkdtempSync(join(tmpdir(), 'asc-worker-')),
  useEnvFile: false,
});
// Port 0 = let the OS pick a free port (not expressible through env validation).
config.worker.healthPort = 0;
const logger = createLogger('worker', 'silent');

beforeEach(async () => {
  t = await createTestDatabase();
});
afterEach(async () => {
  await worker?.stop();
  worker = undefined;
  await t.cleanup();
});

describe('worker', () => {
  it('records a heartbeat immediately and keeps refreshing it', async () => {
    worker = await startWorker({ config, db: t.db, logger });
    const first = await getHeartbeatStatus(t.db, 'worker', 5000);
    expect(first.alive).toBe(true);
    expect(first.heartbeat?.instanceId).toBe(worker.identity.instanceId);
    expect(first.heartbeat?.pid).toBe(process.pid);

    const firstSeen = first.heartbeat!.lastSeenAt.getTime();
    await sleep(700);
    const later = await getHeartbeatStatus(t.db, 'worker', 5000);
    expect(later.heartbeat!.lastSeenAt.getTime()).toBeGreaterThan(firstSeen);
  });

  it('stops heartbeating after stop()', async () => {
    worker = await startWorker({ config, db: t.db, logger });
    await worker.stop();
    worker = undefined;
    const before = (await getHeartbeatStatus(t.db, 'worker', 5000)).heartbeat!.lastSeenAt;
    await sleep(600);
    const after = (await getHeartbeatStatus(t.db, 'worker', 5000)).heartbeat!.lastSeenAt;
    expect(after.getTime()).toBe(before.getTime());
  });

  it('gets a new instance id on every start (restart is detectable)', async () => {
    worker = await startWorker({ config, db: t.db, logger });
    const firstId = worker.identity.instanceId;
    await worker.stop();
    worker = await startWorker({ config, db: t.db, logger });
    expect(worker.identity.instanceId).not.toBe(firstId);
    const status = await getHeartbeatStatus(t.db, 'worker', 5000);
    expect(status.heartbeat?.instanceId).toBe(worker.identity.instanceId);
  });

  it('serves liveness and readiness over HTTP', async () => {
    worker = await startWorker({ config, db: t.db, logger });
    const base = `http://127.0.0.1:${worker.healthPort}`;

    const live = await fetch(`${base}/health`);
    expect(live.status).toBe(200);
    expect(((await live.json()) as LivenessReport).service).toBe('worker');

    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    const report = (await ready.json()) as ReadinessReport;
    expect(report.status).toBe('ok');
    expect(report.checks.database?.status).toBe('ok');
    expect(report.checks.heartbeat?.status).toBe('ok');

    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
