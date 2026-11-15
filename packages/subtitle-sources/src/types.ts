/** What is being watched — everything a source can use to find a matching subtitle. */
export interface MediaQuery {
  type: 'movie' | 'series';
  /** IMDb id of the movie, or of the SERIES for an episode (e.g. `tt0903747`). */
  imdbId?: string | undefined;
  title?: string | undefined;
  year?: number | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  /** OpenSubtitles-style hash of the video file (16 hex characters). */
  videoHash?: string | undefined;
  /** Size of the video file in bytes. */
  videoSize?: number | undefined;
  /** File name of the video; its release tags help pick a subtitle with matching timing. */
  fileName?: string | undefined;
}

/** A subtitle a source offers for a query. Plain data: safe to store and send to the dashboard. */
export interface SourceCandidate {
  /** Adapter id, e.g. `opensubtitles` or `library`. */
  source: string;
  /** The source's own identifier of the file. */
  id: string;
  /** Language as a registry id where unambiguous (`en`, `hr`), or the base code (`sr`). */
  language: string;
  release?: string | undefined;
  fileName?: string | undefined;
  /** Title of the movie or series as the source knows it. */
  title?: string | undefined;
  /** The source confirmed that this subtitle belongs to exactly this video file. */
  hashMatch: boolean;
  hearingImpaired?: boolean | undefined;
  /** Produced by AI or machine translation — a poor basis for another translation. */
  machineTranslated?: boolean | undefined;
  /** Contains only the foreign-language parts of the film, not the full dialogue. */
  foreignPartsOnly?: boolean | undefined;
  /** Uploaded by a trusted user of the source. */
  trusted?: boolean | undefined;
  downloads?: number | undefined;
  rating?: number | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  year?: number | undefined;
  /** Provided by the owner (uploaded), not downloaded. */
  local?: boolean | undefined;
}

export interface RankedCandidate extends SourceCandidate {
  score: number;
  /** Human-readable reasons for the score, strongest first. */
  reasons: string[];
}

export interface DownloadedSubtitle {
  bytes: Uint8Array;
  fileName?: string | undefined;
}

export interface SourceCallOptions {
  signal?: AbortSignal;
}

/**
 * A replaceable subtitle source. Implementations only talk to their backend;
 * ranking, validation, storage and caching are shared code outside.
 */
export interface SubtitleSource {
  readonly id: string;
  readonly name: string;
  /** Find subtitles for the query in any of the given languages (registry ids, preferred first). */
  search(
    query: MediaQuery,
    languages: readonly string[],
    options?: SourceCallOptions,
  ): Promise<SourceCandidate[]>;
  download(candidate: SourceCandidate, options?: SourceCallOptions): Promise<DownloadedSubtitle>;
}

export type SourceErrorKind =
  /** Missing/invalid API key or account. */
  | 'auth'
  /** Download quota used up. */
  | 'quota'
  | 'rate_limit'
  /** The source is down or unreachable. */
  | 'unavailable'
  | 'not_found'
  /** The source answered with something unusable. */
  | 'invalid_response'
  /** A download was refused for safety reasons (host, address, size, redirects). */
  | 'blocked';

export class SourceError extends Error {
  override name = 'SourceError';
  constructor(
    readonly source: string,
    readonly kind: SourceErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
