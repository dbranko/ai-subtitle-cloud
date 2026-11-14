import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from './generated/prisma/client.js';

export type Database = PrismaClient;

export interface DatabaseOptions {
  /** Absolute path of the SQLite file, or `:memory:`. */
  file: string;
  /** How long a connection waits on a lock held by another process (ms). */
  busyTimeoutMs?: number;
}

/**
 * Open the SQLite database.
 *
 * The API, worker and add-on are separate processes sharing one database file,
 * so the connection is configured for multi-process use:
 *  - WAL journal: readers never block the writer and vice versa;
 *  - busy timeout: a second writer waits instead of failing with SQLITE_BUSY;
 *  - synchronous=NORMAL: safe with WAL (durable across application crashes).
 */
export async function openDatabase(options: DatabaseOptions): Promise<Database> {
  const inMemory = options.file === ':memory:';
  if (!inMemory) mkdirSync(dirname(options.file), { recursive: true });

  const adapter = new PrismaBetterSqlite3({
    url: inMemory ? ':memory:' : `file:${options.file}`,
    timeout: options.busyTimeoutMs ?? 5000,
  });
  const db = new PrismaClient({ adapter });
  await db.$connect();
  if (!inMemory) {
    await db.$queryRawUnsafe('PRAGMA journal_mode = WAL');
    await db.$queryRawUnsafe('PRAGMA synchronous = NORMAL');
  }
  await db.$queryRawUnsafe('PRAGMA foreign_keys = ON');
  return db;
}

/** Cheap connectivity probe used by readiness checks. Throws when the database is unusable. */
export async function pingDatabase(db: Database): Promise<void> {
  await db.$queryRawUnsafe('SELECT 1');
}
