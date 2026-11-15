import { z } from 'zod';
import { fromProviderLanguage, toProviderLanguage } from './languages.js';
import { safeDownload } from './safe-fetch.js';
import {
  SourceError,
  type DownloadedSubtitle,
  type FetchLike,
  type MediaQuery,
  type SourceCandidate,
  type SubtitleSource,
} from './types.js';

const ID = 'opensubtitles';
const DEFAULT_BASE_URL = 'https://api.opensubtitles.com/api/v1';
/** Domains a download link returned by the API may point to. */
const DOWNLOAD_DOMAINS = ['opensubtitles.com', 'opensubtitles.org'];

export interface OpenSubtitlesOptions {
  apiKey: string;
  /** Sent with every request, as the API requires (`AppName vX.Y.Z`). */
  userAgent: string;
  /** Optional account. Logging in raises the download quota. */
  username?: string | undefined;
  password?: string | undefined;
  maxBytes: number;
  /** Test seams. */
  fetch?: FetchLike | undefined;
  resolveHost?: ((host: string) => Promise<string[]>) | undefined;
}

// Only the fields that are used are validated; the API returns many more.
const searchSchema = z.object({
  data: z.array(
    z.object({
      attributes: z.object({
        language: z.string().nullish(),
        release: z.string().nullish(),
        download_count: z.number().nullish(),
        hearing_impaired: z.boolean().nullish(),
        ai_translated: z.boolean().nullish(),
        machine_translated: z.boolean().nullish(),
        from_trusted: z.boolean().nullish(),
        foreign_parts_only: z.boolean().nullish(),
        moviehash_match: z.boolean().nullish(),
        ratings: z.number().nullish(),
        feature_details: z
          .object({
            year: z.number().nullish(),
            title: z.string().nullish(),
            movie_name: z.string().nullish(),
            parent_title: z.string().nullish(),
            season_number: z.number().nullish(),
            episode_number: z.number().nullish(),
          })
          .nullish(),
        files: z
          .array(z.object({ file_id: z.number(), file_name: z.string().nullish() }))
          .nullish(),
      }),
    }),
  ),
});
const downloadSchema = z.object({ link: z.string(), file_name: z.string().nullish() });
const loginSchema = z.object({ token: z.string() });

/** `tt0903747` → `903747` (the API takes the number without prefix and leading zeros). */
export function imdbNumber(imdbId: string): string | undefined {
  const match = /^(?:tt)?0*(\d+)$/.exec(imdbId.trim());
  return match?.[1];
}

/**
 * OpenSubtitles through its official REST API (api.opensubtitles.com). No
 * scraping: only documented endpoints, with the owner's own API key.
 */
export function createOpenSubtitlesSource(options: OpenSubtitlesOptions): SubtitleSource {
  const fetchImpl = options.fetch ?? fetch;
  let token: string | undefined;

  async function call(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal | undefined,
    authorized: boolean,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(`${DEFAULT_BASE_URL}${path}`, {
        method,
        headers: {
          'api-key': options.apiKey,
          'user-agent': options.userAgent,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(authorized && token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new SourceError(ID, 'unavailable', 'OpenSubtitles could not be reached.', {
        cause: err,
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const status = response.status;
      if (status === 401 || status === 403) {
        throw new SourceError(ID, 'auth', 'OpenSubtitles rejected the API key or account.');
      }
      if (status === 406)
        throw new SourceError(ID, 'quota', 'The OpenSubtitles download quota is used up.');
      if (status === 429)
        throw new SourceError(ID, 'rate_limit', 'OpenSubtitles is rate limiting requests.');
      if (status === 404)
        throw new SourceError(ID, 'not_found', 'OpenSubtitles did not find the requested item.');
      throw new SourceError(ID, 'unavailable', `OpenSubtitles answered with HTTP ${status}.`);
    }
    try {
      return await response.json();
    } catch (err) {
      throw new SourceError(
        ID,
        'invalid_response',
        'OpenSubtitles returned an unreadable answer.',
        { cause: err },
      );
    }
  }

  function parse<T>(schema: z.ZodType<T>, data: unknown): T {
    const result = schema.safeParse(data);
    if (!result.success) {
      throw new SourceError(ID, 'invalid_response', 'OpenSubtitles returned an unexpected answer.');
    }
    return result.data;
  }

  async function login(signal: AbortSignal | undefined): Promise<void> {
    if (!options.username || !options.password) return;
    const data = await call(
      'POST',
      '/login',
      { username: options.username, password: options.password },
      signal,
      false,
    );
    token = parse(loginSchema, data).token;
  }

  return {
    id: ID,
    name: 'OpenSubtitles',

    async search(query: MediaQuery, languages, callOptions = {}): Promise<SourceCandidate[]> {
      const params: Record<string, string> = {};
      const imdb = query.imdbId ? imdbNumber(query.imdbId) : undefined;
      const isEpisode =
        query.type === 'series' && query.season !== undefined && query.episode !== undefined;
      if (imdb && isEpisode) params.parent_imdb_id = imdb;
      else if (imdb) params.imdb_id = imdb;
      else if (query.title) {
        params.query = query.title;
        if (query.year && query.type === 'movie') params.year = String(query.year);
      } else if (!query.videoHash) {
        return [];
      }
      if (isEpisode) {
        params.season_number = String(query.season);
        params.episode_number = String(query.episode);
      }
      if (query.videoHash) params.moviehash = query.videoHash.toLowerCase();
      const codes = [...new Set(languages.map(toProviderLanguage))].sort();
      if (codes.length > 0) params.languages = codes.join(',');

      // The API asks for lower-case, alphabetically sorted parameters (anything else is redirected).
      const search = Object.keys(params)
        .sort()
        .map((k) => `${k}=${encodeURIComponent((params[k] ?? '').toLowerCase())}`)
        .join('&');
      const data = parse(
        searchSchema,
        await call('GET', `/subtitles?${search}`, undefined, callOptions.signal, false),
      );

      const candidates: SourceCandidate[] = [];
      for (const { attributes: a } of data.data) {
        const file = a.files?.[0];
        if (!file || !a.language) continue;
        candidates.push({
          source: ID,
          id: String(file.file_id),
          language: fromProviderLanguage(a.language),
          release: a.release ?? undefined,
          fileName: file.file_name ?? undefined,
          title: a.feature_details?.parent_title ?? a.feature_details?.title ?? undefined,
          hashMatch: a.moviehash_match === true,
          hearingImpaired: a.hearing_impaired ?? undefined,
          machineTranslated: a.ai_translated === true || a.machine_translated === true,
          foreignPartsOnly: a.foreign_parts_only ?? undefined,
          trusted: a.from_trusted ?? undefined,
          downloads: a.download_count ?? undefined,
          rating: a.ratings ?? undefined,
          season: a.feature_details?.season_number ?? undefined,
          episode: a.feature_details?.episode_number ?? undefined,
          year: a.feature_details?.year ?? undefined,
        });
      }
      return candidates;
    },

    async download(candidate, callOptions = {}): Promise<DownloadedSubtitle> {
      const fileId = Number(candidate.id);
      if (!Number.isInteger(fileId)) {
        throw new SourceError(ID, 'invalid_response', 'Invalid OpenSubtitles file id.');
      }
      const request = () =>
        call('POST', '/download', { file_id: fileId, sub_format: 'srt' }, callOptions.signal, true);

      if (token === undefined) await login(callOptions.signal);
      let data: unknown;
      try {
        data = await request();
      } catch (err) {
        // A stored login can expire: log in again once.
        if (!(err instanceof SourceError) || err.kind !== 'auth' || token === undefined) throw err;
        token = undefined;
        await login(callOptions.signal);
        data = await request();
      }
      const { link, file_name: fileName } = parse(downloadSchema, data);
      const bytes = await safeDownload(link, {
        source: ID,
        allowedDomains: DOWNLOAD_DOMAINS,
        maxBytes: options.maxBytes,
        signal: callOptions.signal,
        fetch: options.fetch,
        resolveHost: options.resolveHost,
      });
      return { bytes, fileName: fileName ?? candidate.fileName };
    },
  };
}
