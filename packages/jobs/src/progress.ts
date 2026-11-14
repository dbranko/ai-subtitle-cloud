import type { JobState } from './states.js';

/**
 * Weighted progress model. The numbers are the share of the whole job each
 * stage represents; they add up to 100.
 */
export const STAGE_WEIGHTS = {
  /** locating_source */
  discovery: 5,
  /** downloading_source + parsing (half each) */
  downloadAndParsing: 10,
  /** preparing_context */
  context: 10,
  /** translating — proportional to accepted segments */
  translation: 65,
  /** validating */
  validation: 7,
  /** saving */
  saving: 3,
} as const;

const W = STAGE_WEIGHTS;
/** Percentage already earned when a state is ENTERED (all earlier stages finished). */
const BASE: Record<JobState, number> = {
  queued: 0,
  locating_source: 0,
  downloading_source: W.discovery,
  parsing: W.discovery + W.downloadAndParsing / 2,
  preparing_context: W.discovery + W.downloadAndParsing,
  translating: W.discovery + W.downloadAndParsing + W.context,
  validating: W.discovery + W.downloadAndParsing + W.context + W.translation,
  saving: W.discovery + W.downloadAndParsing + W.context + W.translation + W.validation,
  completed: 100,
  // Terminal failures keep the percentage they had; see computePercentage.
  failed: 0,
  cancelled: 0,
};

export interface ProgressInput {
  state: JobState;
  completedSegments: number;
  totalSegments: number;
}

/** Share of the translation stage that is done, from accepted segments only (0..1). */
export function translationFraction(completedSegments: number, totalSegments: number): number {
  if (totalSegments <= 0) return 0;
  return Math.min(1, Math.max(0, completedSegments / totalSegments));
}

/**
 * The job's overall percentage — a pure function of persisted facts, so the
 * API, the event stream and the dashboard can never disagree.
 *
 *  - A stage contributes its weight only once it has FINISHED.
 *  - Translation contributes in proportion to segments that were accepted
 *    (validated and saved as checkpoints). Retries add nothing.
 *  - Segments already accepted in an earlier run still count while a resumed
 *    job passes through the early stages again: that work is real and kept.
 *  - 100 is returned only for `completed`; every other state is capped at 99.
 *  - `failed` / `cancelled` have no percentage of their own: callers keep the
 *    last value (pass `previous`).
 */
export function computePercentage(input: ProgressInput, previous = 0): number {
  const { state } = input;
  if (state === 'completed') return 100;
  if (state === 'failed' || state === 'cancelled') return Math.min(99, previous);

  const fraction = translationFraction(input.completedSegments, input.totalSegments);
  const translationCredit = BASE.translating + W.translation * fraction;
  let value: number;
  if (state === 'translating') {
    value = translationCredit;
  } else if (state === 'validating' || state === 'saving') {
    value = BASE[state];
  } else {
    // Before translation (first run or resumed): stage base, or kept segment work if larger.
    value = fraction > 0 ? Math.max(BASE[state], translationCredit) : BASE[state];
  }
  return Math.min(99, Math.round(value * 10) / 10);
}

export interface SegmentTiming {
  /** Subtitle entries in the segment. */
  entries: number;
  /** Wall-clock time the segment took, retries included. */
  durationMs: number;
}

/** Segments that must have been measured before an estimate is shown. */
export const MIN_SEGMENTS_FOR_ESTIMATE = 2;
/** Weight of the newest measurement in the moving average. */
const RECENCY = 0.5;

/**
 * Estimated seconds until the translation stage finishes, or null when there
 * is not enough evidence. Based only on measured segment durations of the
 * current run: an exponentially weighted time-per-entry (recent segments count
 * more, so a provider that slows down is reflected quickly) multiplied by the
 * entries still to translate.
 */
export function estimateRemainingSeconds(
  timings: readonly SegmentTiming[],
  remainingEntries: number,
): number | null {
  const usable = timings.filter((t) => t.entries > 0 && t.durationMs >= 0);
  if (usable.length < MIN_SEGMENTS_FOR_ESTIMATE) return null;
  if (remainingEntries <= 0) return 0;
  let msPerEntry = (usable[0] as SegmentTiming).durationMs / (usable[0] as SegmentTiming).entries;
  for (const t of usable.slice(1)) {
    msPerEntry = RECENCY * (t.durationMs / t.entries) + (1 - RECENCY) * msPerEntry;
  }
  return Math.max(1, Math.round((msPerEntry * remainingEntries) / 1000));
}
