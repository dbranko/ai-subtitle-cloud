import { constants, mkdirSync } from 'node:fs';
import { access } from 'node:fs/promises';
import type { AppConfig } from './config.js';

/** Directories every process expects to exist. */
export function storageDirs(config: AppConfig): Record<string, string> {
  const { dataDir, subtitlesDir, cacheDir, logsDir, jobsDir } = config.paths;
  return { data: dataDir, subtitles: subtitlesDir, cache: cacheDir, logs: logsDir, jobs: jobsDir };
}

/** Create the storage directories if missing (idempotent). */
export function ensureStorageDirs(config: AppConfig): void {
  for (const dir of Object.values(storageDirs(config))) mkdirSync(dir, { recursive: true });
}

/** Names of storage directories that are missing or not writable. */
export async function findUnwritableStorageDirs(config: AppConfig): Promise<string[]> {
  const bad: string[] = [];
  for (const [name, dir] of Object.entries(storageDirs(config))) {
    try {
      await access(dir, constants.R_OK | constants.W_OK);
    } catch {
      bad.push(name);
    }
  }
  return bad;
}
