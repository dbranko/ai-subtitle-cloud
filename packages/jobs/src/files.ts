import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppConfig } from '@asc/config';
import { JobStorageError } from './errors.js';

// File names are built only from generated job ids and validated language ids —
// never from anything the user typed — so they cannot escape the data directories.
const SAFE_ID = /^[A-Za-z0-9-]+$/;

function assertSafe(part: string): string {
  if (!SAFE_ID.test(part)) throw new Error(`Unsafe path component: "${part}"`);
  return part;
}

const SAFE_HASH = /^[a-f0-9]{64}$/;

/** Source subtitle path relative to the cache directory. One file per distinct content. */
export function sourceFileName(sourceHash: string): string {
  if (!SAFE_HASH.test(sourceHash)) throw new Error('Invalid source hash.');
  return join('sources', `${sourceHash}.srt`);
}

/** Output file name relative to the subtitles directory. */
export function outputFileName(jobId: string, targetLanguage: string): string {
  return `${assertSafe(jobId)}.${assertSafe(targetLanguage)}.srt`;
}

export function sourcePath(config: AppConfig, sourceFile: string): string {
  return join(config.paths.cacheDir, sourceFile);
}

export function outputPath(config: AppConfig, outputFile: string): string {
  return join(config.paths.subtitlesDir, outputFile);
}

/** Write a file so that readers see either the old content or the complete new content. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // Unique per call: several requests may store the same file at the same moment.
  const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, 'utf8');
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}

export async function readSource(config: AppConfig, sourceFile: string): Promise<string> {
  try {
    return await readFile(sourcePath(config, sourceFile), 'utf8');
  } catch (err) {
    throw new JobStorageError('source_missing', 'The stored source subtitle could not be read.', {
      cause: err,
    });
  }
}
