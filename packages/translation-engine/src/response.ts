import type { TranslationItem } from './translator.js';

/** The model's reply could not be understood as a translation at all. */
export class TranslationResponseError extends Error {
  override name = 'TranslationResponseError';
}

export interface ParsedTranslationResponse {
  items: TranslationItem[];
  /** True when text outside the JSON payload had to be discarded (commentary, preamble). */
  extraneousText: boolean;
}

/**
 * Extract `{"translations":[{"id":1,"text":"…"}]}` from a model reply.
 *
 * Tolerated: a markdown code fence around the JSON, prose before/after it
 * (flagged as `extraneousText`), a bare array instead of the wrapper object,
 * and numeric ids sent as strings. Anything else is rejected — this function
 * only establishes that the reply is structurally a list of translations;
 * completeness and quality are checked separately by segment validation.
 */
export function parseTranslationResponse(raw: string): ParsedTranslationResponse {
  const { json, extraneousText } = extractJson(raw);

  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new TranslationResponseError('The response is not valid JSON.');
  }

  const list: unknown = Array.isArray(data)
    ? data
    : isRecord(data)
      ? (data.translations ?? data.items)
      : undefined;
  if (!Array.isArray(list)) {
    throw new TranslationResponseError('The response does not contain a "translations" array.');
  }

  const items = list.map((entry: unknown, i): TranslationItem => {
    if (!isRecord(entry)) {
      throw new TranslationResponseError(`Translation #${i + 1} is not an object.`);
    }
    const id = typeof entry.id === 'string' && /^\d+$/.test(entry.id) ? Number(entry.id) : entry.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new TranslationResponseError(`Translation #${i + 1} has no valid "id".`);
    }
    if (typeof entry.text !== 'string') {
      throw new TranslationResponseError(`Translation for id ${id} has no "text" string.`);
    }
    return { id, text: entry.text };
  });

  return { items, extraneousText };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function extractJson(raw: string): { json: string; extraneousText: boolean } {
  const text = raw.trim();
  if (text === '') throw new TranslationResponseError('The response is empty.');

  const fence = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fence) {
    const outside = (text.slice(0, fence.index) + text.slice(fence.index + fence[0].length)).trim();
    return { json: (fence[1] ?? '').trim(), extraneousText: outside !== '' };
  }

  const firstObject = text.indexOf('{');
  const firstArray = text.indexOf('[');
  const candidates = [firstObject, firstArray].filter((i) => i >= 0);
  if (candidates.length === 0) {
    throw new TranslationResponseError('The response contains no JSON.');
  }
  const start = Math.min(...candidates);
  const end = text.lastIndexOf(text[start] === '{' ? '}' : ']');
  if (end <= start) throw new TranslationResponseError('The response contains incomplete JSON.');
  const outside = (text.slice(0, start) + text.slice(end + 1)).trim();
  return { json: text.slice(start, end + 1), extraneousText: outside !== '' };
}
