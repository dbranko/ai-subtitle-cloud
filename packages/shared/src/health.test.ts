import { describe, expect, it } from 'vitest';
import { buildLiveness, buildReadiness } from './health.js';
import { APP_VERSION } from './version.js';

describe('buildLiveness', () => {
  it('reports service identity and uptime', () => {
    const started = new Date('2026-01-01T00:00:00Z');
    const now = new Date('2026-01-01T00:01:30Z');
    expect(buildLiveness('api', started, now)).toEqual({
      status: 'ok',
      app: 'ai-subtitle-cloud',
      service: 'api',
      version: APP_VERSION,
      uptimeSeconds: 90,
      timestamp: '2026-01-01T00:01:30.000Z',
    });
  });
});

describe('buildReadiness', () => {
  it('is ok when every check is ok', () => {
    expect(buildReadiness('api', { db: { status: 'ok' } }).status).toBe('ok');
  });
  it('is degraded when a check is degraded and none failed', () => {
    const r = buildReadiness('api', { db: { status: 'ok' }, worker: { status: 'degraded' } });
    expect(r.status).toBe('degraded');
  });
  it('is fail when any check failed', () => {
    const r = buildReadiness('api', { db: { status: 'fail' }, worker: { status: 'degraded' } });
    expect(r.status).toBe('fail');
  });
});
