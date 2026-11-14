import { sameLanguage } from './languages.js';
import type { MediaQuery, RankedCandidate, SourceCandidate } from './types.js';

const RESOLUTIONS = ['2160p', '1080p', '720p', '576p', '480p'];
/** Tags that say which master a release was made from — the main factor for subtitle timing. */
const ORIGINS: Record<string, string> = {
  bluray: 'bluray',
  bdrip: 'bluray',
  brrip: 'bluray',
  bdremux: 'bluray',
  remux: 'bluray',
  webrip: 'web',
  webdl: 'web',
  web: 'web',
  amzn: 'web',
  nf: 'web',
  hdtv: 'hdtv',
  pdtv: 'hdtv',
  dvdrip: 'dvd',
  dvd: 'dvd',
  hdrip: 'hdrip',
  cam: 'cam',
  ts: 'cam',
};
const CODECS: Record<string, string> = {
  x264: 'h264',
  h264: 'h264',
  avc: 'h264',
  x265: 'h265',
  h265: 'h265',
  hevc: 'h265',
  av1: 'av1',
  xvid: 'xvid',
};

export interface ReleaseInfo {
  tokens: Set<string>;
  resolution: string | undefined;
  origin: string | undefined;
  codec: string | undefined;
  /** Release group: conventionally the part after the last dash. */
  group: string | undefined;
}

/** Extract comparable release information from a file or release name. */
export function parseRelease(name: string | undefined): ReleaseInfo {
  const empty: ReleaseInfo = {
    tokens: new Set(),
    resolution: undefined,
    origin: undefined,
    codec: undefined,
    group: undefined,
  };
  if (!name) return empty;
  const base = name.replace(/\.(mkv|mp4|avi|mov|m4v|ts|srt|sub|ass)$/i, '');
  const normalized = base
    .toLowerCase()
    .replace(/web[-. ]dl/g, 'webdl')
    .replace(/blu[-. ]ray/g, 'bluray');
  const tokens = normalized.split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  const groupMatch = /-([A-Za-z0-9]{2,})(?:\[[^\]]*\])?$/.exec(base.trim());
  return {
    tokens: new Set(tokens),
    resolution: tokens.find((t) => RESOLUTIONS.includes(t)),
    origin: tokens.map((t) => ORIGINS[t]).find((o) => o !== undefined),
    codec: tokens.map((t) => CODECS[t]).find((c) => c !== undefined),
    group: groupMatch?.[1]?.toLowerCase(),
  };
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface RankingOptions {
  /** Acceptable source languages, most preferred first. */
  languages: readonly string[];
  /** Never use a source in this language (the translation target). */
  excludeLanguage?: string | undefined;
}

/** Score one candidate for a query. Higher is better; see the reasons for why. */
export function scoreCandidate(
  query: MediaQuery,
  candidate: SourceCandidate,
  options: RankingOptions,
): RankedCandidate {
  let score = 0;
  const reasons: [number, string][] = [];
  const add = (points: number, reason: string) => {
    score += points;
    reasons.push([points, reason]);
  };

  // 1. A subtitle the owner uploaded for this title is a deliberate choice: it always wins.
  if (candidate.local) add(2000, 'uploaded by you');
  // 2. An exact match on the video file outweighs every other signal: the timing is right.
  if (candidate.hashMatch) add(1000, 'matches the exact video file');

  // 3. Preferred source language.
  const rank = options.languages.findIndex((l) => sameLanguage(l, candidate.language));
  if (rank >= 0)
    add(
      Math.max(10, 100 - rank * 20),
      rank === 0 ? 'preferred source language' : 'accepted source language',
    );

  // 4. Same release = same cut and timing.
  const wanted = parseRelease(query.fileName);
  const offered = parseRelease(candidate.release ?? candidate.fileName);
  if (wanted.tokens.size > 0 && offered.tokens.size > 0) {
    if (wanted.origin && offered.origin) {
      if (wanted.origin === offered.origin) add(40, `same source type (${offered.origin})`);
      else add(-25, `different source type (${offered.origin} vs ${wanted.origin})`);
    }
    if (wanted.group && wanted.group === offered.group)
      add(25, `same release group (${offered.group})`);
    if (wanted.resolution && wanted.resolution === offered.resolution) add(8, 'same resolution');
    if (wanted.codec && wanted.codec === offered.codec) add(4, 'same codec');
    const similarity = overlap(wanted.tokens, offered.tokens);
    if (similarity > 0) add(Math.round(similarity * 20), 'similar release name');
  }

  // 5. Quality signals.
  if (candidate.machineTranslated) add(-200, 'machine translated');
  if (candidate.trusted) add(15, 'from a trusted uploader');
  if (candidate.hearingImpaired) add(-5, 'for the hearing impaired');
  if (candidate.downloads && candidate.downloads > 0) {
    add(Math.min(30, Math.round(Math.log10(candidate.downloads + 1) * 7)), 'widely used');
  }
  if (candidate.rating && candidate.rating > 0)
    add(Math.round(Math.min(10, candidate.rating)), 'well rated');

  // 6. Sanity: a clearly different year means a different film of the same name.
  if (
    query.type === 'movie' &&
    query.year &&
    candidate.year &&
    Math.abs(query.year - candidate.year) > 1
  ) {
    add(-150, `different year (${candidate.year})`);
  }

  reasons.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]));
  return { ...candidate, score, reasons: reasons.map(([, text]) => text) };
}

/** True when the candidate cannot be for this query at all. */
function mismatches(
  query: MediaQuery,
  candidate: SourceCandidate,
  options: RankingOptions,
): boolean {
  // An owner upload is there on purpose: its language need not be on the preference list,
  // and an upload whose language is unknown is always acceptable.
  if (!(candidate.local === true && candidate.language === '')) {
    if (options.excludeLanguage && sameLanguage(options.excludeLanguage, candidate.language)) {
      return true;
    }
    if (!candidate.local && !options.languages.some((l) => sameLanguage(l, candidate.language))) {
      return true;
    }
  }
  if (query.type === 'series') {
    if (
      query.season !== undefined &&
      candidate.season !== undefined &&
      candidate.season !== query.season
    )
      return true;
    if (
      query.episode !== undefined &&
      candidate.episode !== undefined &&
      candidate.episode !== query.episode
    )
      return true;
  }
  return false;
}

/**
 * Filter out candidates that cannot fit and order the rest, best first.
 * Deterministic: ties are broken by source and id.
 */
export function rankCandidates(
  query: MediaQuery,
  candidates: readonly SourceCandidate[],
  options: RankingOptions,
): RankedCandidate[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      const key = `${c.source}:${c.id}`;
      if (seen.has(key) || mismatches(query, c, options)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => scoreCandidate(query, c, options))
    .sort(
      (a, b) => b.score - a.score || a.source.localeCompare(b.source) || a.id.localeCompare(b.id),
    );
}
