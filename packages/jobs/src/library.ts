import { randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import type { AppConfig } from '@asc/config';
import type { Database, SourceSubtitle, Translation } from '@asc/database';
import type { SubtitleEntry } from '@asc/subtitle-parser';
import {
  createOpenSubtitlesSource,
  type MediaQuery,
  type SourceCandidate,
  type SubtitleSource,
} from '@asc/subtitle-sources';
import { outputPath, sourceFileName, sourcePath, writeFileAtomic } from './files.js';
import { hashSource } from './key.js';
import { ACTIVE_STATES } from './states.js';

// ---------------------------------------------------------------------------
// Source library
// ---------------------------------------------------------------------------

export interface StoreSourceInput {
  /** The subtitle as decoded text. */
  srt: string;
  entries: readonly SubtitleEntry[];
  /** "upload", or the id of the source adapter it was downloaded from. */
  provider: string;
  externalId?: string | undefined;
  language?: string | undefined;
  fileName?: string | undefined;
  release?: string | undefined;
  /** Title of the movie or series, when known. */
  title?: string | undefined;
  mediaType?: string | undefined;
  imdbId?: string | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  videoHash?: string | undefined;
}

/**
 * Put a source subtitle into the library. Content-addressed: the same subtitle
 * is stored once, however often and from wherever it arrives. Media details
 * that were unknown before are filled in.
 */
export async function storeSource(
  db: Database,
  config: AppConfig,
  input: StoreSourceInput,
  now = new Date(),
): Promise<SourceSubtitle> {
  const hash = hashSource(input.entries);
  const file = sourceFileName(hash);
  const path = sourcePath(config, file);
  if (!existsSync(path)) await writeFileAtomic(path, input.srt);

  const details = {
    language: input.language,
    fileName: input.fileName?.slice(0, 300),
    release: input.release?.slice(0, 300),
    title: input.title?.trim().slice(0, 300) || undefined,
    mediaType: input.mediaType,
    imdbId: input.imdbId,
    season: input.season,
    episode: input.episode,
    videoHash: input.videoHash?.toLowerCase(),
  };
  const existing = await db.sourceSubtitle.findUnique({ where: { hash } });
  if (existing) {
    const fill: Record<string, unknown> = { lastUsedAt: now };
    for (const [key, value] of Object.entries(details)) {
      if (value !== undefined && existing[key as keyof SourceSubtitle] === null) fill[key] = value;
    }
    // An upload makes the subtitle part of the owner's own library, wherever it first came from.
    if (input.provider === 'upload' && existing.provider !== 'upload') fill.provider = 'upload';
    return db.sourceSubtitle.update({ where: { hash }, data: fill });
  }
  try {
    return await db.sourceSubtitle.create({
      data: {
        id: randomUUID(),
        hash,
        provider: input.provider,
        externalId: input.externalId ?? null,
        ...Object.fromEntries(Object.entries(details).map(([k, v]) => [k, v ?? null])),
        entries: input.entries.length,
        sizeBytes: Buffer.byteLength(input.srt),
        file,
        createdAt: now,
        lastUsedAt: now,
      },
    });
  } catch (err) {
    // Two requests stored the same subtitle at the same moment: use the row that won.
    const winner = await db.sourceSubtitle.findUnique({ where: { hash } });
    if (winner) return winner;
    throw err;
  }
}

export const LIBRARY_SOURCE_ID = 'library';

/**
 * The local subtitle source: subtitles the owner uploaded for a title. They
 * are found by IMDb id (and season/episode), and preferred over downloads.
 */
export function createLibrarySource(db: Database, config: AppConfig): SubtitleSource {
  return {
    id: LIBRARY_SOURCE_ID,
    name: 'Your uploads',
    async search(query: MediaQuery): Promise<SourceCandidate[]> {
      if (!query.imdbId) return [];
      const rows = await db.sourceSubtitle.findMany({
        where: {
          provider: 'upload',
          imdbId: query.imdbId,
          ...(query.type === 'series'
            ? { season: query.season ?? null, episode: query.episode ?? null }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      return rows.map((row) => ({
        source: LIBRARY_SOURCE_ID,
        id: row.id,
        language: row.language ?? '',
        release: row.release ?? undefined,
        fileName: row.fileName ?? undefined,
        title: row.title ?? undefined,
        hashMatch: query.videoHash !== undefined && row.videoHash === query.videoHash.toLowerCase(),
        season: row.season ?? undefined,
        episode: row.episode ?? undefined,
        local: true,
      }));
    },
    async download(candidate) {
      const row = await db.sourceSubtitle.findUnique({ where: { id: candidate.id } });
      if (!row) throw new Error('The uploaded subtitle no longer exists.');
      return {
        bytes: await readFile(sourcePath(config, row.file)),
        fileName: row.fileName ?? undefined,
      };
    },
  };
}

/** Remote sources that are configured. The local library is always added by the caller. */
export function createSourcesFromConfig(config: AppConfig): SubtitleSource[] {
  const sources: SubtitleSource[] = [];
  const os = config.sources.openSubtitles;
  if (os.apiKey) {
    sources.push(
      createOpenSubtitlesSource({
        apiKey: os.apiKey,
        userAgent: os.userAgent,
        username: os.username,
        password: os.password,
        maxBytes: config.sources.maxBytes,
      }),
    );
  }
  return sources;
}

// ---------------------------------------------------------------------------
// Translation cache
// ---------------------------------------------------------------------------

/**
 * Look up a finished translation by translation key. An entry whose file has
 * disappeared is not a hit (and is removed), so the cache never hands out a
 * translation it cannot actually deliver.
 */
export async function findCachedTranslation(
  db: Database,
  config: AppConfig,
  translationKey: string,
  now = new Date(),
): Promise<Translation | null> {
  const entry = await db.translation.findUnique({ where: { translationKey } });
  if (!entry) return null;
  if (!existsSync(outputPath(config, entry.file))) {
    await removeTranslation(db, config, entry);
    return null;
  }
  return db.translation.update({ where: { id: entry.id }, data: { lastUsedAt: now } });
}

/** The cached translation that answers a media request, if any. */
export async function findCachedMediaTranslation(
  db: Database,
  config: AppConfig,
  mediaKey: string,
  now = new Date(),
): Promise<Translation | null> {
  const link = await db.mediaLink.findUnique({ where: { mediaKey } });
  if (!link) return null;
  const entry = await findCachedTranslation(db, config, link.translationKey, now);
  if (!entry) await db.mediaLink.deleteMany({ where: { mediaKey } });
  return entry;
}

async function removeTranslation(
  db: Database,
  config: AppConfig,
  entry: Translation,
): Promise<void> {
  await db.$transaction([
    db.mediaLink.deleteMany({ where: { translationKey: entry.translationKey } }),
    db.translationJob.updateMany({ where: { outputFile: entry.file }, data: { outputFile: null } }),
    db.translation.deleteMany({ where: { id: entry.id } }),
  ]);
  await rm(outputPath(config, entry.file), { force: true });
}

export interface CacheStats {
  translations: number;
  translationBytes: number;
  sources: number;
  sourceBytes: number;
  oldestUse: string | null;
}

export async function cacheStats(db: Database): Promise<CacheStats> {
  const [t, s, oldest] = await Promise.all([
    db.translation.aggregate({ _count: true, _sum: { sizeBytes: true } }),
    db.sourceSubtitle.aggregate({ _count: true, _sum: { sizeBytes: true } }),
    db.translation.findFirst({ orderBy: { lastUsedAt: 'asc' }, select: { lastUsedAt: true } }),
  ]);
  return {
    translations: t._count,
    translationBytes: t._sum.sizeBytes ?? 0,
    sources: s._count,
    sourceBytes: s._sum.sizeBytes ?? 0,
    oldestUse: oldest?.lastUsedAt.toISOString() ?? null,
  };
}

export interface CleanupResult {
  translationsRemoved: number;
  sourcesRemoved: number;
  bytesFreed: number;
}

export interface CleanupLimits {
  maxAgeDays: number;
  maxSizeMb: number;
}

/**
 * Remove cached translations by age (not used for `maxAgeDays`) and by size
 * (least recently used first until the cache fits `maxSizeMb`). A limit of 0
 * is "no limit".
 *
 * Never touched: anything an ACTIVE job needs — its source subtitle and the
 * cached translation it is about to reuse — and subtitles the owner uploaded.
 */
export async function cleanupCache(
  db: Database,
  config: AppConfig,
  limits: CleanupLimits = config.cache,
  now = new Date(),
): Promise<CleanupResult> {
  const result: CleanupResult = { translationsRemoved: 0, sourcesRemoved: 0, bytesFreed: 0 };
  const active = await db.translationJob.findMany({
    where: { state: { in: [...ACTIVE_STATES] } },
    select: { translationKey: true, sourceId: true },
  });
  const protectedKeys = new Set(active.map((j) => j.translationKey));
  const protectedSources = new Set(
    active.map((j) => j.sourceId).filter((id): id is string => id !== null),
  );

  const entries = await db.translation.findMany({ orderBy: { lastUsedAt: 'asc' } });
  const removable = (e: Translation) =>
    !protectedKeys.has(e.translationKey) && !protectedSources.has(e.sourceId);
  const doomed = new Set<string>();

  if (limits.maxAgeDays > 0) {
    const cutoff = now.getTime() - limits.maxAgeDays * 86_400_000;
    for (const e of entries) if (e.lastUsedAt.getTime() < cutoff && removable(e)) doomed.add(e.id);
  }
  if (limits.maxSizeMb > 0) {
    let size = entries.filter((e) => !doomed.has(e.id)).reduce((n, e) => n + e.sizeBytes, 0);
    for (const e of entries) {
      if (size <= limits.maxSizeMb * 1024 * 1024) break;
      if (doomed.has(e.id) || !removable(e)) continue;
      doomed.add(e.id);
      size -= e.sizeBytes;
    }
  }
  for (const e of entries) {
    if (!doomed.has(e.id)) continue;
    await removeTranslation(db, config, e);
    result.translationsRemoved++;
    result.bytesFreed += e.sizeBytes;
  }

  // Downloaded sources that no translation and no active job refers to any more.
  if (doomed.size > 0 || limits.maxAgeDays > 0) {
    const orphans = await db.sourceSubtitle.findMany({
      where: { provider: { not: 'upload' }, translations: { none: {} } },
    });
    for (const source of orphans) {
      if (protectedSources.has(source.id)) continue;
      const referenced = await db.translationJob.count({
        where: { sourceId: source.id, state: { in: [...ACTIVE_STATES] } },
      });
      if (referenced > 0) continue;
      await db.sourceSubtitle.deleteMany({ where: { id: source.id } });
      await rm(sourcePath(config, source.file), { force: true });
      result.sourcesRemoved++;
      result.bytesFreed += source.sizeBytes;
    }
  }
  return result;
}

/** Size of a stored translation file in bytes (0 when missing). */
export function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
