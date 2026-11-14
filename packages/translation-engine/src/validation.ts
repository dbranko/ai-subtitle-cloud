import {
  parseSrt,
  serializeSrt,
  validateSrt,
  type SrtFormat,
  type SubtitleEntry,
} from '@asc/subtitle-parser';
import type { LanguageDefinition } from './languages.js';
import { hasTranslatableText, sameTags, stripTags } from './markup.js';
import { measureScript } from './script.js';
import type { TranslationItem } from './translator.js';

export interface TranslationIssue {
  code: string;
  message: string;
  /** Item id (1-based position in the file) the issue concerns, when it concerns one. */
  id?: number;
}

/**
 * Clean up purely mechanical irregularities in one translated text.
 * Never changes wording: only line endings, stray whitespace and blank lines.
 */
export function normalizeTranslatedText(text: string, source: string): string {
  let out = text.replace(/\r\n|\r/g, '\n');
  // Models occasionally double-escape line breaks ("\\n"). Only fix when the source has none.
  if (out.includes('\\n') && !source.includes('\\n')) out = out.replace(/\\n/g, '\n');
  return out
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim() !== '')
    .join('\n');
}

const COMMENTARY_PREFIX_RE =
  /^\s*(?:translation|translated(?: text)?|translator'?s? note|note|here(?:'s| is)|sure|certainly|prevod|prijevod|napomena)\b[^\n]{0,40}[:：]/i;
const COMMENTARY_INLINE_RE = /[([](?:translator'?s? note|note|t\/n|napomena)\s*[:：]/i;

const MIN_LETTERS_FOR_SEGMENT_SCRIPT_CHECK = 20;
const MIN_SEGMENT_SCRIPT_RATIO = 0.6;
const MIN_LETTERS_FOR_ENTRY_SCRIPT_CHECK = 15;
const MIN_ENTRY_SCRIPT_RATIO = 0.3;
const MIN_ENTRIES_FOR_UNTRANSLATED_CHECK = 5;
const MAX_IDENTICAL_RATIO = 0.7;

export interface SegmentValidationInput {
  source: readonly TranslationItem[];
  /** Translations after `normalizeTranslatedText` (and transliteration, if any). */
  translated: readonly TranslationItem[];
  targetLanguage: LanguageDefinition;
  sourceLanguage?: LanguageDefinition;
}

/**
 * Check one translated segment against its source. An empty result means the
 * segment is accepted; any issue means the whole segment is retried.
 */
export function validateSegmentTranslation(input: SegmentValidationInput): TranslationIssue[] {
  const { source, translated, targetLanguage, sourceLanguage } = input;
  const issues: TranslationIssue[] = [];
  const sourceById = new Map(source.map((s) => [s.id, s.text]));

  const seen = new Map<number, string>();
  for (const item of translated) {
    if (!sourceById.has(item.id)) {
      issues.push({
        code: 'unexpected_entry',
        id: item.id,
        message: `id ${item.id} was not requested.`,
      });
    } else if (seen.has(item.id)) {
      issues.push({
        code: 'duplicate_entry',
        id: item.id,
        message: `id ${item.id} was returned more than once.`,
      });
    } else {
      seen.set(item.id, item.text);
    }
  }

  let identical = 0;
  let comparable = 0;
  for (const { id, text: original } of source) {
    const text = seen.get(id);
    if (text === undefined) {
      issues.push({ code: 'missing_entry', id, message: `id ${id} is missing.` });
      continue;
    }
    const translatable = hasTranslatableText(original);
    if (text.trim() === '' && original.trim() !== '') {
      issues.push({ code: 'empty_translation', id, message: `id ${id} has an empty translation.` });
      continue;
    }
    if (!sameTags(original, text)) {
      issues.push({
        code: 'markup_changed',
        id,
        message: `id ${id}: formatting tags must be copied exactly from the source.`,
      });
    }
    if (
      (COMMENTARY_PREFIX_RE.test(text) && !COMMENTARY_PREFIX_RE.test(original)) ||
      (COMMENTARY_INLINE_RE.test(text) && !COMMENTARY_INLINE_RE.test(original))
    ) {
      issues.push({
        code: 'commentary',
        id,
        message: `id ${id} contains commentary instead of only the translation.`,
      });
    }
    const plainSource = stripTags(original);
    const plain = stripTags(text);
    if (plain.length > plainSource.length * 3 + 40) {
      issues.push({
        code: 'excessive_length',
        id,
        message: `id ${id} is far longer than the original; translate without adding text.`,
      });
    }
    const stats = measureScript(plain, targetLanguage.script);
    if (
      stats.letters >= MIN_LETTERS_FOR_ENTRY_SCRIPT_CHECK &&
      stats.ratio < MIN_ENTRY_SCRIPT_RATIO
    ) {
      issues.push({
        code: 'wrong_script',
        id,
        message: `id ${id} is not written in the ${targetLanguage.name} script.`,
      });
    }
    if (translatable && /\p{L}{2,}\s+\p{L}{2,}/u.test(plainSource)) {
      comparable++;
      if (plain.trim().toLowerCase() === plainSource.trim().toLowerCase()) identical++;
    }
  }

  const allText = [...seen.values()].map(stripTags).join('\n');
  const overall = measureScript(allText, targetLanguage.script);
  if (
    overall.letters >= MIN_LETTERS_FOR_SEGMENT_SCRIPT_CHECK &&
    overall.ratio < MIN_SEGMENT_SCRIPT_RATIO &&
    !issues.some((i) => i.code === 'wrong_script')
  ) {
    issues.push({
      code: 'wrong_script',
      message: `The translation is not written in the ${targetLanguage.name} script.`,
    });
  }

  const sameLanguage = sourceLanguage !== undefined && sourceLanguage.id === targetLanguage.id;
  if (
    !sameLanguage &&
    comparable >= MIN_ENTRIES_FOR_UNTRANSLATED_CHECK &&
    identical / comparable > MAX_IDENTICAL_RATIO
  ) {
    issues.push({
      code: 'untranslated',
      message: `Most subtitles were returned unchanged instead of translated into ${targetLanguage.name}.`,
    });
  }

  return issues;
}

/**
 * Final gate before a translation is handed out: the translated subtitle must
 * be structurally identical to the source (same count, indexes, timing,
 * settings and order), have no missing text, and survive an SRT round trip.
 */
export function validateTranslatedSubtitle(
  source: readonly SubtitleEntry[],
  translated: readonly SubtitleEntry[],
  format: SrtFormat,
): TranslationIssue[] {
  const issues: TranslationIssue[] = [];
  if (source.length !== translated.length) {
    issues.push({
      code: 'entry_count_mismatch',
      message: `Expected ${source.length} entries but the translation has ${translated.length}.`,
    });
    return issues;
  }
  source.forEach((s, i) => {
    const t = translated[i];
    const id = i + 1;
    if (!t) return;
    if (t.index !== s.index) {
      issues.push({ code: 'index_changed', id, message: `Entry ${id}: index changed.` });
    }
    if (t.startMs !== s.startMs || t.endMs !== s.endMs) {
      issues.push({ code: 'timestamp_changed', id, message: `Entry ${id}: timing changed.` });
    }
    if ((t.settings ?? '') !== (s.settings ?? '')) {
      issues.push({
        code: 'settings_changed',
        id,
        message: `Entry ${id}: position settings changed.`,
      });
    }
    if (t.text.trim() === '' && s.text.trim() !== '') {
      issues.push({ code: 'empty_translation', id, message: `Entry ${id}: translation is empty.` });
    }
  });

  for (const error of validateSrt(translated).errors) {
    const issue: TranslationIssue = { code: `srt_${error.code}`, message: error.message };
    if (error.position !== undefined) issue.id = error.position;
    issues.push(issue);
  }

  if (issues.length === 0) {
    try {
      const reparsed = parseSrt(serializeSrt(translated, format));
      const same =
        reparsed.warnings.length === 0 &&
        reparsed.entries.length === translated.length &&
        reparsed.entries.every((e, i) => {
          const t = translated[i];
          return (
            t !== undefined &&
            e.index === t.index &&
            e.startMs === t.startMs &&
            e.endMs === t.endMs &&
            e.text === t.text
          );
        });
      if (!same) {
        issues.push({
          code: 'invalid_srt_output',
          message: 'The translated subtitle does not survive an SRT round trip.',
        });
      }
    } catch {
      issues.push({
        code: 'invalid_srt_output',
        message: 'The translated subtitle is not valid SRT.',
      });
    }
  }
  return issues;
}
