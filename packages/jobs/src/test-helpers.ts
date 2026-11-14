/** Shared setup for job engine tests: real migrated SQLite database, temp data directory. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureStorageDirs, loadConfig, type AppConfig } from '@asc/config';
import { createTestDatabase, openDatabase, type Database, type TestDatabase } from '@asc/database';
import { createLogger } from '@asc/shared';
import {
  createMockTranslator,
  type MockTranslator,
  type MockTranslatorOptions,
  type SegmentTranslator,
} from '@asc/translation-engine';
import { fixtureText } from './test-fixtures.js';
import {
  createJob,
  JobWorker,
  type CreateJobInput,
  type JobEventType,
  type JobView,
  type NotificationView,
  type TranslatorFactory,
} from './index.js';

export interface TestContext {
  t: TestDatabase;
  db: Database;
  config: AppConfig;
  workers: JobWorker[];
  connections: Database[];
  cleanup: () => Promise<void>;
}

export async function createContext(env: Record<string, string> = {}): Promise<TestContext> {
  const t = await createTestDatabase();
  const config = loadConfig({
    env: {
      NODE_ENV: 'test',
      MOCK_AI: 'true',
      MOCK_AI_DELAY_MS: '0',
      WORKER_POLL_INTERVAL_MS: '50',
      WORKER_LEASE_MS: '500',
      ...env,
    },
    rootDir: mkdtempSync(join(tmpdir(), 'asc-jobs-')),
    useEnvFile: false,
  });
  ensureStorageDirs(config);
  const ctx: TestContext = {
    t,
    db: t.db,
    config,
    workers: [],
    connections: [],
    cleanup: async () => {
      await Promise.all(ctx.workers.map((w) => w.kill()));
      await Promise.all(ctx.connections.map((c) => c.$disconnect()));
      await t.cleanup();
    },
  };
  return ctx;
}

let workerSeq = 0;

/**
 * Create a worker. `separateConnection` gives it its own database connection,
 * like a second worker process would have.
 */
export async function createWorker(
  ctx: TestContext,
  translator: SegmentTranslator | TranslatorFactory,
  options: { separateConnection?: boolean; id?: string; config?: AppConfig } = {},
): Promise<JobWorker> {
  let db = ctx.db;
  if (options.separateConnection) {
    db = await openDatabase({ file: ctx.t.file });
    ctx.connections.push(db);
  }
  const worker = new JobWorker({
    db,
    config: options.config ?? ctx.config,
    workerId: options.id ?? `worker-${++workerSeq}`,
    createTranslator: typeof translator === 'function' ? translator : () => translator,
    logger: createLogger('worker', 'silent'),
  });
  ctx.workers.push(worker);
  return worker;
}

export function mock(options: MockTranslatorOptions = {}): MockTranslator {
  return createMockTranslator(options);
}

/** Submit the 130-entry fixture (several segments) unless told otherwise. */
export async function submit(ctx: TestContext, overrides: Partial<CreateJobInput> = {}) {
  return createJob(ctx.db, ctx.config, {
    srt: fixtureText('long-episode.srt'),
    sourceName: 'long-episode.srt',
    targetLanguage: 'sr-Latn',
    ...overrides,
  });
}

export interface LoggedEvent {
  id: number;
  type: JobEventType;
  jobId: string | null;
  job: JobView;
  notification: NotificationView;
}

/** The whole event log, in order, with payloads parsed. */
export async function eventLog(db: Database, jobId?: string): Promise<LoggedEvent[]> {
  const rows = await db.jobEvent.findMany({
    where: jobId ? { jobId } : {},
    orderBy: { id: 'asc' },
  });
  return rows.map((r) => {
    const payload = JSON.parse(r.payload) as JobView & NotificationView;
    return {
      id: r.id,
      type: r.type as JobEventType,
      jobId: r.jobId,
      job: payload,
      notification: payload,
    };
  });
}

export const jobEvents = (log: LoggedEvent[]) => log.filter((e) => e.type.startsWith('job.'));
