import type { AppConfig } from '@asc/config';
import type { Database } from '@asc/database';
import {
  countJobsSince,
  JobRequestError,
  requestMediaTranslation,
  toJobView,
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
export function buildManifest() {
  return {
    id: ADDON_ID,
    version: APP_VERSION,
    name: 'AI Subtitle Cloud',
    description:
      'Personal AI subtitle translator. Subtitles are translated in the background into the ' +
      'languages chosen in the dashboard; progress is shown in the dashboard.',
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

/** How long Stremio may reuse an answer in which every configured language is ready. */
const READY_CACHE_SECONDS = 300;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Path of the "translate" entry offered in Stremio's subtitle menu for one
 * language of one video. Fetching it — which Stremio does only when the viewer
 * picks that entry — is what starts the translation.
 */
export function translatePath(targetLanguage: string, type: string, id: string, query: MediaQuery) {
  const params = new URLSearchParams();
  if (query.videoHash) params.set('h', query.videoHash);
  if (query.videoSize !== undefined) params.set('s', String(query.videoSize));
  if (query.fileName) params.set('f', query.fileName);
  const search = params.toString();
  return (
    `/translate/${encodeURIComponent(targetLanguage)}/${encodeURIComponent(type)}/` +
    `${encodeURIComponent(id)}.srt${search ? `?${search}` : ''}`
  );
}

/** Reverse of translatePath's query string: the `extra` that parseVideoId understands. */
export function translateExtra(search: Record<string, unknown>): Record<string, unknown> {
  return { videoHash: search.h, videoSize: search.s, filename: search.f };
}

export type StremioRequestOutcome =
  | { kind: 'result'; result: MediaTranslationResult }
  | { kind: 'limit'; limit: number }
  | { kind: 'unavailable'; message: string };

/**
 * Look up — and when `create` is true, start — the translation of one video
 * into one language, honouring the daily limit on translations Stremio starts.
 */
export async function requestForStremio(
  db: Database,
  config: AppConfig,
  query: MediaQuery,
  targetLanguage: string,
  create: boolean,
): Promise<StremioRequestOutcome> {
  const profile = isTranslationProfileId(config.stremio.profile)
    ? config.stremio.profile
    : 'natural';
  const input = { query, targetLanguage, profile, origin: 'stremio' as const };
  try {
    // Look first, without creating anything.
    const found = await requestMediaTranslation(db, config, { ...input, create: false });
    if (found.status !== 'missing' || !create) return { kind: 'result', result: found };
    const limit = config.stremio.dailyJobLimit;
    if (limit > 0) {
      const used = await countJobsSince(db, 'stremio', new Date(Date.now() - DAY_MS));
      if (used >= limit) return { kind: 'limit', limit };
    }
    return { kind: 'result', result: await requestMediaTranslation(db, config, input) };
  } catch (err) {
    // A configuration problem (e.g. no AI key) must not break playback.
    if (err instanceof JobRequestError) return { kind: 'unavailable', message: err.message };
    throw err;
  }
}

export interface SubtitlesHandlerDeps {
  /** The configuration in effect right now (environment plus dashboard settings). */
  getConfig: () => Promise<AppConfig>;
  db: Database;
  logger?: HandlerLogger | undefined;
  /** Builds the public URL of a translated file. */
  fileUrl: (file: string) => string;
  /** Builds the public URL for a path served by the add-on (used for translate entries). */
  addonUrl: (path: string) => string;
}

/** Name shown for a target language in the translate entries. */
const languageName = (id: string) => findLanguage(id)?.name ?? id;

/**
 * The subtitles handler.
 *
 * It only reads and writes the database, so it answers in milliseconds.
 * For every configured language:
 *  - a finished translation is returned as an ordinary subtitle entry;
 *  - otherwise, in the default on-demand mode, an entry labelled
 *    "<language> · AI translate" (or "· AI 42%" while it runs) is offered. Nothing
 *    is translated until the viewer picks that entry in Stremio's subtitle menu;
 *    its label is deliberately not a language code, so Stremio never selects it
 *    automatically;
 *  - in automatic mode (STREMIO_AUTO_TRANSLATE=true, opt-in) a background job
 *    is started straight away and nothing is returned for that language.
 *
 * The Stremio protocol has no way to push progress or to announce that a
 * subtitle has become available. A translation that finishes later is picked
 * up the next time Stremio asks, which is why unfinished answers are sent
 * with `max-age=0`.
 */
export function createSubtitlesHandler(deps: SubtitlesHandlerDeps) {
  const { db, logger } = deps;

  return async (args: {
    type: string;
    id: string;
    extra?: Record<string, unknown>;
  }): Promise<SubtitlesResponse> => {
    // Read on every request, so a change in the dashboard applies to the next video opened.
    const config = await deps.getConfig();
    const query = parseVideoId(args.type, args.id, args.extra ?? {});
    const targets = stremioTargets(config);
    if (!query || targets.length === 0) return { subtitles: [], cacheMaxAge: READY_CACHE_SECONDS };
    const automatic = config.stremio.autoTranslate;

    const subtitles: StremioSubtitle[] = [];
    let ready = 0;
    for (const targetLanguage of targets) {
      const outcome = await requestForStremio(db, config, query, targetLanguage, automatic);
      if (outcome.kind === 'limit') {
        logger?.warn(
          { id: args.id, limit: outcome.limit },
          'daily limit of automatic translations reached',
        );
      } else if (outcome.kind === 'unavailable') {
        logger?.warn({ id: args.id, targetLanguage }, outcome.message);
      } else if (automatic && outcome.result.status === 'created') {
        logger?.info({ id: args.id, targetLanguage }, 'translation requested by Stremio');
      }
      const result = outcome.kind === 'result' ? outcome.result : null;

      if (result?.status === 'cached' && result.translation) {
        ready += 1;
        subtitles.push({
          id: `asc-${result.translation.id}`,
          url: deps.fileUrl(result.translation.file),
          lang: stremioLanguage(config, targetLanguage),
        });
        continue;
      }
      if (automatic) continue;

      // On demand: offer an entry that starts (or reports on) the translation when picked.
      const name = languageName(targetLanguage);
      let label = `${name} · AI translate`;
      if (result?.status === 'active' && result.job) {
        label = `${name} · AI ${Math.floor(toJobView(result.job).percentage)}%`;
      } else if (result?.status === 'failed') {
        label = `${name} · AI failed`;
      }
      subtitles.push({
        id: `asc-translate-${targetLanguage}`,
        url: deps.addonUrl(translatePath(targetLanguage, args.type, args.id, query)),
        lang: label,
      });
    }

    // While something is still missing the answer must not be cached,
    // so that the next request sees the finished subtitle.
    if (ready < targets.length) return { subtitles, cacheMaxAge: 0 };
    return { subtitles, cacheMaxAge: READY_CACHE_SECONDS, staleRevalidate: READY_CACHE_SECONDS };
  };
}

// ---------------------------------------------------------------------------
// Status "subtitle" returned when a translate entry is picked
// ---------------------------------------------------------------------------

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const srtTime = (seconds: number) =>
  `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)},000`;

/**
 * An SRT that shows `text` for ten seconds every minute for six hours, so the
 * viewer sees it whenever in the video they pick the entry. It is a status
 * message, plainly worded as one — never presented as a translation.
 */
export function statusSrt(text: string): string {
  const cues: string[] = [];
  for (let i = 0; i < 360; i += 1) {
    const start = i * 60 + 1;
    cues.push(`${i + 1}\n${srtTime(start)} --> ${srtTime(start + 10)}\n${text}\n`);
  }
  return cues.join('\n');
}

/** Status messages, in Serbian for Serbian/Croatian targets and in English otherwise. */
export function statusText(
  targetLanguage: string,
  outcome:
    | { kind: 'started' }
    | { kind: 'active'; percentage: number; etaSeconds: number | null }
    | { kind: 'failed'; message: string }
    | { kind: 'limit'; limit: number }
    | { kind: 'unavailable'; message: string },
): string {
  const sr = /^(sr|hr|bs)/.test(targetLanguage);
  const minutes = (s: number | null) => (s === null ? null : Math.max(1, Math.round(s / 60)));
  switch (outcome.kind) {
    case 'started':
      return sr
        ? 'AI prevod je pokrenut.\nKad bude gotov, ponovo otvorite video i izaberite titl.'
        : 'AI translation started.\nWhen it is finished, reopen the video and pick the subtitle.';
    case 'active': {
      const left = minutes(outcome.etaSeconds);
      const pct = Math.floor(outcome.percentage);
      return sr
        ? `AI prevod u toku: ${pct}%${left ? ` (još oko ${left} min)` : ''}.\nKad bude gotov, ponovo otvorite video.`
        : `AI translation in progress: ${pct}%${left ? ` (about ${left} min left)` : ''}.\nReopen the video when it is finished.`;
    }
    case 'failed':
      return sr
        ? `AI prevod nije uspio:\n${outcome.message}`
        : `AI translation failed:\n${outcome.message}`;
    case 'limit':
      return sr
        ? `Dostignut je dnevni limit AI prevoda (${outcome.limit}).`
        : `The daily limit of AI translations (${outcome.limit}) has been reached.`;
    case 'unavailable':
      return sr
        ? `AI prevod nije moguć:\n${outcome.message}`
        : `AI translation is not possible:\n${outcome.message}`;
  }
}
