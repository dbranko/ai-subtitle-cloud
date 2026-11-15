import type { AppConfig } from '@asc/config';
import type { Database } from '@asc/database';
import {
  countJobsSince,
  JobRequestError,
  requestMediaTranslation,
  type MediaTranslationResult,
} from '@asc/jobs';
import { APP_VERSION } from '@asc/shared';
import type { MediaQuery } from '@asc/subtitle-sources';
import { findLanguage, isTranslationProfileId } from '@asc/translation-engine';

/**
 * ISO 639-2 codes sent to Stremio as the subtitle `lang`. Stremio shows a
 * language name for a code it knows and the raw text otherwise.
 *
 * `srp`, `hrv` and `eng` are the same in both ISO 639-2 variants. For languages
 * where the bibliographic and terminological codes differ (German, French,
 * Dutch, Greek, Czech, …) the bibliographic code is used, as subtitle add-ons
 * traditionally do; any value can be overridden with STREMIO_LANGUAGE_LABELS.
 */
const ISO_639_2: Record<string, string> = {
  'sr-Latn': 'srp',
  'sr-Cyrl': 'srp',
  hr: 'hrv',
  en: 'eng',
  de: 'ger',
  fr: 'fre',
  es: 'spa',
  it: 'ita',
  ru: 'rus',
  pt: 'por',
  'pt-BR': 'pob',
  nl: 'dut',
  sl: 'slv',
  mk: 'mac',
  bg: 'bul',
  uk: 'ukr',
  pl: 'pol',
  cs: 'cze',
  sk: 'slo',
  hu: 'hun',
  ro: 'rum',
  el: 'gre',
  tr: 'tur',
  sv: 'swe',
  da: 'dan',
  nb: 'nor',
  fi: 'fin',
  ar: 'ara',
  he: 'heb',
  hi: 'hin',
  th: 'tha',
  ja: 'jpn',
  ko: 'kor',
  'zh-Hans': 'chi',
  'zh-Hant': 'zht',
};

/** The `lang` value Stremio receives for a target language. */
export function stremioLanguage(config: AppConfig, targetLanguage: string): string {
  return (
    config.stremio.languageLabels[targetLanguage] ??
    ISO_639_2[targetLanguage] ??
    findLanguage(targetLanguage)?.name ??
    targetLanguage
  );
}

/** Target languages from the configuration that actually exist as targets. */
export function stremioTargets(config: AppConfig): string[] {
  return config.stremio.targetLanguages
    .map((id) => findLanguage(id))
    .filter((l) => l?.target === true)
    .map((l) => (l as { id: string }).id);
}

export const ADDON_ID = 'local.ai-subtitle-cloud';

/** The add-on manifest. Declares exactly what is implemented: subtitles for IMDb movies and series. */
export function buildManifest(config: AppConfig) {
  const languages = stremioTargets(config)
    .map((id) => findLanguage(id)?.name ?? id)
    .join(', ');
  return {
    id: ADDON_ID,
    version: APP_VERSION,
    name: 'AI Subtitle Cloud',
    description:
      `Personal AI subtitle translator. Translates subtitles into: ${languages || 'no language configured'}. ` +
      'Translations are prepared in the background; progress is shown in the dashboard.',
    resources: ['subtitles' as const],
    types: ['movie' as const, 'series' as const],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
      // Shows a "Configure" button in Stremio that opens the add-on's /configure page.
      configurable: true,
      configurationRequired: false,
    },
  };
}

/**
 * Turn a Stremio video id into a media query.
 *  - movie:  `tt0111161`
 *  - series: `tt0903747:2:5` (series IMDb id, season, episode)
 * Anything else is not something this add-on can translate.
 */
export function parseVideoId(
  type: string,
  id: string,
  extra: Record<string, unknown> = {},
): MediaQuery | null {
  let query: MediaQuery;
  if (type === 'movie') {
    if (!/^tt\d{5,12}$/.test(id)) return null;
    query = { type: 'movie', imdbId: id };
  } else if (type === 'series') {
    const match = /^(tt\d{5,12}):(\d{1,4}):(\d{1,5})$/.exec(id);
    if (!match) return null;
    query = {
      type: 'series',
      imdbId: match[1],
      season: Number(match[2]),
      episode: Number(match[3]),
    };
  } else {
    return null;
  }
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
  const hash = text(extra.videoHash);
  if (hash && /^[0-9a-fA-F]{16}$/.test(hash)) query.videoHash = hash.toLowerCase();
  const size = text(extra.videoSize);
  if (size && /^\d{1,15}$/.test(size)) query.videoSize = Number(size);
  const fileName = text(extra.filename);
  if (fileName) query.fileName = fileName.slice(0, 500);
  return query;
}

export interface StremioSubtitle {
  id: string;
  url: string;
  lang: string;
}

export interface SubtitlesResponse {
  subtitles: StremioSubtitle[];
  cacheMaxAge: number;
  staleRevalidate?: number;
  staleError?: number;
}

/** The part of a logger the handler uses (satisfied by pino and by Fastify's logger). */
export interface HandlerLogger {
  info(details: object, message: string): void;
  warn(details: object, message: string): void;
}

export interface SubtitlesHandlerDeps {
  config: AppConfig;
  db: Database;
  logger?: HandlerLogger | undefined;
  /** Builds the public URL of a translated file. */
  fileUrl: (file: string) => string;
}

/** How long Stremio may reuse an answer in which every configured language is ready. */
const READY_CACHE_SECONDS = 300;
const DAY_MS = 24 * 60 * 60_000;

/**
 * The subtitles handler.
 *
 * It only reads and writes the database, so it answers in milliseconds:
 *  - a finished translation is returned as a subtitle entry;
 *  - otherwise a background job is created or reused (automatic mode) and
 *    NOTHING is returned for that language — never a placeholder, never a
 *    status text dressed up as a subtitle.
 *
 * The Stremio protocol has no way to push progress or to announce that a
 * subtitle has become available. A translation that finishes later is picked
 * up the next time Stremio asks, which is why unfinished answers are sent
 * with `max-age=0`.
 */
export function createSubtitlesHandler(deps: SubtitlesHandlerDeps) {
  const { config, db, logger } = deps;
  const profile = isTranslationProfileId(config.stremio.profile)
    ? config.stremio.profile
    : 'natural';

  return async (args: {
    type: string;
    id: string;
    extra?: Record<string, unknown>;
  }): Promise<SubtitlesResponse> => {
    const query = parseVideoId(args.type, args.id, args.extra ?? {});
    const targets = stremioTargets(config);
    if (!query || targets.length === 0) return { subtitles: [], cacheMaxAge: READY_CACHE_SECONDS };

    const subtitles: StremioSubtitle[] = [];
    let pending = false;
    for (const targetLanguage of targets) {
      let result: MediaTranslationResult;
      try {
        // Look first, without creating anything.
        result = await requestMediaTranslation(db, config, {
          query,
          targetLanguage,
          profile,
          origin: 'stremio',
          create: false,
        });
        if (result.status === 'missing' && config.stremio.autoTranslate) {
          const limit = config.stremio.dailyJobLimit;
          const used =
            limit > 0 ? await countJobsSince(db, 'stremio', new Date(Date.now() - DAY_MS)) : 0;
          if (limit > 0 && used >= limit) {
            logger?.warn({ id: args.id, limit }, 'daily limit of automatic translations reached');
          } else {
            result = await requestMediaTranslation(db, config, {
              query,
              targetLanguage,
              profile,
              origin: 'stremio',
            });
            logger?.info(
              { id: args.id, targetLanguage, status: result.status },
              'translation requested by Stremio',
            );
          }
        }
      } catch (err) {
        // A configuration problem (e.g. no AI key) must not break playback: answer without subtitles.
        if (err instanceof JobRequestError) {
          logger?.warn({ id: args.id, targetLanguage, code: err.code }, err.message);
          continue;
        }
        throw err;
      }

      if (result.status === 'cached' && result.translation) {
        subtitles.push({
          id: `asc-${result.translation.id}`,
          url: deps.fileUrl(result.translation.file),
          lang: stremioLanguage(config, targetLanguage),
        });
      } else if (result.status === 'active' || result.status === 'created') {
        pending = true;
      }
    }

    // While something is still being translated the answer must not be cached,
    // so that the next request sees the finished subtitle.
    if (pending || subtitles.length < targets.length) return { subtitles, cacheMaxAge: 0 };
    return { subtitles, cacheMaxAge: READY_CACHE_SECONDS, staleRevalidate: READY_CACHE_SECONDS };
  };
}
