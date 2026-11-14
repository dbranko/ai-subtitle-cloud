/**
 * Language codes differ between this application (BCP 47 with script where it
 * matters) and subtitle sources (mostly two-letter codes).
 */
const TO_PROVIDER: Record<string, string> = {
  'sr-Latn': 'sr',
  'sr-Cyrl': 'sr',
  pt: 'pt-pt',
  'pt-BR': 'pt-br',
  'zh-Hans': 'zh-cn',
  'zh-Hant': 'zh-tw',
  nb: 'no',
  cnr: 'me',
};
const FROM_PROVIDER: Record<string, string> = {
  'pt-pt': 'pt',
  'pt-br': 'pt-BR',
  'zh-cn': 'zh-Hans',
  'zh-tw': 'zh-Hant',
  no: 'nb',
  me: 'cnr',
};

/** Registry id → the code OpenSubtitles uses. */
export function toProviderLanguage(id: string): string {
  return TO_PROVIDER[id] ?? id.toLowerCase();
}

/**
 * Source code → registry id. Serbian comes back as bare `sr` because the code
 * does not say which script the file uses; see `resolveContentLanguage`.
 */
export function fromProviderLanguage(code: string): string {
  const lower = code.toLowerCase();
  return FROM_PROVIDER[lower] ?? lower;
}

const CYRILLIC = /\p{Script=Cyrillic}/u;
const LETTER = /\p{L}/u;

/**
 * Final language id of a downloaded subtitle. For Serbian the script is read
 * from the text itself, giving `sr-Cyrl` or `sr-Latn`.
 */
export function resolveContentLanguage(language: string, text: string): string {
  if (language !== 'sr') return language;
  let letters = 0;
  let cyrillic = 0;
  for (const ch of text.slice(0, 20_000)) {
    if (!LETTER.test(ch)) continue;
    letters++;
    if (CYRILLIC.test(ch)) cyrillic++;
  }
  return letters > 0 && cyrillic / letters > 0.5 ? 'sr-Cyrl' : 'sr-Latn';
}

/** True when both ids denote the same language, ignoring script (`sr` = `sr-Latn` = `sr-Cyrl`). */
export function sameLanguage(a: string, b: string): boolean {
  const base = (id: string) => (TO_PROVIDER[id] ?? id).toLowerCase().split('-')[0];
  return base(a) === base(b);
}
