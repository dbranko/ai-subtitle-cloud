import type { SubtitleEntry } from '@asc/subtitle-parser';

export interface SegmentationOptions {
  /** Preferred number of entries per segment. */
  targetEntries: number;
  /** A segment is not cut shorter than this (except the last one, when unavoidable). */
  minEntries: number;
  /** Hard upper bound on entries per segment. */
  maxEntries: number;
  /** Hard upper bound on source text characters per segment (provider budget). */
  maxChars: number;
  /** Entries before the segment that are sent as read-only context. */
  contextBefore: number;
  /** Entries after the segment that are sent as read-only context. */
  contextAfter: number;
  /** A pause at least this long between two entries is treated as a scene change. */
  sceneGapMs: number;
}

export const DEFAULT_SEGMENTATION: SegmentationOptions = {
  targetEntries: 40,
  minEntries: 30,
  maxEntries: 60,
  maxChars: 6000,
  contextBefore: 6,
  contextAfter: 3,
  sceneGapMs: 2500,
};

/** A contiguous slice of the subtitle. Positions are 0-based; `end` is exclusive. */
export interface PlannedSegment {
  index: number;
  start: number;
  end: number;
  /** Slice of entries shown before the segment as context: `[contextStart, start)`. */
  contextStart: number;
  /** Slice of entries shown after the segment as context: `[end, contextEnd)`. */
  contextEnd: number;
}

export function resolveSegmentation(
  options: Partial<SegmentationOptions> = {},
): SegmentationOptions {
  const o = { ...DEFAULT_SEGMENTATION, ...options };
  const int = (v: number, min: number) => Math.max(min, Math.floor(v));
  const maxEntries = int(o.maxEntries, 1);
  const minEntries = Math.min(int(o.minEntries, 1), maxEntries);
  const targetEntries = Math.min(Math.max(int(o.targetEntries, 1), minEntries), maxEntries);
  return {
    targetEntries,
    minEntries,
    maxEntries,
    maxChars: int(o.maxChars, 1),
    contextBefore: int(o.contextBefore, 0),
    contextAfter: int(o.contextAfter, 0),
    sceneGapMs: int(o.sceneGapMs, 0),
  };
}

export interface ProviderLimits {
  /** Maximum tokens the model may generate in one response. */
  maxOutputTokens?: number;
  /** Maximum tokens the model accepts as input. */
  maxInputTokens?: number;
}

/**
 * Conservative budget: a translated subtitle character costs up to ~1 token in
 * non-Latin scripts and each entry adds JSON overhead, so only a fraction of
 * the output window is planned for. The input side carries the segment once
 * plus context and instructions.
 */
const SOURCE_CHARS_PER_OUTPUT_TOKEN = 0.5;
const SOURCE_CHARS_PER_INPUT_TOKEN = 1;
const MIN_ADAPTED_CHARS = 400;

/** Shrink segment size so one segment always fits the provider's context limits. */
export function adaptSegmentation(
  options: Partial<SegmentationOptions>,
  limits: ProviderLimits,
): SegmentationOptions {
  const base = resolveSegmentation(options);
  let maxChars = base.maxChars;
  if (limits.maxOutputTokens !== undefined) {
    maxChars = Math.min(maxChars, limits.maxOutputTokens * SOURCE_CHARS_PER_OUTPUT_TOKEN);
  }
  if (limits.maxInputTokens !== undefined) {
    maxChars = Math.min(maxChars, limits.maxInputTokens * SOURCE_CHARS_PER_INPUT_TOKEN);
  }
  return resolveSegmentation({ ...base, maxChars: Math.max(MIN_ADAPTED_CHARS, maxChars) });
}

/**
 * Split entries into segments.
 *
 * Deterministic: the same entries and options always give the same plan, which
 * is what allows a job to resume after a restart. Cuts are placed at scene
 * changes (long pauses) when one exists inside the allowed window, so a
 * conversation is rarely split in the middle.
 */
export function planSegments(
  entries: readonly SubtitleEntry[],
  options: Partial<SegmentationOptions> = {},
): PlannedSegment[] {
  const o = resolveSegmentation(options);
  const n = entries.length;

  // prefix[i] = total characters of entries[0..i)
  const prefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = (prefix[i] ?? 0) + (entries[i]?.text.length ?? 0);
  const chars = (from: number, to: number) => (prefix[to] ?? 0) - (prefix[from] ?? 0);

  const cuts: number[] = [];
  let pos = 0;
  while (pos < n) {
    if (n - pos <= o.maxEntries && chars(pos, n) <= o.maxChars) {
      cuts.push(n);
      break;
    }
    // Largest allowed end: bounded by entry count and by the character budget.
    let hi = Math.min(pos + o.maxEntries, n);
    while (hi > pos + 1 && chars(pos, hi) > o.maxChars) hi--;
    let lo = Math.min(pos + o.minEntries, hi);

    // Avoid leaving a final fragment shorter than minEntries when that is avoidable.
    const tail = n - hi;
    if (tail > 0 && tail < o.minEntries) {
      const shifted = n - o.minEntries;
      if (shifted >= lo) hi = shifted;
      else if (shifted > pos) lo = hi = Math.max(shifted, pos + 1);
    }

    const preferred = Math.min(hi, Math.max(lo, pos + o.targetEntries));
    let cut = preferred;
    let bestGap = -1;
    for (let k = lo; k <= hi && k < n; k++) {
      const gap = (entries[k]?.startMs ?? 0) - (entries[k - 1]?.endMs ?? 0);
      if (gap < o.sceneGapMs) continue;
      const better =
        gap > bestGap || (gap === bestGap && Math.abs(k - preferred) < Math.abs(cut - preferred));
      if (better) {
        bestGap = gap;
        cut = k;
      }
    }
    cuts.push(cut);
    pos = cut;
  }

  let start = 0;
  return cuts.map((end, index) => {
    const segment: PlannedSegment = {
      index,
      start,
      end,
      contextStart: Math.max(0, start - o.contextBefore),
      contextEnd: Math.min(n, end + o.contextAfter),
    };
    start = end;
    return segment;
  });
}
