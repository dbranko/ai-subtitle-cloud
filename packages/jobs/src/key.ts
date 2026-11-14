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
