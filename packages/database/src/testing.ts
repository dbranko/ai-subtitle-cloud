import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import BetterSqlite3 from 'better-sqlite3';
import { openDatabase, type Database } from './client.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../prisma/migrations', import.meta.url));

/** Apply every committed migration, in order, to a fresh SQLite file. */
export function applyMigrations(file: string, migrationsDir = MIGRATIONS_DIR): string[] {
  const names = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const sqlite = new BetterSqlite3(file);
  try {
    for (const name of names) {
      sqlite.exec(readFileSync(join(migrationsDir, name, 'migration.sql'), 'utf8'));
    }
  } finally {
    sqlite.close();
  }
  return names;
}

export interface TestDatabase {
  db: Database;
  file: string;
  /** Disconnect and delete the temporary database. */
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated, fully migrated database in a temp directory.
 * Test-only: uses the real migration files so tests exercise the real schema.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const dir = mkdtempSync(join(tmpdir(), 'asc-db-'));
  const file = join(dir, 'test.sqlite');
  applyMigrations(file);
  const db = await openDatabase({ file });
  return {
    db,
    file,
    cleanup: async () => {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
