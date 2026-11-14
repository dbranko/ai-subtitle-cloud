/**
 * Phase 4: subtitle sources and cache, connected to the job engine.
 * Real worker, real database, real engine; the remote source and the AI are fakes.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSrt } from '@asc/subtitle-parser';
import {
  SourceError,
  type MediaQuery,
  type SourceCandidate,
  type SubtitleSource,
} from '@asc/subtitle-sources';
import { containsCyrillic } from '@asc/translation-engine';
import {
  cacheStats,
  cleanupCache,
  getJob,
  JobRequestError,
  listNotifications,
  outputPath,
  requestMediaTranslation,
  sourcePath,
  storeSource,
  waitForJob,
  type MediaTranslationInput,
} from './index.js';
import { fixtureText } from './test-fixtures.js';
import {
  createContext,
  createWorker,
  eventLog,
  jobEvents,
  mock,
  submit,
  type TestContext,
} from './test-helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

const MOVIE: MediaQuery = {
  type: 'movie',
  imdbId: 'tt0111161',
  title: 'The Shawshank Redemption',
  year: 1994,
  videoHash: 'abcdef0123456789',
  fileName: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS.mkv',
};
const EPISODE: MediaQuery = {
  type: 'series',
  imdbId: 'tt0903747',
  title: 'Breaking Bad',
  season: 2,
  episode: 5,
};
const LONG = fixtureText('long-episode.srt');
const BASIC = fixtureText('basic-movie.srt');

type Offer = SourceCandidate & { content: string | Uint8Array };

/** A remote subtitle source double that records what it was asked. */
function fakeSource(
  offers: Offer[],
  behaviour: { searchError?: SourceError; downloadError?: SourceError } = {},
) {
  const searches: { query: MediaQuery; languages: readonly string[] }[] = [];
  const downloads: string[] = [];
  const source: SubtitleSource = {
    id: 'opensubtitles',
    name: 'Fake OpenSubtitles',
    search(query, languages) {
      searches.push({ query, languages });
      if (behaviour.searchError) return Promise.reject(behaviour.searchError);
      return Promise.resolve(offers.map(({ content: _content, ...candidate }) => candidate));
    },
    download(candidate) {
      downloads.push(candidate.id);
      if (behaviour.downloadError) return Promise.reject(behaviour.downloadError);
      const offer = offers.find((o) => o.id === candidate.id);
      if (!offer) return Promise.reject(new SourceError('opensubtitles', 'not_found', 'gone'));
      const bytes =
        typeof offer.content === 'string' ? new TextEncoder().encode(offer.content) : offer.content;
      return Promise.resolve({ bytes, fileName: `${candidate.id}.srt` });
    },
  };
  return { source, searches, downloads };
}

const offer = (
  id: string,
  content: string | Uint8Array,
  extra: Partial<SourceCandidate> = {},
): Offer => ({
  source: 'opensubtitles',
  id,
  language: 'en',
  hashMatch: false,
  content,
  ...extra,
});

const request = (overrides: Partial<MediaTranslationInput> = {}) =>
  requestMediaTranslation(ctx.db, ctx.config, {
    query: MOVIE,
    targetLanguage: 'sr-Latn',
    ...overrides,
  });

// ---------------------------------------------------------------------------
describe('media requests — the job finds its own source', () => {
  it('returns immediately, then locates, downloads, translates and stores the subtitle', async () => {
    const remote = fakeSource([
      offer('100', LONG, { release: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS' }),
    ]);
    const started = Date.now();
    const result = await request();
    expect(Date.now() - started).toBeLessThan(500);
    expect(result.status).toBe('created');
    expect(result.job).toMatchObject({
      state: 'queued',
      mediaTitle: 'The Shawshank Redemption',
      imdbId: 'tt0111161',
      sourceId: null,
      sourceFile: null,
      totalEntries: 0,
    });
    expect(remote.searches).toHaveLength(0); // nothing happened in the request

    const translator = mock();
    (await createWorker(ctx, translator, { sources: [remote.source] })).start();
    const done = await waitForJob(ctx.db, result.job!.id);

    expect(done).toMatchObject({
      state: 'completed',
      percentage: 100,
      sourceLanguage: 'en',
      totalEntries: 130,
      cacheHit: false,
    });
    expect(remote.searches).toEqual([{ query: MOVIE, languages: ['en'] }]);
    expect(remote.downloads).toEqual(['100']);
    expect(
      parseSrt(readFileSync(outputPath(ctx.config, done.outputFile!), 'utf8')).entries,
    ).toHaveLength(130);

    // The real source-discovery stages were passed and reported.
    const events = jobEvents(await eventLog(ctx.db, done.id));
    const states = events.map((e) => e.job.state).filter((s, i, all) => s !== all[i - 1]);
    expect(states.slice(0, 4)).toEqual([
      'queued',
      'locating_source',
      'downloading_source',
      'parsing',
    ]);
    expect(
      events.some((e) =>
        e.job.statusDetail?.startsWith('Found 1 subtitle(s); best: The.Shawshank'),
      ),
    ).toBe(true);

    // The source is in the library, with what is known about it.
    const source = await ctx.db.sourceSubtitle.findUniqueOrThrow({ where: { id: done.sourceId! } });
    expect(source).toMatchObject({
      provider: 'opensubtitles',
      externalId: '100',
      language: 'en',
      imdbId: 'tt0111161',
      entries: 130,
      release: 'The.Shawshank.Redemption.1994.1080p.BluRay.x264-SPARKS',
    });
    expect(existsSync(sourcePath(ctx.config, source.file))).toBe(true);
  });

  it('picks the best-matching candidate, not the first one', async () => {
    const remote = fakeSource([
      offer('web', BASIC, {
        release: 'The.Shawshank.Redemption.1994.720p.WEB-DL.x264-OTHER',
        downloads: 900_000,
      }),
      offer('machine', BASIC, { machineTranslated: true }),
      offer('exact', LONG, { hashMatch: true, release: 'whatever' }),
    ]);
    const { job } = await request();
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    const done = await waitForJob(ctx.db, job!.id);
    expect(remote.downloads).toEqual(['exact']);
    expect(done.totalEntries).toBe(130);
    const source = await ctx.db.sourceSubtitle.findUniqueOrThrow({ where: { id: done.sourceId! } });
    expect(source.videoHash).toBe('abcdef0123456789'); // remembered as matching this exact video
  });

  it('skips a candidate that is not a real subtitle and uses the next one', async () => {
    const remote = fakeSource([
      offer('html', '<html><body>Download limit reached</body></html>', { hashMatch: true }),
      offer('zip', new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]), { downloads: 500_000 }),
      offer('good', BASIC),
    ]);
    const { job } = await request();
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    const done = await waitForJob(ctx.db, job!.id);
    expect(done.state).toBe('completed');
    expect(remote.downloads).toEqual(['html', 'zip', 'good']);
    expect(await ctx.db.sourceSubtitle.count()).toBe(1); // the invalid files were never stored
  });

  it('fails visibly when no source subtitle exists, and does not search again right away', async () => {
    const remote = fakeSource([]);
    const first = await request();
    const worker = await createWorker(ctx, mock(), { sources: [remote.source] });
    worker.start();
    const failed = await waitForJob(ctx.db, first.job!.id);
    expect(failed).toMatchObject({
      state: 'failed',
      errorCode: 'source_not_found',
      errorStage: 'locating_source',
      percentage: 0,
    });
    expect(failed.errorMessage).toContain('No source subtitle was found (languages: en)');
    expect((await listNotifications(ctx.db)).map((n) => n.kind)).toEqual(['failed']);

    // Stremio asks again on the next play: no new job, no new search, no second notification.
    const again = await request();
    expect(again.status).toBe('failed');
    expect(again.job?.id).toBe(first.job!.id);
    await sleep(200);
    expect(remote.searches).toHaveLength(1);
    expect(await ctx.db.translationJob.count()).toBe(1);

    // After the waiting period (or when forced) it is tried again.
    const later = await requestMediaTranslation(
      ctx.db,
      ctx.config,
      { query: MOVIE, targetLanguage: 'sr-Latn' },
      new Date(Date.now() + 31 * 60_000),
    );
    expect(later.status).toBe('created');
    expect(later.job?.id).not.toBe(first.job!.id);
  });

  it('fails when every candidate is unusable', async () => {
    const remote = fakeSource([
      offer('a', 'not a subtitle'),
      offer('b', '1\n00:00:01,000 --> 00:00:02,000\nToo short\n'),
    ]);
    const { job } = await request();
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    const failed = await waitForJob(ctx.db, job!.id);
    expect(failed).toMatchObject({
      state: 'failed',
      errorCode: 'source_invalid',
      errorStage: 'downloading_source',
    });
    expect(failed.errorMessage).toContain('No usable source subtitle could be obtained');
    expect(await ctx.db.sourceSubtitle.count()).toBe(0);
  });

  it.each([
    ['quota', 'source_quota'],
    ['auth', 'source_auth'],
    ['unavailable', 'source_unavailable'],
  ] as const)('reports a source "%s" problem as what it is', async (kind, code) => {
    const remote = fakeSource([], {
      searchError: new SourceError('opensubtitles', kind, `simulated ${kind}`),
    });
    const { job } = await request();
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    const failed = await waitForJob(ctx.db, job!.id);
    expect(failed).toMatchObject({
      state: 'failed',
      errorCode: code,
      errorStage: 'locating_source',
    });
  });

  it('reports a download quota problem instead of calling the subtitle invalid', async () => {
    const remote = fakeSource([offer('1', BASIC)], {
      downloadError: new SourceError(
        'opensubtitles',
        'quota',
        'The OpenSubtitles download quota is used up.',
      ),
    });
    const { job } = await request();
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    const failed = await waitForJob(ctx.db, job!.id);
    expect(failed).toMatchObject({ errorCode: 'source_quota', errorStage: 'downloading_source' });
  });

  it('never uses a subtitle in the target language as the source', async () => {
    const remote = fakeSource([
      offer('serbian', BASIC, { language: 'sr', hashMatch: true }),
      offer('english', LONG),
    ]);
    const { job } = await request({ sourceLanguages: ['en', 'sr-Latn'] });
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    await waitForJob(ctx.db, job!.id);
    expect(remote.downloads).toEqual(['english']);
  });

  it('detects the script of a Serbian source from its content', async () => {
    const remote = fakeSource([
      offer(
        'cyr',
        fixtureText('cyrillic-source.srt') + '\n4\n00:00:15,000 --> 00:00:16,000\nХвала.\n',
        { language: 'sr' },
      ),
    ]);
    const { job } = await request({ targetLanguage: 'en', sourceLanguages: ['sr-Latn'] });
    (
      await createWorker(
        ctx,
        mock({ translate: (text) => text.replace(/[\u0400-\u04FF]+/g, 'word') }),
        {
          sources: [remote.source],
        },
      )
    ).start();
    const done = await waitForJob(ctx.db, job!.id);
    expect(done).toMatchObject({ state: 'completed', sourceLanguage: 'sr-Cyrl' });
  });

  it('uses a source the owner picked by hand without searching', async () => {
    const remote = fakeSource([offer('first', BASIC, { hashMatch: true }), offer('chosen', LONG)]);
    const { job } = await request({
      pinned: { source: 'opensubtitles', id: 'chosen', language: 'en', hashMatch: false },
    });
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    const done = await waitForJob(ctx.db, job!.id);
    expect(done.state).toBe('completed');
    expect(remote.searches).toHaveLength(0);
    expect(remote.downloads).toEqual(['chosen']);
  });

  it('handles an episode request and names the job after it', async () => {
    const remote = fakeSource([
      offer('ep', BASIC, { season: 2, episode: 5 }),
      offer('other', LONG, { season: 2, episode: 6, hashMatch: true }),
    ]);
    const { job } = await request({ query: EPISODE });
    expect(job).toMatchObject({
      mediaTitle: 'Breaking Bad S02E05',
      mediaType: 'series',
      season: 2,
      episode: 5,
    });
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    await waitForJob(ctx.db, job!.id);
    expect(remote.downloads).toEqual(['ep']); // the subtitle for another episode is never used
  });

  it('rejects incomplete or invalid media requests before a job exists', async () => {
    await expect(request({ query: { type: 'movie' } })).rejects.toThrow(JobRequestError);
    await expect(request({ query: { type: 'series', imdbId: 'tt0903747' } })).rejects.toThrow(
      /season and an episode/,
    );
    await expect(request({ targetLanguage: 'bs' })).rejects.toMatchObject({
      code: 'unsupported_language',
    });
    await expect(request({ profile: 'custom' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(await ctx.db.translationJob.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('local source — the owner’s uploads', () => {
  it('prefers an uploaded subtitle for the title over a downloaded one', async () => {
    // The owner uploads a subtitle for this movie (translated into Croatian here).
    const upload = await submit(ctx, {
      srt: BASIC,
      targetLanguage: 'hr',
      imdbId: 'tt0111161',
      mediaType: 'movie',
      sourceLanguage: 'en',
    });
    const worker = await createWorker(ctx, mock());
    worker.start();
    await waitForJob(ctx.db, upload.job.id);
    await worker.stop();

    const remote = fakeSource([offer('remote', LONG, { hashMatch: true, downloads: 1_000_000 })]);
    const { job } = await request();
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    const done = await waitForJob(ctx.db, job!.id);

    expect(done).toMatchObject({
      state: 'completed',
      totalEntries: 12,
      sourceId: upload.job.sourceId,
    });
    expect(remote.downloads).toEqual([]); // nothing was downloaded
    expect(await ctx.db.sourceSubtitle.count()).toBe(1);
  });

  it('works with uploads only, when no remote source is configured', async () => {
    await storeSource(ctx.db, ctx.config, {
      srt: BASIC,
      entries: parseSrt(BASIC).entries,
      provider: 'upload',
      imdbId: 'tt0903747',
      season: 2,
      episode: 5,
      mediaType: 'series',
    });
    const { job } = await request({ query: EPISODE });
    (await createWorker(ctx, mock())).start();
    expect((await waitForJob(ctx.db, job!.id)).state).toBe('completed');

    // Another episode has no upload: nothing is found.
    const other = await request({ query: { ...EPISODE, episode: 6 } });
    expect((await waitForJob(ctx.db, other.job!.id)).errorCode).toBe('source_not_found');
  });

  it('stores identical content once, whatever its encoding or origin', async () => {
    const entries = parseSrt(BASIC).entries;
    const a = await storeSource(ctx.db, ctx.config, {
      srt: BASIC,
      entries,
      provider: 'opensubtitles',
      externalId: '9',
    });
    const b = await storeSource(ctx.db, ctx.config, {
      srt: '﻿' + BASIC.replace(/\n/g, '\r\n'),
      entries: parseSrt('﻿' + BASIC.replace(/\n/g, '\r\n')).entries,
      provider: 'upload',
      imdbId: 'tt0111161',
      language: 'en',
    });
    expect(b.id).toBe(a.id);
    expect(await ctx.db.sourceSubtitle.count()).toBe(1);
    // Details that were unknown are filled in; an upload makes it part of the owner's library.
    expect(b).toMatchObject({
      provider: 'upload',
      imdbId: 'tt0111161',
      language: 'en',
      externalId: '9',
    });
  });
});

// ---------------------------------------------------------------------------
describe('duplicate prevention for media requests', () => {
  it('creates one job for simultaneous identical requests', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => request()));
    expect(results.filter((r) => r.status === 'created')).toHaveLength(1);
    expect(new Set(results.map((r) => r.job?.id)).size).toBe(1);
    expect(await ctx.db.translationJob.count()).toBe(1);
  });

  it('finds the running job again after its source is known', async () => {
    const remote = fakeSource([offer('1', LONG)]);
    const first = await request();
    (await createWorker(ctx, mock({ delayMs: 80 }), { sources: [remote.source] })).start();
    await waitForJob(ctx.db, first.job!.id, { until: (j) => j.state === 'translating' });

    const again = await request();
    expect(again).toMatchObject({ status: 'active' });
    expect(again.job?.id).toBe(first.job!.id);
    expect(remote.searches).toHaveLength(1);
  });

  it('treats another target language, video file or profile as a different request', async () => {
    const a = await request();
    const b = await request({ targetLanguage: 'sr-Cyrl' });
    const c = await request({ query: { ...MOVIE, videoHash: '1111111111111111' } });
    const d = await request({ profile: 'literal' });
    expect(new Set([a, b, c, d].map((r) => r.job?.id)).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
describe('translation cache', () => {
  async function translateOnce(sources: SubtitleSource[]) {
    const { job } = await request();
    const translator = mock();
    const worker = await createWorker(ctx, translator, { sources });
    worker.start();
    const done = await waitForJob(ctx.db, job!.id);
    await worker.stop();
    return { done, translator };
  }

  it('answers a repeated media request from the cache: no job, no search, no AI call', async () => {
    const remote = fakeSource([offer('1', LONG)]);
    const { done } = await translateOnce([remote.source]);

    const again = await request();
    expect(again.status).toBe('cached');
    expect(again.translation).toMatchObject({
      targetLanguage: 'sr-Latn',
      targetScript: 'Latn',
      profile: 'natural',
      entries: 130,
      file: done.outputFile,
      jobId: done.id,
      sourceId: done.sourceId,
    });
    expect(again.job?.id).toBe(done.id);
    expect(await ctx.db.translationJob.count()).toBe(1);
    expect(remote.searches).toHaveLength(1);
  });

  it('stores what the spec requires with each cached translation', async () => {
    const remote = fakeSource([offer('1', LONG)]);
    const { done } = await translateOnce([remote.source]);
    const entry = await ctx.db.translation.findUniqueOrThrow({
      where: { translationKey: done.translationKey },
    });
    expect(entry.promptVersion).toBe('v1');
    expect(entry.engineVersion).toBe('1.0.0');
    expect(JSON.parse(entry.models)).toEqual([{ provider: 'mock', model: 'mock-pseudo-1' }]);
    expect(JSON.parse(entry.validation)).toMatchObject({ valid: true });
    expect(JSON.parse(entry.stats)).toMatchObject({ entries: 130, retries: 0 });
    expect(entry.sizeBytes).toBeGreaterThan(1000);
    expect(entry.createdAt).toBeInstanceOf(Date);
    // Original and translated subtitle are both on disk.
    const source = await ctx.db.sourceSubtitle.findUniqueOrThrow({ where: { id: entry.sourceId } });
    expect(existsSync(sourcePath(ctx.config, source.file))).toBe(true);
    expect(existsSync(outputPath(ctx.config, entry.file))).toBe(true);
  });

  it('reuses a translation for another video file that leads to the same subtitle', async () => {
    const remote = fakeSource([offer('1', LONG)]);
    const { done } = await translateOnce([remote.source]);

    // Same film, another rip: a new media request, but the source subtitle is identical.
    const other = await request({ query: { ...MOVIE, videoHash: '2222222222222222' } });
    expect(other.status).toBe('created');
    const translator = mock();
    (await createWorker(ctx, translator, { sources: [remote.source] })).start();
    const reused = await waitForJob(ctx.db, other.job!.id);

    expect(reused).toMatchObject({
      state: 'completed',
      percentage: 100,
      cacheHit: true,
      outputFile: done.outputFile,
    });
    expect(translator.calls).toHaveLength(0); // no AI request at all
    expect(JSON.parse(reused.usedModels!)).toEqual([{ provider: 'mock', model: 'mock-pseudo-1' }]);
    expect(
      jobEvents(await eventLog(ctx.db, reused.id)).some(
        (e) => e.job.statusDetail === 'Reusing an existing translation',
      ),
    ).toBe(true);
    expect(await ctx.db.translation.count()).toBe(1);
    // …and from now on that video is answered straight from the cache as well.
    expect((await request({ query: { ...MOVIE, videoHash: '2222222222222222' } })).status).toBe(
      'cached',
    );
  });

  it('shares the cache between uploads and media requests', async () => {
    const upload = await submit(ctx);
    const worker = await createWorker(ctx, mock());
    worker.start();
    const done = await waitForJob(ctx.db, upload.job.id);
    await worker.stop();

    const remote = fakeSource([offer('1', LONG)]);
    const { job } = await request();
    const translator = mock();
    (await createWorker(ctx, translator, { sources: [remote.source] })).start();
    const reused = await waitForJob(ctx.db, job!.id);
    expect(reused).toMatchObject({ cacheHit: true, outputFile: done.outputFile });
    expect(translator.calls).toHaveLength(0);
    // And the upload path sees the same entry.
    expect(await submit(ctx)).toMatchObject({ created: false, reason: 'completed' });
  });

  it('lets a media job wait for an identical translation that is already running, then reuse it', async () => {
    const upload = await submit(ctx);
    const slow = mock({ delayMs: 120 });
    (await createWorker(ctx, slow, { id: 'uploader' })).start();
    await waitForJob(ctx.db, upload.job.id, { until: (j) => j.state === 'translating' });

    const remote = fakeSource([offer('1', LONG)]);
    const { job } = await request();
    const second = mock();
    (
      await createWorker(ctx, second, {
        sources: [remote.source],
        id: 'follower',
        separateConnection: true,
      })
    ).start();

    const waiting = await waitForJob(ctx.db, job!.id, {
      until: (j) => j.statusDetail?.startsWith('Waiting:') === true,
    });
    expect(waiting).toMatchObject({ state: 'queued', attempt: 1, sourceId: upload.job.sourceId });

    const done = await waitForJob(ctx.db, job!.id, { timeoutMs: 30_000 });
    expect(done).toMatchObject({ state: 'completed', cacheHit: true });
    expect(second.calls).toHaveLength(0); // the subtitle was translated exactly once
    expect(remote.downloads).toEqual(['1']); // and downloaded once, despite the wait
    expect(await ctx.db.translation.count()).toBe(1);
  });

  it('does not hand out a cache entry whose file has disappeared', async () => {
    const remote = fakeSource([offer('1', LONG)]);
    const { done } = await translateOnce([remote.source]);
    rmSync(outputPath(ctx.config, done.outputFile!));

    const again = await request();
    expect(again.status).toBe('created');
    expect(await ctx.db.translation.count()).toBe(0);
    expect((await getJob(ctx.db, done.id))!.outputFile).toBeNull(); // the old job no longer claims an output
  });

  it('replaces the cached translation on a forced re-translation', async () => {
    const remote = fakeSource([offer('1', LONG)]);
    const { done } = await translateOnce([remote.source]);

    const forced = await request({ force: true });
    expect(forced.status).toBe('created');
    const translator = mock();
    (await createWorker(ctx, translator, { sources: [remote.source] })).start();
    const redone = await waitForJob(ctx.db, forced.job!.id);
    expect(redone).toMatchObject({ state: 'completed', cacheHit: false });
    expect(translator.calls.length).toBeGreaterThan(0);

    expect(await ctx.db.translation.count()).toBe(1);
    const entry = await ctx.db.translation.findFirstOrThrow();
    expect(entry).toMatchObject({ file: redone.outputFile, jobId: redone.id });
    expect(existsSync(outputPath(ctx.config, done.outputFile!))).toBe(false); // the old file is gone
    expect((await getJob(ctx.db, done.id))!.outputFile).toBe(redone.outputFile);
  });

  it('keeps Serbian Latin and Cyrillic translations of the same source apart', async () => {
    const remote = fakeSource([offer('1', BASIC)]);
    const latin = await request();
    const cyrillic = await request({ targetLanguage: 'sr-Cyrl' });
    (await createWorker(ctx, mock(), { sources: [remote.source] })).start();
    const [a, b] = await Promise.all([
      waitForJob(ctx.db, latin.job!.id),
      waitForJob(ctx.db, cyrillic.job!.id),
    ]);
    expect(a.outputFile).not.toBe(b.outputFile);
    expect(a.sourceId).toBe(b.sourceId);
    expect(containsCyrillic(readFileSync(outputPath(ctx.config, a.outputFile!), 'utf8'))).toBe(
      false,
    );
    expect(containsCyrillic(readFileSync(outputPath(ctx.config, b.outputFile!), 'utf8'))).toBe(
      true,
    );
    expect(await ctx.db.translation.count()).toBe(2);
    expect(await ctx.db.sourceSubtitle.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('cache cleanup', () => {
  const DAY = 86_400_000;

  async function seed(targets: string[]) {
    const jobs = [];
    for (const targetLanguage of targets)
      jobs.push((await submit(ctx, { targetLanguage, srt: BASIC })).job);
    const worker = await createWorker(ctx, mock());
    worker.start();
    const done = await Promise.all(jobs.map((j) => waitForJob(ctx.db, j.id)));
    await worker.stop();
    return done;
  }
  const age = (jobId: string, days: number) =>
    ctx.db.translation.updateMany({
      where: { jobId },
      data: { lastUsedAt: new Date(Date.now() - days * DAY) },
    });

  it('reports what the cache holds', async () => {
    await seed(['hr', 'de']);
    const stats = await cacheStats(ctx.db);
    expect(stats).toMatchObject({ translations: 2, sources: 1 });
    expect(stats.translationBytes).toBeGreaterThan(0);
    expect(stats.sourceBytes).toBeGreaterThan(0);
  });

  it('does nothing when no limit is configured', async () => {
    const [job] = await seed(['hr']);
    await age(job!.id, 500);
    expect(await cleanupCache(ctx.db, ctx.config)).toEqual({
      translationsRemoved: 0,
      sourcesRemoved: 0,
      bytesFreed: 0,
    });
    expect(await ctx.db.translation.count()).toBe(1);
  });

  it('removes translations that were not used for too long, and only those', async () => {
    const [old, fresh] = await seed(['hr', 'de']);
    await age(old!.id, 40);
    const result = await cleanupCache(ctx.db, ctx.config, { maxAgeDays: 30, maxSizeMb: 0 });
    expect(result.translationsRemoved).toBe(1);
    expect(result.bytesFreed).toBeGreaterThan(0);

    expect(existsSync(outputPath(ctx.config, old!.outputFile!))).toBe(false);
    expect(existsSync(outputPath(ctx.config, fresh!.outputFile!))).toBe(true);
    // The job history stays, but no longer offers a download.
    expect((await getJob(ctx.db, old!.id))!).toMatchObject({
      state: 'completed',
      outputFile: null,
    });
    expect((await getJob(ctx.db, fresh!.id))!.outputFile).not.toBeNull();
    // The same request is simply translated again when it comes back.
    expect((await submit(ctx, { targetLanguage: 'hr', srt: BASIC })).created).toBe(true);
  });

  it('removes the least recently used translations first when the cache is too large', async () => {
    const [a, b, c] = await seed(['hr', 'de', 'fr']);
    await age(a!.id, 3);
    await age(b!.id, 2);
    await age(c!.id, 1);
    const each = (await ctx.db.translation.findFirstOrThrow()).sizeBytes;
    // Room for about two of the three.
    const limitMb = (each * 2.5) / (1024 * 1024);
    const result = await cleanupCache(ctx.db, ctx.config, { maxAgeDays: 0, maxSizeMb: limitMb });
    expect(result.translationsRemoved).toBe(1);
    const left = (await ctx.db.translation.findMany()).map((t) => t.jobId).sort();
    expect(left).toEqual([b!.id, c!.id].sort());
  });

  it('never deletes files that belong to an active job', async () => {
    const remote = fakeSource([offer('1', LONG)]);
    const first = await request();
    const worker = await createWorker(ctx, mock(), { sources: [remote.source] });
    worker.start();
    const done = await waitForJob(ctx.db, first.job!.id);
    await worker.stop();
    await age(done.id, 400);

    // A new job for another language is in the middle of translating the same source.
    const running = await request({ targetLanguage: 'hr' });
    (await createWorker(ctx, mock({ delayMs: 150 }), { sources: [remote.source] })).start();
    const midway = await waitForJob(ctx.db, running.job!.id, {
      until: (j) => j.state === 'translating',
    });
    const source = await ctx.db.sourceSubtitle.findUniqueOrThrow({
      where: { id: midway.sourceId! },
    });

    const result = await cleanupCache(ctx.db, ctx.config, { maxAgeDays: 1, maxSizeMb: 0 });
    // Everything connected to the active job's source is left alone.
    expect(result).toEqual({ translationsRemoved: 0, sourcesRemoved: 0, bytesFreed: 0 });
    expect(existsSync(sourcePath(ctx.config, source.file))).toBe(true);
    expect((await waitForJob(ctx.db, running.job!.id)).state).toBe('completed');

    // Once nothing is active, the old entry can go; the fresh one stays.
    const after = await cleanupCache(ctx.db, ctx.config, { maxAgeDays: 1, maxSizeMb: 0 });
    expect(after.translationsRemoved).toBe(1);
    expect(await ctx.db.translation.count()).toBe(1);
  });

  it('removes downloaded sources nothing refers to, but keeps the owner’s uploads', async () => {
    const remote = fakeSource([offer('1', LONG)]);
    const media = await request();
    const upload = await submit(ctx, { srt: BASIC, targetLanguage: 'hr' });
    const worker = await createWorker(ctx, mock(), { sources: [remote.source] });
    worker.start();
    const [a, b] = await Promise.all([
      waitForJob(ctx.db, media.job!.id),
      waitForJob(ctx.db, upload.job.id),
    ]);
    await worker.stop();
    await age(a.id, 100);
    await age(b.id, 100);

    const result = await cleanupCache(ctx.db, ctx.config, { maxAgeDays: 30, maxSizeMb: 0 });
    expect(result).toMatchObject({ translationsRemoved: 2, sourcesRemoved: 1 });
    const left = await ctx.db.sourceSubtitle.findMany();
    expect(left.map((s) => s.provider)).toEqual(['upload']);
    expect(existsSync(sourcePath(ctx.config, left[0]!.file))).toBe(true);
    expect(await ctx.db.mediaLink.count()).toBe(0);
  });
});
