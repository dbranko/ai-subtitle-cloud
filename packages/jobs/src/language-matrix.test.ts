/**
 * Phase 7 — movie and episode × Serbian Latin, Serbian Cyrillic and Croatian,
 * through the whole production chain with only the network replaced:
 *
 *   media request → real OpenSubtitles adapter (search, download, SSRF guard)
 *   → real worker and engine → real Claude adapter (official SDK, wire format)
 *   → validated SRT on disk → translation cache → repeated request served from it.
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anthropicStream,
  fakeHttp,
  translateFromPrompt,
  type RecordedCall,
} from '@asc/ai-providers/testing';
import { parseSrt } from '@asc/subtitle-parser';
import { createOpenSubtitlesSource, type MediaQuery } from '@asc/subtitle-sources';
import { containsCyrillic } from '@asc/translation-engine';
import { createDefaultTranslatorFactory, requestMediaTranslation, waitForJob } from './index.js';
import { outputPath } from './files.js';
import { fixtureText } from './test-fixtures.js';
import { createContext, createWorker, type TestContext } from './test-helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createContext({
    MOCK_AI: 'false',
    ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000',
    AI_PROVIDER: 'anthropic',
    AI_MAX_SEGMENT_ENTRIES: '40',
    OPENSUBTITLES_API_KEY: 'os-test-key-000000000000',
  });
});
afterEach(async () => {
  await ctx.cleanup();
});

const SOURCE = fixtureText('long-episode.srt');
const SOURCE_ENTRIES = parseSrt(SOURCE).entries;

const MOVIE: MediaQuery = {
  type: 'movie',
  imdbId: 'tt0111161',
  title: 'The Shawshank Redemption',
  year: 1994,
  videoHash: 'abcdef0123456789',
};
const EPISODE: MediaQuery = {
  type: 'series',
  imdbId: 'tt0903747',
  title: 'Breaking Bad',
  season: 2,
  episode: 5,
};

function searchResult(query: MediaQuery) {
  return {
    total_count: 1,
    data: [
      {
        id: '1',
        type: 'subtitle',
        attributes: {
          language: 'en',
          release: 'Release.1080p.WEB',
          download_count: 1000,
          hearing_impaired: false,
          ai_translated: false,
          machine_translated: false,
          from_trusted: true,
          moviehash_match: query.type === 'movie',
          feature_details: {
            year: query.year ?? null,
            season_number: query.season ?? null,
            episode_number: query.episode ?? null,
          },
          files: [{ file_id: 111, cd_number: 1, file_name: 'source.srt' }],
        },
      },
    ],
  };
}

/**
 * The internet as this test sees it: OpenSubtitles (API + file host) and Claude.
 * `script` is the alphabet the "model" answers in.
 */
function internet(query: MediaQuery, script: string) {
  const ai: RecordedCall[] = [];
  const subtitles: string[] = [];
  const http = fakeHttp((call) => {
    const url = new URL(call.url);
    if (url.hostname === 'api.anthropic.com') {
      ai.push(call);
      const prompt = (call.body.messages as { content: string }[])[0]?.content ?? '';
      return anthropicStream({ text: translateFromPrompt(prompt, script) });
    }
    subtitles.push(`${call.method} ${url.hostname}${url.pathname}`);
    if (url.pathname.endsWith('/subtitles')) return Response.json(searchResult(query));
    if (url.pathname.endsWith('/download')) {
      return Response.json({
        link: 'https://www.opensubtitles.com/download/XYZ/subfile/source.srt',
        file_name: 'source.srt',
        remaining: 19,
      });
    }
    return new Response(SOURCE);
  });
  const source = createOpenSubtitlesSource({
    apiKey: 'os-test-key-000000000000',
    userAgent: 'AISubtitleCloud test',
    maxBytes: 1_000_000,
    fetch: http.fetch,
    resolveHost: () => Promise.resolve(['93.184.216.34']),
  });
  const factory = createDefaultTranslatorFactory({ fetch: http.fetch });
  return { source, factory, ai, subtitles };
}

const CASES = [
  { name: 'movie', query: MOVIE, title: 'The Shawshank Redemption' },
  { name: 'episode', query: EPISODE, title: 'Breaking Bad S02E05' },
] as const;
const TARGETS = [
  { id: 'sr-Latn', script: 'Latn' },
  { id: 'sr-Cyrl', script: 'Cyrl' },
  { id: 'hr', script: 'Latn' },
] as const;

describe.each(CASES)('$name', ({ query, title }) => {
  it.each(TARGETS)(
    '→ $id: found, translated, stored, then served from the cache',
    async (target) => {
      const net = internet(query, target.id);
      const first = await requestMediaTranslation(ctx.db, ctx.config, {
        query,
        targetLanguage: target.id,
      });
      expect(first.status).toBe('created');
      (await createWorker(ctx, net.factory, { sources: [net.source] })).start();
      const done = await waitForJob(ctx.db, first.job!.id);

      expect(done).toMatchObject({
        state: 'completed',
        percentage: 100,
        targetLanguage: target.id,
        targetScript: target.script,
        mediaTitle: title,
      });
      // Search → download link → file, each once.
      expect(net.subtitles).toEqual([
        'GET api.opensubtitles.com/api/v1/subtitles',
        'POST api.opensubtitles.com/api/v1/download',
        'GET www.opensubtitles.com/download/XYZ/subfile/source.srt',
      ]);

      const srt = readFileSync(outputPath(ctx.config, done.outputFile!), 'utf8');
      const entries = parseSrt(srt).entries;
      // Same number of subtitles, identical timing, every one translated.
      expect(entries).toHaveLength(SOURCE_ENTRIES.length);
      entries.forEach((entry, i) => {
        const original = SOURCE_ENTRIES[i]!;
        expect([entry.startMs, entry.endMs]).toEqual([original.startMs, original.endMs]);
        expect(entry.text).not.toBe(original.text);
      });
      expect(containsCyrillic(srt)).toBe(target.script === 'Cyrl');

      // The next request for the same title is answered from the cache: no search, no AI call.
      const calls = { ai: net.ai.length, subtitles: net.subtitles.length };
      const again = await requestMediaTranslation(ctx.db, ctx.config, {
        query,
        targetLanguage: target.id,
      });
      expect(again.status).toBe('cached');
      expect(again.translation?.file).toBe(done.outputFile);
      expect({ ai: net.ai.length, subtitles: net.subtitles.length }).toEqual(calls);
      expect(await ctx.db.translationJob.count()).toBe(1);
    },
  );
});

describe('the model answers in the wrong alphabet', () => {
  it('Serbian Latin answered in Cyrillic is transliterated, not rejected', async () => {
    const net = internet(MOVIE, 'sr-Cyrl');
    const { job } = await requestMediaTranslation(ctx.db, ctx.config, {
      query: MOVIE,
      targetLanguage: 'sr-Latn',
    });
    (await createWorker(ctx, net.factory, { sources: [net.source] })).start();
    const done = await waitForJob(ctx.db, job!.id);
    expect(done.state).toBe('completed');
    expect(net.ai).toHaveLength(done.totalSegments); // no retries were needed
    const srt = readFileSync(outputPath(ctx.config, done.outputFile!), 'utf8');
    expect(containsCyrillic(srt)).toBe(false);
  });

  it('Croatian answered in Cyrillic is rejected and the job fails visibly, publishing nothing', async () => {
    const net = internet(EPISODE, 'sr-Cyrl');
    const { job } = await requestMediaTranslation(ctx.db, ctx.config, {
      query: EPISODE,
      targetLanguage: 'hr',
    });
    (await createWorker(ctx, net.factory, { sources: [net.source] })).start();
    const failed = await waitForJob(ctx.db, job!.id);
    expect(failed).toMatchObject({
      state: 'failed',
      errorCode: 'segment_failed',
      outputFile: null,
    });
    expect(net.ai).toHaveLength(3); // the first segment, three attempts, then stop
    const again = await requestMediaTranslation(ctx.db, ctx.config, {
      query: EPISODE,
      targetLanguage: 'hr',
    });
    expect(again.status).toBe('failed');
  });
});
