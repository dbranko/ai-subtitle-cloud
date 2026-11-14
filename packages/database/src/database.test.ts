import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestDatabase,
  getHeartbeatStatus,
  openDatabase,
  pingDatabase,
  recordHeartbeat,
  type TestDatabase,
} from './index.js';

let t: TestDatabase;
beforeEach(async () => {
  t = await createTestDatabase();
});
afterEach(async () => {
  await t.cleanup();
});

const identity = {
  service: 'worker',
  instanceId: 'instance-1',
  pid: 4242,
  version: '0.1.0',
  startedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('database', () => {
  it('opens a migrated database and answers a ping', async () => {
    await expect(pingDatabase(t.db)).resolves.toBeUndefined();
  });

  it('uses WAL journaling so several processes can share the file', async () => {
    const rows = await t.db.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode');
    expect(rows[0]?.journal_mode).toBe('wal');
  });

  it('persists data across connections (simulated process restart)', async () => {
    await recordHeartbeat(t.db, identity, new Date('2026-01-01T00:00:05Z'));
    await t.db.$disconnect();

    const reopened = await openDatabase({ file: t.file });
    try {
      const row = await reopened.serviceHeartbeat.findUnique({ where: { service: 'worker' } });
      expect(row?.instanceId).toBe('instance-1');
      expect(row?.lastSeenAt.toISOString()).toBe('2026-01-01T00:00:05.000Z');
    } finally {
      await reopened.$disconnect();
    }
  });

  it('allows a second connection to write while the first is open', async () => {
    const second = await openDatabase({ file: t.file });
    try {
      await recordHeartbeat(t.db, identity);
      await recordHeartbeat(second, { ...identity, service: 'api' });
      expect(await t.db.serviceHeartbeat.count()).toBe(2);
    } finally {
      await second.$disconnect();
    }
  });
});

describe('heartbeats', () => {
  it('reports a service that never started as not alive', async () => {
    const status = await getHeartbeatStatus(t.db, 'worker', 15_000);
    expect(status).toEqual({ alive: false, heartbeat: null, ageMs: null });
  });

  it('upserts one row per service and tracks freshness', async () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    await recordHeartbeat(t.db, identity, t0);
    await recordHeartbeat(
      t.db,
      { ...identity, instanceId: 'instance-2' },
      new Date(t0.getTime() + 5000),
    );
    expect(await t.db.serviceHeartbeat.count()).toBe(1);

    const fresh = await getHeartbeatStatus(t.db, 'worker', 15_000, new Date(t0.getTime() + 10_000));
    expect(fresh.alive).toBe(true);
    expect(fresh.ageMs).toBe(5000);
    expect(fresh.heartbeat?.instanceId).toBe('instance-2');

    const stale = await getHeartbeatStatus(t.db, 'worker', 15_000, new Date(t0.getTime() + 60_000));
    expect(stale.alive).toBe(false);
  });
});
