import { createHash } from 'node:crypto';
import { serializeSrt, type SubtitleEntry } from '@asc/subtitle-parser';
import { ENGINE_VERSION, PROMPT_VERSION } from '@asc/translation-engine';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/**
 * Hash of the subtitle's CONTENT, independent of encoding, BOM and line
 * endings: the same subtitle uploaded as Windows-1250 with CRLF and as UTF-8
 * with LF is the same source.
 */
export function hashSource(entries: readonly SubtitleEntry[]): string {
  return sha256(serializeSrt(entries, { bom: false, newline: '\n' }));
}

export interface TranslationKeyInput {
  sourceHash: string;
  targetLanguage: string;
  targetScript: string;
  profile: string;
  customInstructions?: string | undefined;
}

/**
 * Unique key of a translation request. Two requests with the same key would
 * produce the same translation, so they share one job (and later one cache
 * entry). Provider and model are deliberately not part of it.
 */
export function computeTranslationKey(input: TranslationKeyInput): string {
  return sha256(
    JSON.stringify([
      input.sourceHash,
      input.targetLanguage,
      input.targetScript,
      input.profile,
      (input.customInstructions ?? '').trim(),
      PROMPT_VERSION,
      ENGINE_VERSION,
    ]),
  );
}

export interface MediaKeyInput {
  type: string;
  imdbId?: string | undefined;
  title?: string | undefined;
  year?: number | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  videoHash?: string | undefined;
  /** A source the owner picked by hand, if any. */
  pinned?: string | undefined;
  targetLanguage: string;
  targetScript: string;
  profile: string;
  customInstructions?: string | undefined;
}

/**
 * Key of a media request: "this title/episode, for this video file, into this
 * language". Used before the source subtitle is known — to recognise repeated
 * requests (Stremio asks again on every play) and to find the cached result.
 */
export function computeMediaKey(input: MediaKeyInput): string {
  return sha256(
    JSON.stringify([
      input.type,
      (input.imdbId ?? '').toLowerCase(),
      input.imdbId ? '' : (input.title ?? '').trim().toLowerCase(),
      input.imdbId ? '' : (input.year ?? ''),
      input.season ?? '',
      input.episode ?? '',
      (input.videoHash ?? '').toLowerCase(),
      input.pinned ?? '',
      input.targetLanguage,
      input.targetScript,
      input.profile,
      (input.customInstructions ?? '').trim(),
    ]),
  );
}

/** Translation key of a job that has not found its source yet. */
export const provisionalKey = (mediaKey: string) => `media:${mediaKey}`;
export const isProvisionalKey = (key: string) => key.startsWith('media:');
