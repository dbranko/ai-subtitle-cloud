import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@asc/config';
import { createTestDatabase, type TestDatabase } from '@asc/database';
import type { LivenessReport, ReadinessReport } from '@asc/shared';
import { buildAddonApp } from './app.js';

const config = loadConfig({ env: { NODE_ENV: 'test' }, rootDir: process.cwd(), useEnvFile: false });
let t: TestDatabase;

beforeEach(async () => {
  t = await createTestDatabase();
});
afterEach(async () => {
  await t.cleanup();
});

describe('addon health', () => {
  it('reports liveness and readiness', async () => {
    const app = buildAddonApp({ config, db: t.db });
    const live = await app.inject({ method: 'GET', url: '/health' });
    expect(live.json<LivenessReport>()).toMatchObject({ status: 'ok', service: 'addon' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json<ReadinessReport>().status).toBe('ok');
    await app.close();
  });

  it('does not expose Stremio routes before Phase 5', async () => {
    const app = buildAddonApp({ config, db: t.db });
    for (const url of ['/manifest.json', '/subtitles/movie/tt0111161.json']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
    await app.close();
  });
});
