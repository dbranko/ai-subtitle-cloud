import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureStorageDirs, loadConfig, type AppConfig } from '@asc/config';
import { createTestDatabase, type TestDatabase } from '@asc/database';
import { JobWorker, outputPath, waitForJob } from '@asc/jobs';
import { createLogger, type LivenessReport, type ReadinessReport } from '@asc/shared';
import { parseSrt } from '@asc/subtitle-parser';
import type { MediaQuery, SourceCandidate, SubtitleSource } from '@asc/subtitle-sources';
import { containsCyrillic, createMockTranslator } from '@asc/translation-engine';
import { buildAddonApp, manifestUrl } from './app.js';
import { parseVideoId, stremioLanguage, type SubtitlesResponse } from './stremio.js';

const FIXTURES = new URL('../../../fixtures/subtitles/', import.meta.url);
const LONG = readFileSync(new URL('long-episode.srt', FIXTURES));

let t: TestDatabase;
let config: AppConfig;
let app: FastifyInstance;
let worker: JobWorker | undefined;
let searches: { query: MediaQuery; languages: readonly string[] }[] = [];
let offers: SourceCandidate[] = [];

const remote: SubtitleSource = {
  id: 'opensubtitles',
  name: 'Fake OpenSubtitles',
  search(query, languages) {
    searches.push({ query, languages });
    return Promise.resolve(offers);
  },
  download: () => Promise.resolve({ bytes: LONG }),
};

async function start(env: Record<string, string> = {}): Promise<void> {
  searches = [];
  offers = [
    {
      source: 'opensubtitles',
      id: '1',
      language: 'en',
      hashMatch: false,
      title: 'The Shawshank Redemption',
    },
  ];
  t = await createTestDatabase();
  config = loadConfig({
    env: {
      NODE_ENV: 'test',
      MOCK_AI: 'true',
      WORKER_POLL_INTERVAL_MS: '50',
      WORKER_LEASE_MS: '500',
      ...env,
    },
    rootDir: mkdtempSync(join(tmpdir(), 'asc-addon-')),
    useEnvFile: false,
  });
  ensureStorageDirs(config);
  app = await buildAddonApp({ config, db: t.db });
}

function startWorker(delayMs = 0): JobWorker {
  worker = new JobWorker({
    db: t.db,
    config,
    workerId: `addon-test-${Math.random().toString(36).slice(2)}`,
    createTranslator: () => createMockTranslator({ delayMs }),
    sources: [remote],
    logger: createLogger('worker', 'silent'),
  });
  worker.start();
  return worker;
}

beforeEach(() => start());
afterEach(async () => {
  await worker?.kill();
  worker = undefined;
  await app.close();
  await t.cleanup();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });
const subtitles = async (path: string) => {
  const res = await get(path);
  return { res, body: res.json<SubtitlesResponse>() };
};
const MOVIE = '/subtitles/movie/tt0111161.json';
/** Wait until every job that exists has finished. */
async function allJobsDone(): Promise<void> {
  for (const job of await t.db.translationJob.findMany()) await waitForJob(t.db, job.id);
}

describe('health', () => {
  it('reports liveness and readiness', async () => {
    expect((await get('/health')).json<LivenessReport>()).toMatchObject({
      status: 'ok',
      service: 'addon',
    });
    const ready = await get('/health/ready');
    expect(ready.statusCode).toBe(200);
    expect(ready.json<ReadinessReport>().status).toBe('ok');
  });
});

describe('manifest', () => {
  it('is served by the official SDK router with CORS enabled', async () => {
    const res = await get('/manifest.json', { origin: 'https://web.stremio.com' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.json()).toEqual({
      id: 'local.ai-subtitle-cloud',
      version: '0.1.0',
      name: 'AI Subtitle Cloud',
      description: expect.stringContaining('Translates subtitles into: Serbian (Latin).') as string,
      resources: ['subtitles'],
      types: ['movie', 'series'],
      idPrefixes: ['tt'],
      catalogs: [],
      behaviorHints: { configurable: true, configurationRequired: false },
    });
  });

  it('declares only what is implemented and promises no in-player progress', async () => {
    const manifest = (await get('/manifest.json')).json<{
      resources: string[];
      description: string;
    }>();
    expect(manifest.resources).toEqual(['subtitles']);
    expect(manifest.description).toContain('progress is shown in the dashboard');
    // Resources this add-on does not provide are not routed.
    expect((await get('/stream/movie/tt0111161.json')).statusCode).toBe(404);
    expect((await get('/catalog/movie/top.json')).statusCode).toBe(404);
  });

  it('lists the configured target languages', async () => {
    await app.close();
    await t.cleanup();
    await start({ STREMIO_TARGET_LANGUAGES: 'sr-Latn, sr-Cyrl,hr, bs, nonsense' });
    const manifest = (await get('/manifest.json')).json<{ description: string }>();
    // Bosnian is not a target and unknown ids are ignored.
    expect(manifest.description).toContain(
      'Translates subtitles into: Serbian (Latin), Serbian (Cyrillic), Croatian.',
    );
  });
});

describe('video ids and language codes', () => {
  it('parses movie and series ids as Stremio sends them', () => {
    expect(parseVideoId('movie', 'tt0111161')).toEqual({ type: 'movie', imdbId: 'tt0111161' });
    expect(parseVideoId('series', 'tt0903747:2:5')).toEqual({
      type: 'series',
      imdbId: 'tt0903747',
      season: 2,
      episode: 5,
    });
    expect(
      parseVideoId('movie', 'tt0111161', {
        videoHash: 'ABCDEF0123456789',
        videoSize: '1234567890',
        filename: 'Movie.1994.1080p.BluRay.mkv',
      }),
    ).toEqual({
      type: 'movie',
      imdbId: 'tt0111161',
      videoHash: 'abcdef0123456789',
      videoSize: 1234567890,
      fileName: 'Movie.1994.1080p.BluRay.mkv',
    });
  });

  it('ignores ids it cannot translate and malformed extras', () => {
    expect(parseVideoId('movie', 'kitsu:1234')).toBeNull();
    expect(parseVideoId('series', 'tt0903747')).toBeNull();
    expect(parseVideoId('series', 'tt0903747:2')).toBeNull();
    expect(parseVideoId('channel', 'tt0111161')).toBeNull();
    expect(parseVideoId('movie', 'tt0111161/../../etc')).toBeNull();
    expect(
      parseVideoId('movie', 'tt0111161', { videoHash: 'not-a-hash', videoSize: 'big' }),
    ).toEqual({
      type: 'movie',
      imdbId: 'tt0111161',
    });
  });

  it('sends ISO 639-2 language codes, with owner overrides', () => {
    expect(stremioLanguage(config, 'sr-Latn')).toBe('srp');
    expect(stremioLanguage(config, 'sr-Cyrl')).toBe('srp');
    expect(stremioLanguage(config, 'hr')).toBe('hrv');
    expect(stremioLanguage(config, 'en')).toBe('eng');
    const custom = loadConfig({
      env: { STREMIO_LANGUAGE_LABELS: 'sr-Cyrl=Српски (ћирилица), de=deu' },
      rootDir: config.rootDir,
      useEnvFile: false,
    });
    expect(stremioLanguage(custom, 'sr-Cyrl')).toBe('Српски (ћирилица)');
    expect(stremioLanguage(custom, 'de')).toBe('deu');
    expect(stremioLanguage(custom, 'sr-Latn')).toBe('srp');
  });
});

describe('subtitles handler — asynchronous behaviour', () => {
  it('answers at once with no subtitle and starts a background job', async () => {
    const started = Date.now();
    const { res, body } = await subtitles(MOVIE);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    // Nothing is ready: an honest empty list, not a placeholder or a status text.
    expect(body).toEqual({ subtitles: [], cacheMaxAge: 0 });
    // …and the answer must not be cached, so the next request can see the result.
    expect(res.headers['cache-control']).toBe('max-age=0, public');

    const jobs = await t.db.translationJob.findMany();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      state: 'queued',
      origin: 'stremio',
      imdbId: 'tt0111161',
      mediaType: 'movie',
      targetLanguage: 'sr-Latn',
    });
    // The request itself did not search or translate anything.
    expect(searches).toHaveLength(0);
  });

  it('never blocks on a slow translation', async () => {
    startWorker(400); // each segment takes 400 ms
    await subtitles(MOVIE);
    const job = (await t.db.translationJob.findFirstOrThrow()).id;
    await waitForJob(t.db, job, { until: (j) => j.state === 'translating' });

    const started = Date.now();
    const { body } = await subtitles(MOVIE);
    expect(Date.now() - started).toBeLessThan(300);
    expect(body).toEqual({ subtitles: [], cacheMaxAge: 0 });
  });

  it('does not create a second job when Stremio asks again', async () => {
    await Promise.all(Array.from({ length: 5 }, () => subtitles(MOVIE)));
    await subtitles(MOVIE);
    expect(await t.db.translationJob.count()).toBe(1);
  });

  it('returns the finished translation on the next request', async () => {
    await subtitles(MOVIE);
    startWorker();
    await allJobsDone();

    const { res, body } = await subtitles(MOVIE);
    expect(body.subtitles).toHaveLength(1);
    const [subtitle] = body.subtitles;
    expect(subtitle).toMatchObject({ lang: 'srp' });
    expect(subtitle?.id).toMatch(/^asc-[0-9a-f-]{36}$/);
    expect(subtitle?.url).toMatch(
      /^http:\/\/127\.0\.0\.1:7000\/files\/[0-9a-f-]{36}\.sr-Latn\.srt$/,
    );
    expect(body.cacheMaxAge).toBe(300);
    expect(res.headers['cache-control']).toBe('max-age=300, stale-while-revalidate=300, public');

    // Asking again changes nothing: same stable id and URL, no new job, no new search.
    const again = await subtitles(MOVIE);
    expect(again.body.subtitles).toEqual(body.subtitles);
    expect(await t.db.translationJob.count()).toBe(1);
    expect(searches).toHaveLength(1);
  });

  it('passes the video hash, size and file name to the source search', async () => {
    await subtitles(
      '/subtitles/movie/tt0111161/videoHash=ABCDEF0123456789&videoSize=735234&filename=The.Movie.1994.1080p.BluRay.x264-GRP.mkv.json',
    );
    startWorker();
    await allJobsDone();
    expect(searches[0]?.query).toEqual({
      type: 'movie',
      imdbId: 'tt0111161',
      videoHash: 'abcdef0123456789',
      videoSize: 735234,
      fileName: 'The.Movie.1994.1080p.BluRay.x264-GRP.mkv',
    });
    // The title Stremio did not send is taken from the source.
    expect((await t.db.translationJob.findFirstOrThrow()).mediaTitle).toBe(
      'The Shawshank Redemption',
    );
  });

  it('handles series episodes', async () => {
    offers = [
      {
        source: 'opensubtitles',
        id: '1',
        language: 'en',
        hashMatch: false,
        title: 'Breaking Bad',
        season: 2,
        episode: 5,
      },
    ];
    const { body } = await subtitles('/subtitles/series/tt0903747:2:5.json');
    expect(body.subtitles).toEqual([]);
    startWorker();
    await allJobsDone();
    const job = await t.db.translationJob.findFirstOrThrow();
    expect(job).toMatchObject({
      state: 'completed',
      mediaType: 'series',
      season: 2,
      episode: 5,
      mediaTitle: 'Breaking Bad S02E05',
    });
    expect(searches[0]?.query).toMatchObject({
      type: 'series',
      imdbId: 'tt0903747',
      season: 2,
      episode: 5,
    });
    expect((await subtitles('/subtitles/series/tt0903747:2:5.json')).body.subtitles).toHaveLength(
      1,
    );
    // Another episode is a different request.
    expect((await subtitles('/subtitles/series/tt0903747:2:6.json')).body.subtitles).toEqual([]);
    expect(await t.db.translationJob.count()).toBe(2);
  });

  it('answers ids it cannot handle with an empty list and no job', async () => {
    for (const path of [
      '/subtitles/movie/kitsu:123.json',
      '/subtitles/series/tt0903747.json',
      '/subtitles/channel/tt0111161.json',
    ]) {
      const { res, body } = await subtitles(path);
      expect(res.statusCode, path).toBe(200);
      expect(body.subtitles).toEqual([]);
    }
    expect(await t.db.translationJob.count()).toBe(0);
  });

  it('reports a failed search as "no subtitles" and does not retry on every play', async () => {
    offers = [];
    await subtitles(MOVIE);
    startWorker();
    await allJobsDone();
    expect((await t.db.translationJob.findFirstOrThrow()).errorCode).toBe('source_not_found');
    for (let i = 0; i < 3; i++) expect((await subtitles(MOVIE)).body.subtitles).toEqual([]);
    expect(await t.db.translationJob.count()).toBe(1);
    expect(searches).toHaveLength(1);
  });
});

describe('subtitles handler — languages and modes', () => {
  it('offers every configured language and reports the answer complete only when all are ready', async () => {
    await app.close();
    await t.cleanup();
    await start({
      STREMIO_TARGET_LANGUAGES: 'sr-Latn,sr-Cyrl,hr',
      STREMIO_LANGUAGE_LABELS: 'sr-Cyrl=Српски (ћирилица)',
    });
    await subtitles(MOVIE);
    expect((await t.db.translationJob.findMany()).map((j) => j.targetLanguage).sort()).toEqual([
      'hr',
      'sr-Cyrl',
      'sr-Latn',
    ]);

    startWorker();
    await allJobsDone();
    const { body } = await subtitles(MOVIE);
    expect(body.subtitles.map((s) => s.lang)).toEqual(['srp', 'Српски (ћирилица)', 'hrv']);
    expect(new Set(body.subtitles.map((s) => s.id)).size).toBe(3);
    expect(body.cacheMaxAge).toBe(300);
    // One source subtitle served all three languages.
    expect(searches).toHaveLength(3);
    expect(await t.db.sourceSubtitle.count()).toBe(1);
  });

  it('returns the ready languages while another is still being translated', async () => {
    await subtitles(MOVIE);
    startWorker();
    await allJobsDone();
    await worker?.kill();
    worker = undefined;

    await app.close();
    const both = loadConfig({
      env: { NODE_ENV: 'test', MOCK_AI: 'true', STREMIO_TARGET_LANGUAGES: 'sr-Latn,hr' },
      rootDir: config.rootDir,
      useEnvFile: false,
    });
    app = await buildAddonApp({ config: both, db: t.db });
    const { body } = await subtitles(MOVIE);
    expect(body.subtitles.map((s) => s.lang)).toEqual(['srp']);
    expect(body.cacheMaxAge).toBe(0); // Croatian is on its way: do not cache this answer
    expect(await t.db.translationJob.count({ where: { targetLanguage: 'hr' } })).toBe(1);
  });

  it('in manual mode serves existing translations but never starts one', async () => {
    await app.close();
    await t.cleanup();
    await start({ STREMIO_AUTO_TRANSLATE: 'false' });
    expect((await subtitles(MOVIE)).body).toEqual({ subtitles: [], cacheMaxAge: 0 });
    expect(await t.db.translationJob.count()).toBe(0);
  });

  it('stops starting translations when the daily limit is reached', async () => {
    await app.close();
    await t.cleanup();
    await start({ STREMIO_DAILY_JOB_LIMIT: '2' });
    for (const id of ['tt0000001', 'tt0000002', 'tt0000003', 'tt0000004']) {
      expect((await subtitles(`/subtitles/movie/${id}.json`)).res.statusCode).toBe(200);
    }
    expect(await t.db.translationJob.count()).toBe(2);
    // Titles that already have a job are still answered.
    expect((await subtitles('/subtitles/movie/tt0000001.json')).body.subtitles).toEqual([]);
    expect(await t.db.translationJob.count()).toBe(2);
  });

  it('does not fail playback when no AI provider is configured', async () => {
    await app.close();
    await t.cleanup();
    await start({ MOCK_AI: 'false' });
    const { res, body } = await subtitles(MOVIE);
    expect(res.statusCode).toBe(200);
    expect(body.subtitles).toEqual([]);
    expect(await t.db.translationJob.count()).toBe(0);
  });
});

describe('translated subtitle files', () => {
  async function ready(): Promise<string> {
    await subtitles(MOVIE);
    startWorker();
    await allJobsDone();
    const url = (await subtitles(MOVIE)).body.subtitles[0]!.url;
    return new URL(url).pathname;
  }

  it('serves a real, valid SRT file with the headers a player needs', async () => {
    const path = await ready();
    const res = await get(path, { origin: 'https://web.stremio.com' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-subrip; charset=utf-8');
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['cache-control']).toBe('public, max-age=86400');

    const parsed = parseSrt(res.body);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.entries).toHaveLength(130);
    expect(containsCyrillic(res.body)).toBe(false);
    expect(res.body).not.toMatch(/translating|progress|please wait/i);
  });

  it('serves nothing but finished translations', async () => {
    const path = await ready();
    const name = path.split('/').pop()!;
    for (const bad of [
      '/files/../../etc/passwd',
      '/files/..%2F..%2Fdb%2Fasc.sqlite',
      '/files/asc.sqlite',
      `/files/${name}.bak`,
      '/files/00000000-0000-0000-0000-000000000000.sr-Latn.srt',
      '/files/',
    ]) {
      expect((await get(bad)).statusCode, bad).toBe(404);
    }
    // A file that exists on disk but is not a known translation is not served either.
    const job = await t.db.translationJob.findFirstOrThrow();
    await t.db.translation.deleteMany();
    expect((await get(path)).statusCode).toBe(404);
    expect(job.outputFile).toBe(name);
  });

  it('stops offering a subtitle whose file is gone and prepares it again', async () => {
    const path = await ready();
    await worker?.kill();
    worker = undefined;
    const job = await t.db.translationJob.findFirstOrThrow();
    rmSync(outputPath(config, job.outputFile!));

    expect((await get(path)).statusCode).toBe(404);
    const { body } = await subtitles(MOVIE);
    expect(body).toEqual({ subtitles: [], cacheMaxAge: 0 }); // never a link to a missing file
    expect(await t.db.translationJob.count()).toBe(2);
  });

  it('counts serving a file as using the cached translation', async () => {
    const path = await ready();
    await t.db.translation.updateMany({ data: { lastUsedAt: new Date(0) } });
    await get(path);
    expect((await t.db.translation.findFirstOrThrow()).lastUsedAt.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });
});

describe('owner pages', () => {
  it('shows an install link and points to the dashboard for progress', async () => {
    const res = await get('/');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('stremio://127.0.0.1:7000/manifest.json');
    expect(res.body).toContain('http://127.0.0.1:7000/manifest.json');
    expect(res.body).toContain('href="http://127.0.0.1:7001"');
    expect(res.body).toContain('Serbian (Latin)');
  });

  it('sends Stremio’s Configure button to the dashboard', async () => {
    const res = await get('/configure');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('http://127.0.0.1:7001');
  });

  it('uses the configured public addresses', async () => {
    await app.close();
    await t.cleanup();
    await start({
      ADDON_PUBLIC_URL: 'https://subs.example.org/',
      DASHBOARD_PUBLIC_URL: 'https://dash.example.org',
    });
    expect(manifestUrl(config)).toBe('https://subs.example.org/manifest.json');
    expect((await get('/')).body).toContain('stremio://subs.example.org/manifest.json');
    await subtitles(MOVIE);
    startWorker();
    await allJobsDone();
    expect((await subtitles(MOVIE)).body.subtitles[0]?.url).toMatch(
      /^https:\/\/subs\.example\.org\/files\//,
    );
  });
});

describe('access token', () => {
  const TOKEN = 'a-long-enough-addon-token-0123456789';
  beforeEach(async () => {
    await app.close();
    await t.cleanup();
    await start({ AUTH_TOKEN: TOKEN, ADDON_PUBLIC_URL: 'https://subs.example.org' });
  });

  it('refuses every add-on route without the token in the address', async () => {
    for (const path of [
      '/manifest.json',
      MOVIE,
      '/files/x.sr-Latn.srt',
      '/',
      '/configure',
      '/wrong-token/manifest.json',
    ]) {
      expect((await get(path)).statusCode, path).toBe(401);
    }
    expect(await t.db.translationJob.count()).toBe(0);
    // Health stays open for Docker.
    expect((await get('/health')).statusCode).toBe(200);
  });

  it('serves the add-on under the token path and puts the token into subtitle URLs', async () => {
    expect(manifestUrl(config)).toBe(`https://subs.example.org/${TOKEN}/manifest.json`);
    const manifest = await get(`/${TOKEN}/manifest.json`);
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json<{ id: string }>().id).toBe('local.ai-subtitle-cloud');
    expect((await get(`/${TOKEN}`)).statusCode).toBe(200);
    expect((await get(`/${TOKEN}/`)).body).toContain(
      `stremio://subs.example.org/${TOKEN}/manifest.json`,
    );

    await subtitles(`/${TOKEN}${MOVIE}`);
    startWorker();
    await allJobsDone();
    const url = (await subtitles(`/${TOKEN}${MOVIE}`)).body.subtitles[0]!.url;
    expect(url.startsWith(`https://subs.example.org/${TOKEN}/files/`)).toBe(true);
    const file = await get(new URL(url).pathname);
    expect(file.statusCode).toBe(200);
    expect(parseSrt(file.body).entries).toHaveLength(130);
    // The same file without the token is refused.
    expect((await get(new URL(url).pathname.replace(`/${TOKEN}`, ''))).statusCode).toBe(401);
  });
});

describe('as a Stremio client sees it (real HTTP)', () => {
  it('manifest → subtitles (empty) → subtitles (ready) → download', async () => {
    await app.close();
    await t.cleanup();
    await start();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const manifest = await fetch(`${base}/manifest.json`);
    expect(manifest.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await manifest.json()) as { resources: string[] }).resources).toEqual(['subtitles']);

    // Stremio URL-encodes the extra properties into the path.
    const extra = `videoHash=abcdef0123456789&videoSize=1234&filename=${encodeURIComponent('Some Movie (1994) [1080p].mkv')}`;
    const path = `/subtitles/movie/tt0111161/${extra}.json`;
    const first = (await (await fetch(base + path)).json()) as SubtitlesResponse;
    expect(first.subtitles).toEqual([]);

    startWorker();
    await allJobsDone();
    expect(searches[0]?.query.fileName).toBe('Some Movie (1994) [1080p].mkv');

    const second = (await (await fetch(base + path)).json()) as SubtitlesResponse;
    expect(second.subtitles).toHaveLength(1);
    // The URL Stremio would load points at the configured public address; fetch it from this server.
    const file = await fetch(base + new URL(second.subtitles[0]!.url).pathname);
    expect(file.status).toBe(200);
    expect(parseSrt(await file.text()).entries).toHaveLength(130);
  });
});
