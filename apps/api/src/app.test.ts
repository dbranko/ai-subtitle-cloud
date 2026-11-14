import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureStorageDirs, loadConfig, type AppConfig } from '@asc/config';
import { createTestDatabase, recordHeartbeat, type TestDatabase } from '@asc/database';
import type { LivenessReport, ReadinessReport } from '@asc/shared';
import { buildApp } from './app.js';

let t: TestDatabase;
let config: AppConfig;
let app: FastifyInstance;

const workerIdentity = {
  service: 'worker',
  instanceId: 'w1',
  pid: 1,
  version: '0.1.0',
  startedAt: new Date(),
};

beforeEach(async () => {
  t = await createTestDatabase();
  const root = mkdtempSync(join(tmpdir(), 'asc-api-'));
  config = loadConfig({ env: { NODE_ENV: 'test' }, rootDir: root, useEnvFile: false });
  ensureStorageDirs(config);
  app = await buildApp({ config, db: t.db, dashboardDir: null });
});
afterEach(async () => {
  await app.close();
  await t.cleanup();
});

describe('GET /health', () => {
  it('reports liveness', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<LivenessReport>();
    expect(body).toMatchObject({ status: 'ok', service: 'api', app: 'ai-subtitle-cloud' });
  });
});

describe('GET /health/ready', () => {
  it('is degraded (HTTP 200) while no worker has reported in', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json<ReadinessReport>();
    expect(body.status).toBe('degraded');
    expect(body.checks.database?.status).toBe('ok');
    expect(body.checks.storage?.status).toBe('ok');
    expect(body.checks.worker?.status).toBe('degraded');
  });

  it('is ok once the worker heartbeat is fresh', async () => {
    await recordHeartbeat(t.db, workerIdentity);
    const body = (
      await app.inject({ method: 'GET', url: '/health/ready' })
    ).json<ReadinessReport>();
    expect(body.status).toBe('ok');
  });

  it('treats a stale worker heartbeat as degraded', async () => {
    await recordHeartbeat(t.db, workerIdentity, new Date(Date.now() - 10 * 60_000));
    const body = (
      await app.inject({ method: 'GET', url: '/health/ready' })
    ).json<ReadinessReport>();
    expect(body.checks.worker?.status).toBe('degraded');
    expect(body.checks.worker?.detail).toMatch(/ago/);
  });

  it('fails with HTTP 503 when the database is unavailable', async () => {
    await t.db.$disconnect();
    const broken = {
      $queryRawUnsafe: () => Promise.reject(new Error('db down')),
    } as unknown as TestDatabase['db'];
    const brokenApp = await buildApp({ config, db: broken, dashboardDir: null });
    const res = await brokenApp.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json<ReadinessReport>().checks.database?.status).toBe('fail');
    await brokenApp.close();
  });

  it('fails with HTTP 503 when a storage directory is missing', async () => {
    const other = loadConfig({
      env: { NODE_ENV: 'test' },
      rootDir: mkdtempSync(join(tmpdir(), 'asc-api-nostore-')),
      useEnvFile: false,
    });
    const otherApp = await buildApp({ config: other, db: t.db, dashboardDir: null });
    const res = await otherApp.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json<ReadinessReport>().checks.storage?.status).toBe('fail');
    await otherApp.close();
  });
});

describe('routing', () => {
  it('returns JSON 404 for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('serves the built dashboard and falls back to index.html for client routes', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'asc-dash-'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>dash</title>');
    const withDash = await buildApp({ config, db: t.db, dashboardDir: dist });
    expect((await withDash.inject({ method: 'GET', url: '/' })).body).toContain('dash');
    expect((await withDash.inject({ method: 'GET', url: '/jobs/123' })).body).toContain('dash');
    expect((await withDash.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(404);
    expect((await withDash.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    await withDash.close();
  });
});
