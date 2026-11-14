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

/** Source subtitle path relative to the jobs directory. */
export function sourceFileName(jobId: string): string {
  return join(assertSafe(jobId), 'source.srt');
}

/** Output file name relative to the subtitles directory. */
export function outputFileName(jobId: string, targetLanguage: string): string {
  return `${assertSafe(jobId)}.${assertSafe(targetLanguage)}.srt`;
}

export function sourcePath(config: AppConfig, sourceFile: string): string {
  return join(config.paths.jobsDir, sourceFile);
}

export function outputPath(config: AppConfig, outputFile: string): string {
  return join(config.paths.subtitlesDir, outputFile);
}

/** Write a file so that readers see either the old content or the complete new content. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
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

export async function removeJobFiles(config: AppConfig, jobId: string): Promise<void> {
  await rm(join(config.paths.jobsDir, assertSafe(jobId)), { recursive: true, force: true });
}
