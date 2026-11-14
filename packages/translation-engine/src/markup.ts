/**
 * Subtitle markup that must survive translation untouched:
 *  - HTML-like tags: <i> </i> <b> <u> <font color="#ffff00"> …
 *  - ASS/SSA override blocks: {\an8} {\pos(10,20)} …
 */
const TAG_RE = /<\/?[a-zA-Z][^<>]*>|\{\\[^{}]*\}/g;

/** All markup tags in order of appearance. */
export function extractTags(text: string): string[] {
  return text.match(TAG_RE) ?? [];
}

/** Text with all markup removed (for measuring and comparing the spoken content). */
export function stripTags(text: string): string {
  return text.replace(TAG_RE, '');
}

/** Canonical form for comparison: lower-cased tag name, whitespace-insensitive. */
function normalizeTag(tag: string): string {
  return tag
    .replace(/\s+/g, ' ')
    .replace(/^<(\/?)\s*([a-zA-Z]+)/, (_m, slash: string, name: string) => {
      return `<${slash}${name.toLowerCase()}`;
    });
}

/**
 * True when both texts contain exactly the same tags the same number of times.
 * Order is not compared: word order legitimately changes between languages.
 */
export function sameTags(source: string, translation: string): boolean {
  const a = extractTags(source).map(normalizeTag).sort();
  const b = extractTags(translation).map(normalizeTag).sort();
  return a.length === b.length && a.every((tag, i) => tag === b[i]);
}

/** True when the text contains at least one letter or digit outside markup. */
export function hasTranslatableText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(stripTags(text));
}
