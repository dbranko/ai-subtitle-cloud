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

/**
 * Canonical form for comparison: case-, quote- and whitespace-insensitive
 * (`<FONT color=#FFFF00>` equals `<font color="#ffff00">`, `{\an 8}` equals `{\an8}`).
 */
function normalizeTag(tag: string): string {
  if (tag.startsWith('{')) return tag.replace(/\s+/g, '');
  return tag
    .toLowerCase()
    .replace(/["']/g, '')
    .replace(/\s*=\s*/g, '=')
    .replace(/\s+/g, ' ')
    .replace(/^<(\/?)\s+/, '<$1')
    .replace(/\s*(\/?)>$/, '$1>');
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

const LEADING_TAGS_RE = /^(?:\s*(?:<\/?[a-zA-Z][^<>]*>|\{\\[^{}]*\}))+/;
const TRAILING_TAGS_RE = /(?:(?:<\/?[a-zA-Z][^<>]*>|\{\\[^{}]*\})\s*)+$/;
const LEADING_OVERRIDES_RE = /^(?:\s*\{\\[^{}]*\})+/;

interface Envelope {
  prefix: string;
  body: string;
  suffix: string;
}

/** Split text into leading tags, the body between them and trailing tags. */
function envelope(text: string): Envelope {
  const prefix = LEADING_TAGS_RE.exec(text)?.[0] ?? '';
  const rest = text.slice(prefix.length);
  const suffix = TRAILING_TAGS_RE.exec(rest)?.[0] ?? '';
  return {
    prefix: prefix.trim(),
    body: rest.slice(0, rest.length - suffix.length),
    suffix: suffix.trim(),
  };
}

/** Translated lines with every tag removed (empty lines dropped). */
function plainLines(text: string): string[] {
  return stripTags(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '');
}

/**
 * Put the source's formatting back on a translation whose tags were dropped,
 * added or changed — but only when the source formatting is unambiguous: tags
 * that wrap the whole entry (`<i>…</i>`, `{\an8}<b>…</b>`) or each line when the
 * translation has the same number of lines (`<font …>…</font>` / `<i>…</i>`). Tags inside a sentence (`respond to <i>Pier
 * 14</i>.`) cannot be placed without guessing, so those return null.
 *
 * The result always has exactly the source's tags (checked with `sameTags`);
 * the translated words are never changed.
 */
export function repairTags(source: string, translation: string): string | null {
  if (sameTags(source, translation)) return translation;
  if (extractTags(source).length === 0) {
    const plain = plainLines(translation).join('\n');
    return plain === '' ? null : plain;
  }
  const lines = plainLines(translation);
  if (lines.length === 0) return null;
  const sourceLines = source.split('\n').filter((line) => line.trim() !== '');
  const lineEnvelopes = sourceLines.map(envelope);
  const tagless = (e: Envelope) => extractTags(e.body).length === 0 && e.body.trim() !== '';

  const candidates: string[] = [];
  // 1. Same number of lines, each source line wrapped as a whole.
  if (lines.length === sourceLines.length && lineEnvelopes.every(tagless)) {
    candidates.push(
      lines
        .map((line, i) => `${lineEnvelopes[i]!.prefix}${line}${lineEnvelopes[i]!.suffix}`)
        .join('\n'),
    );
  }
  // 2. The whole entry wrapped once.
  const whole = envelope(source);
  if (tagless(whole)) candidates.push(`${whole.prefix}${lines.join('\n')}${whole.suffix}`);
  return candidates.find((candidate) => sameTags(source, candidate)) ?? null;
}

/**
 * Last resort when the model keeps getting inline formatting wrong: the
 * translation without any tags, keeping only the source's leading positioning
 * blocks (`{\an8}`), so the subtitle still appears where it should. Loses
 * inline emphasis (italics on one word) — callers must report it as a warning.
 */
export function simplifyTags(source: string, translation: string): string {
  const overrides = (LEADING_OVERRIDES_RE.exec(source)?.[0] ?? '').replace(/\s+/g, '');
  return `${overrides}${plainLines(translation).join('\n')}`;
}
