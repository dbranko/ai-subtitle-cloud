import type { ScriptCode } from './languages.js';

const LETTER_RE = /\p{L}/u;

const SCRIPT_RE: Record<ScriptCode, RegExp> = {
  Latn: /\p{Script=Latin}/u,
  Cyrl: /\p{Script=Cyrillic}/u,
  Grek: /\p{Script=Greek}/u,
  Arab: /\p{Script=Arabic}/u,
  Hebr: /\p{Script=Hebrew}/u,
  Hans: /\p{Script=Han}/u,
  Hant: /\p{Script=Han}/u,
  Jpan: /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u,
  Kore: /[\p{Script=Hangul}\p{Script=Han}]/u,
  Deva: /\p{Script=Devanagari}/u,
  Thai: /\p{Script=Thai}/u,
};

export interface ScriptStats {
  /** Number of letters (any script). */
  letters: number;
  /** Letters belonging to the expected script. */
  expected: number;
  /** `expected / letters`; 1 when the text has no letters at all. */
  ratio: number;
}

/** Count how much of the text's letters are written in the expected script. */
export function measureScript(text: string, script: ScriptCode): ScriptStats {
  const re = SCRIPT_RE[script];
  let letters = 0;
  let expected = 0;
  for (const ch of text) {
    if (!LETTER_RE.test(ch)) continue;
    letters++;
    if (re.test(ch)) expected++;
  }
  return { letters, expected, ratio: letters === 0 ? 1 : expected / letters };
}

export function containsCyrillic(text: string): boolean {
  return SCRIPT_RE.Cyrl.test(text);
}

// Serbian Cyrillic → Latin. The mapping is exact and lossless in this direction.
const SR_CYR_TO_LAT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  ђ: 'đ',
  е: 'e',
  ж: 'ž',
  з: 'z',
  и: 'i',
  ј: 'j',
  к: 'k',
  л: 'l',
  љ: 'lj',
  м: 'm',
  н: 'n',
  њ: 'nj',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  ћ: 'ć',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'č',
  џ: 'dž',
  ш: 'š',
};
const SR_DIGRAPHS = new Set(['љ', 'њ', 'џ']);

/**
 * Transliterate Serbian Cyrillic to Serbian Latin.
 *
 * Deterministic and exact, which is why it is used as the final guarantee that
 * a Serbian Latin translation never contains Cyrillic. Digraph capitalisation
 * follows the word: `Љубав` → `Ljubav`, `ЉУБАВ` → `LJUBAV`.
 * Characters that are not Serbian Cyrillic are returned unchanged.
 */
export function serbianCyrillicToLatin(text: string): string {
  const chars = [...text];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? '';
    const lower = ch.toLowerCase();
    const mapped = SR_CYR_TO_LAT[lower];
    if (mapped === undefined) {
      out += ch;
      continue;
    }
    if (ch === lower) {
      out += mapped;
      continue;
    }
    if (!SR_DIGRAPHS.has(lower)) {
      out += mapped.toUpperCase();
      continue;
    }
    // Uppercase digraph: fully upper-cased inside an all-caps word, title-cased otherwise.
    const next = chars[i + 1];
    const prev = chars[i - 1];
    const isUpperLetter = (c: string | undefined) =>
      c !== undefined && LETTER_RE.test(c) && c === c.toUpperCase() && c !== c.toLowerCase();
    const isLetter = (c: string | undefined) => c !== undefined && LETTER_RE.test(c);
    const allCaps = isUpperLetter(next) || (!isLetter(next) && isUpperLetter(prev));
    out += allCaps ? mapped.toUpperCase() : (mapped[0] ?? '').toUpperCase() + mapped.slice(1);
  }
  return out;
}
