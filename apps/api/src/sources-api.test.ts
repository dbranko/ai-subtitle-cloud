import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureStorageDirs, loadConfig, type AppConfig } from '@asc/config';
import { createTestDatabase, type TestDatabase } from '@asc/database';
import { JobWorker, waitForJob, type JobView } from '@asc/jobs';
import { createLogger } from '@asc/shared';
import {
  SourceError,
  type RankedCandidate,
  type SourceCandidate,
  type SubtitleSource,
} from '@asc/subtitle-sources';
import { createMockTranslator } from '@asc/translation-engine';
import { buildApp } from './app.js';

const FIXTURES = new URL('../../../fixtures/subtitles/', import.meta.url);
const LONG = readFileSync(new URL('long-episode.srt', FIXTURES));
const BASIC = readFileSync(new URL('basic-movie.srt', FIXTURES));

const MEDIA = {
  type: 'movie',
  imdbId: 'tt0111161',
  title: 'The Shawshank Redemption',
  fileName: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS.mkv',
};

let t: TestDatabase;
let config: AppConfig;
let app: FastifyInstance;
let worker: JobWorker | undefined;
let searches = 0;
let failSearch: SourceError | undefined;

const OFFERS: (SourceCandidate & { bytes: Uint8Array })[] = [
  {
    source: 'opensubtitles',
    id: 'web',
    language: 'en',
    hashMatch: false,
    release: 'Movie.720p.WEB-DL-X',
    bytes: BASIC,
  },
  {
    source: 'opensubtitles',
    id: 'bluray',
    language: 'en',
    hashMatch: false,
    release: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS',
    bytes: LONG,
  },
];
const remote: SubtitleSource = {
  id: 'opensubtitles',
  name: 'Fake OpenSubtitles',
  search() {
    searches++;
    if (failSearch) return Promise.reject(failSearch);
    return Promise.resolve(OFFERS.map(({ bytes: _bytes, ...c }) => c));
  },
  download(candidate) {
    const offer = OFFERS.find((o) => o.id === candidate.id);
    return offer ? Promise.resolve({ bytes: offer.bytes }) : Promise.reject(new Error('gone'));
  },
};

beforeEach(async () => {
  searches = 0;
  failSearch = undefined;
  t = await createTestDatabase();
  config = loadConfig({
    env: {
      NODE_ENV: 'test',
      MOCK_AI: 'true',
      WORKER_POLL_INTERVAL_MS: '50',
      WORKER_LEASE_MS: '500',
    },
    rootDir: mkdtempSync(join(tmpdir(), 'asc-api-src-')),
    useEnvFile: false,
  });
  ensureStorageDirs(config);
  app = await buildApp({ config, db: t.db, dashboardDir: null, sources: [remote] });
});
afterEach(async () => {
  await worker?.kill();
  worker = undefined;
  await app.close();
  await t.cleanup();
});

function startWorker(): void {
  worker = new JobWorker({
    db: t.db,
    config,
    workerId: `src-test-${Math.random().toString(36).slice(2)}`,
    createTranslator: () => createMockTranslator(),
    sources: [remote],
    logger: createLogger('worker', 'silent'),
  });
  worker.start();
}
const post = (url: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url, payload });
const get = (url: string) => app.inject({ method: 'GET', url });
type MediaResponse = {
  status: string;
  job: JobView | null;
  translation: { jobId: string; entries: number } | null;
};

describe('POST /api/v1/jobs/from-media', () => {
  it('queues a job that finds its own source, without searching in the request', async () => {
    const res = await post('/api/v1/jobs/from-media', { media: MEDIA, targetLanguage: 'sr-Latn' });
    expect(res.statusCode).toBe(201);
    const body = res.json<MediaResponse>();
    expect(body.status).toBe('created');
    expect(body.job).toMatchObject({
      state: 'queued',
      mediaTitle: 'The Shawshank Redemption',
      imdbId: 'tt0111161',
      totalEntries: 0,
    });
    expect(searches).toBe(0);

    // The same request again: the same job.
    const again = await post('/api/v1/jobs/from-media', {
      media: MEDIA,
      targetLanguage: 'sr-Latn',
    });
    expect(again.statusCode).toBe(200);
    expect(again.json<MediaResponse>()).toMatchObject({
      status: 'active',
      job: { id: body.job!.id },
    });
  });

  it('translates in the background and then answers from the cache', async () => {
    const { job } = (
      await post('/api/v1/jobs/from-media', { media: MEDIA, targetLanguage: 'sr-Latn' })
    ).json<MediaResponse>();
    startWorker();
    await waitForJob(t.db, job!.id);

    const view = (await get(`/api/v1/jobs/${job!.id}`)).json<{ job: JobView }>().job;
    // The Blu-ray release matching the video was chosen, not the first result.
    expect(view).toMatchObject({
      state: 'completed',
      totalEntries: 130,
      sourceLanguage: 'en',
      cacheHit: false,
      hasOutput: true,
    });
    expect((await get(`/api/v1/jobs/${job!.id}/download`)).body.match(/-->/g)).toHaveLength(130);

    const cached = (
      await post('/api/v1/jobs/from-media', { media: MEDIA, targetLanguage: 'sr-Latn' })
    ).json<MediaResponse>();
    expect(cached).toMatchObject({
      status: 'cached',
      translation: { jobId: job!.id, entries: 130 },
      job: { id: job!.id },
    });
    expect(searches).toBe(1);
  });

  it('accepts a source chosen by the owner', async () => {
    const res = await post('/api/v1/jobs/from-media', {
      media: MEDIA,
      targetLanguage: 'hr',
      source: { source: 'opensubtitles', id: 'web', language: 'en', hashMatch: false },
    });
    expect(res.statusCode).toBe(201);
    startWorker();
    const done = await waitForJob(t.db, res.json<MediaResponse>().job!.id);
    expect(done).toMatchObject({ state: 'completed', totalEntries: 12 });
    expect(searches).toBe(0);
  });

  it.each([
    ['no media', { targetLanguage: 'hr' }],
    ['bad IMDb id', { media: { type: 'movie', imdbId: '111161' }, targetLanguage: 'hr' }],
    ['bad video hash', { media: { ...MEDIA, videoHash: 'xyz' }, targetLanguage: 'hr' }],
    [
      'series without episode',
      { media: { type: 'series', imdbId: 'tt0903747' }, targetLanguage: 'hr' },
    ],
    ['nothing to search for', { media: { type: 'movie' }, targetLanguage: 'hr' }],
    ['Bosnian target', { media: MEDIA, targetLanguage: 'bs' }],
  ])('rejects %s', async (_name, payload) => {
    const res = await post('/api/v1/jobs/from-media', payload);
    expect(res.statusCode).toBe(400);
    expect(await t.db.translationJob.count()).toBe(0);
  });
});

describe('POST /api/v1/sources/search', () => {
  it('lists source subtitles, best match first, with the reasons', async () => {
    const res = await post('/api/v1/sources/search', { media: MEDIA, targetLanguage: 'sr-Latn' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ candidates: RankedCandidate[]; failures: unknown[] }>();
    expect(body.candidates.map((c) => c.id)).toEqual(['bluray', 'web']);
    expect(body.candidates[0]?.reasons).toContain('same source type (bluray)');
    expect(body.candidates[0]?.score).toBeGreaterThan(body.candidates[1]?.score ?? 0);
    expect(body.failures).toEqual([]);
  });

  it('includes the owner’s uploads and puts them first', async () => {
    await post('/api/v1/jobs', {
      contentBase64: BASIC.toString('base64'),
      fileName: 'mine.srt',
      targetLanguage: 'hr',
      imdbId: 'tt0111161',
      mediaType: 'movie',
    });
    const body = (await post('/api/v1/sources/search', { media: MEDIA })).json<{
      candidates: RankedCandidate[];
    }>();
    expect(body.candidates[0]).toMatchObject({
      source: 'library',
      local: true,
      fileName: 'mine.srt',
    });
    expect(body.candidates[0]?.reasons[0]).toBe('uploaded by you');
    expect(body.candidates).toHaveLength(3);
  });

  it('reports a failing source without failing the whole search', async () => {
    failSearch = new SourceError(
      'opensubtitles',
      'quota',
      'The OpenSubtitles download quota is used up.',
    );
    const res = await post('/api/v1/sources/search', { media: MEDIA });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      candidates: [],
      failures: [
        {
          source: 'opensubtitles',
          error: 'source_quota',
          message: 'The OpenSubtitles download quota is used up.',
        },
      ],
    });
  });
});

describe('cache endpoints and metadata', () => {
  it('reports cache contents and cleans up on request', async () => {
    const { job } = (
      await post('/api/v1/jobs/from-media', { media: MEDIA, targetLanguage: 'sr-Latn' })
    ).json<MediaResponse>();
    startWorker();
    await waitForJob(t.db, job!.id);

    const stats = (await get('/api/v1/cache')).json<{
      translations: number;
      sources: number;
      limits: unknown;
    }>();
    expect(stats).toMatchObject({
      translations: 1,
      sources: 1,
      limits: { maxAgeDays: 0, maxSizeMb: 0 },
    });

    // With the configured limits (none) nothing is removed.
    expect((await post('/api/v1/cache/cleanup')).json()).toEqual({
      translationsRemoved: 0,
      sourcesRemoved: 0,
      bytesFreed: 0,
    });

    // Downloading marks the translation as recently used.
    await t.db.translation.updateMany({
      data: { lastUsedAt: new Date(Date.now() - 90 * 86_400_000) },
    });
    await get(`/api/v1/jobs/${job!.id}/download`);
    expect((await post('/api/v1/cache/cleanup', { maxAgeDays: 30 })).json()).toMatchObject({
      translationsRemoved: 0,
    });

    await t.db.translation.updateMany({
      data: { lastUsedAt: new Date(Date.now() - 90 * 86_400_000) },
    });
    expect((await post('/api/v1/cache/cleanup', { maxAgeDays: 30 })).json()).toMatchObject({
      translationsRemoved: 1,
      sourcesRemoved: 1,
    });
    expect((await get(`/api/v1/jobs/${job!.id}`)).json<{ job: JobView }>().job.hasOutput).toBe(
      false,
    );
    expect((await get(`/api/v1/jobs/${job!.id}/download`)).statusCode).toBe(409);
  });

  it('tells the UI which sources are available', async () => {
    const meta = (await get('/api/v1/meta')).json<{
      sources: unknown;
      defaultSourceLanguages: string[];
    }>();
    expect(meta.sources).toEqual([
      { id: 'library', name: 'Your uploads', configured: true },
      { id: 'opensubtitles', name: 'OpenSubtitles', configured: true },
    ]);
    expect(meta.defaultSourceLanguages).toEqual(['en']);
  });

  it('shows OpenSubtitles as not configured without an API key, and never leaks the key', async () => {
    await app.close();
    app = await buildApp({ config, db: t.db, dashboardDir: null });
    const meta = (await get('/api/v1/meta')).json<{
      sources: { id: string; configured: boolean }[];
    }>();
    expect(meta.sources.find((s) => s.id === 'opensubtitles')?.configured).toBe(false);

    await app.close();
    const withKey = loadConfig({
      env: {
        NODE_ENV: 'test',
        MOCK_AI: 'true',
        OPENSUBTITLES_API_KEY: 'os-very-secret-key',
        OPENSUBTITLES_PASSWORD: 'pw-very-secret',
      },
      rootDir: config.rootDir,
      useEnvFile: false,
    });
    app = await buildApp({ config: withKey, db: t.db, dashboardDir: null });
    const res = await get('/api/v1/meta');
    expect(res.body).not.toContain('very-secret');
    expect(
      res.json<{ sources: { id: string; configured: boolean }[] }>().sources[1]?.configured,
    ).toBe(true);
  });
});
