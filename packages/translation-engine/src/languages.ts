/**
 * Language and script registry.
 *
 * Identifiers are BCP 47 tags. A script subtag is used only where one language
 * is written in more than one script and the choice matters to the viewer —
 * so Serbian Latin (`sr-Latn`) and Serbian Cyrillic (`sr-Cyrl`) are two
 * separate targets, never one "Serbian" with a hidden default.
 */

export type ScriptCode =
  'Latn' | 'Cyrl' | 'Grek' | 'Arab' | 'Hebr' | 'Hans' | 'Hant' | 'Jpan' | 'Kore' | 'Deva' | 'Thai';

export interface LanguageDefinition {
  /** BCP 47 identifier, e.g. `sr-Latn`, `hr`, `pt-BR`. */
  id: string;
  /** Primary language subtag (`sr` for both Serbian variants). */
  language: string;
  script: ScriptCode;
  /** English name shown in the dashboard and used in prompts. */
  name: string;
  nativeName: string;
  /** Whether the owner can pick this as a translation target. */
  target: boolean;
  /** Extra instruction for the translator about this target (script, standard variety). */
  targetNote?: string;
  /** Code page that non-UTF-8 subtitle files in this language most commonly use. */
  legacyEncoding: string;
}

const lang = (
  id: string,
  script: ScriptCode,
  name: string,
  nativeName: string,
  legacyEncoding: string,
  extra: Partial<Pick<LanguageDefinition, 'target' | 'targetNote'>> = {},
): LanguageDefinition => ({
  id,
  language: id.split('-')[0] ?? id,
  script,
  name,
  nativeName,
  legacyEncoding,
  target: true,
  ...extra,
});

export const LANGUAGES: readonly LanguageDefinition[] = [
  lang('sr-Latn', 'Latn', 'Serbian (Latin)', 'Srpski (latinica)', 'windows-1250', {
    targetNote:
      'Write standard Serbian as used in Serbia (ekavian) in LATIN script (latinica) only. ' +
      'Never use Cyrillic letters. Use the proper letters č, ć, š, ž, đ — never ASCII substitutes.',
  }),
  lang('sr-Cyrl', 'Cyrl', 'Serbian (Cyrillic)', 'Српски (ћирилица)', 'windows-1251', {
    targetNote:
      'Write standard Serbian as used in Serbia (ekavian) in CYRILLIC script (ћирилица) only. ' +
      'Do not use Latin letters except for text that is conventionally left in Latin ' +
      '(e.g. brand names, web addresses).',
  }),
  lang('hr', 'Latn', 'Croatian', 'Hrvatski', 'windows-1250', {
    targetNote:
      'Write standard Croatian (ijekavian) with Croatian vocabulary and phrasing — not Serbian. ' +
      'Use the proper letters č, ć, š, ž, đ.',
  }),
  lang('en', 'Latn', 'English', 'English', 'windows-1252'),
  lang('de', 'Latn', 'German', 'Deutsch', 'windows-1252'),
  lang('fr', 'Latn', 'French', 'Français', 'windows-1252'),
  lang('es', 'Latn', 'Spanish', 'Español', 'windows-1252'),
  lang('it', 'Latn', 'Italian', 'Italiano', 'windows-1252'),
  lang('ru', 'Cyrl', 'Russian', 'Русский', 'windows-1251'),
  lang('pt', 'Latn', 'Portuguese (Portugal)', 'Português (Portugal)', 'windows-1252'),
  lang('pt-BR', 'Latn', 'Portuguese (Brazil)', 'Português (Brasil)', 'windows-1252'),
  lang('nl', 'Latn', 'Dutch', 'Nederlands', 'windows-1252'),
  lang('sl', 'Latn', 'Slovenian', 'Slovenščina', 'windows-1250'),
  lang('mk', 'Cyrl', 'Macedonian', 'Македонски', 'windows-1251'),
  lang('bg', 'Cyrl', 'Bulgarian', 'Български', 'windows-1251'),
  lang('uk', 'Cyrl', 'Ukrainian', 'Українська', 'windows-1251'),
  lang('pl', 'Latn', 'Polish', 'Polski', 'windows-1250'),
  lang('cs', 'Latn', 'Czech', 'Čeština', 'windows-1250'),
  lang('sk', 'Latn', 'Slovak', 'Slovenčina', 'windows-1250'),
  lang('hu', 'Latn', 'Hungarian', 'Magyar', 'windows-1250'),
  lang('ro', 'Latn', 'Romanian', 'Română', 'windows-1250'),
  lang('el', 'Grek', 'Greek', 'Ελληνικά', 'windows-1253'),
  lang('tr', 'Latn', 'Turkish', 'Türkçe', 'windows-1254'),
  lang('sv', 'Latn', 'Swedish', 'Svenska', 'windows-1252'),
  lang('da', 'Latn', 'Danish', 'Dansk', 'windows-1252'),
  lang('nb', 'Latn', 'Norwegian (Bokmål)', 'Norsk bokmål', 'windows-1252'),
  lang('fi', 'Latn', 'Finnish', 'Suomi', 'windows-1252'),
  lang('ar', 'Arab', 'Arabic', 'العربية', 'windows-1256'),
  lang('he', 'Hebr', 'Hebrew', 'עברית', 'windows-1255'),
  lang('hi', 'Deva', 'Hindi', 'हिन्दी', 'utf-8'),
  lang('th', 'Thai', 'Thai', 'ไทย', 'windows-874'),
  lang('ja', 'Jpan', 'Japanese', '日本語', 'shift_jis'),
  lang('ko', 'Kore', 'Korean', '한국어', 'euc-kr'),
  lang('zh-Hans', 'Hans', 'Chinese (Simplified)', '简体中文', 'gb18030'),
  lang('zh-Hant', 'Hant', 'Chinese (Traditional)', '繁體中文', 'big5'),

  // Source-only: subtitles in these languages can be translated FROM, but by
  // product decision they are not offered as translation targets.
  lang('bs', 'Latn', 'Bosnian', 'Bosanski', 'windows-1250', { target: false }),
  lang('cnr', 'Latn', 'Montenegrin', 'Crnogorski', 'windows-1250', { target: false }),
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id.toLowerCase(), l]));

/** Source language value meaning "let the translator detect it". */
export const AUTO_SOURCE = 'auto';

export class UnsupportedLanguageError extends Error {
  override name = 'UnsupportedLanguageError';
}

export function findLanguage(id: string): LanguageDefinition | undefined {
  return BY_ID.get(id.trim().toLowerCase());
}

/** Languages the owner may select as a translation target. */
export function targetLanguages(): LanguageDefinition[] {
  return LANGUAGES.filter((l) => l.target);
}

/** Languages a source subtitle may be in (everything in the registry). */
export function sourceLanguages(): LanguageDefinition[] {
  return [...LANGUAGES];
}

/**
 * Resolve a target language id. Throws for unknown ids, for source-only
 * languages, and for bare `sr` — Serbian always requires an explicit script.
 */
export function resolveTargetLanguage(id: string): LanguageDefinition {
  const normalized = id.trim().toLowerCase();
  if (normalized === 'sr') {
    throw new UnsupportedLanguageError(
      'Serbian requires an explicit script: use "sr-Latn" (Latin) or "sr-Cyrl" (Cyrillic).',
    );
  }
  const found = BY_ID.get(normalized);
  if (!found) throw new UnsupportedLanguageError(`Unknown target language: "${id}".`);
  if (!found.target) {
    throw new UnsupportedLanguageError(`${found.name} is not available as a target language.`);
  }
  return found;
}

/** Resolve a source language id; `auto`, empty or undefined mean "detect". */
export function resolveSourceLanguage(id: string | undefined): LanguageDefinition | undefined {
  if (id === undefined) return undefined;
  const normalized = id.trim().toLowerCase();
  if (normalized === '' || normalized === AUTO_SOURCE) return undefined;
  const found = BY_ID.get(normalized);
  if (!found) throw new UnsupportedLanguageError(`Unknown source language: "${id}".`);
  return found;
}
