import {
  parseSrt,
  serializeSrt,
  SrtParseError,
  validateSrt,
  type SrtFormat,
  type SrtIssue,
  type SubtitleEntry,
} from '@asc/subtitle-parser';
import {
  SegmentFailedError,
  SourceSubtitleError,
  TranslationCancelledError,
  TranslationRequestError,
  TranslationValidationError,
} from './errors.js';
import {
  resolveSourceLanguage,
  resolveTargetLanguage,
  type LanguageDefinition,
} from './languages.js';
import { isTranslationProfileId, type TranslationProfileId } from './profiles.js';
import { TranslationResponseError } from './response.js';
import { containsCyrillic, serbianCyrillicToLatin } from './script.js';
import {
  planSegments,
  resolveSegmentation,
  type PlannedSegment,
  type SegmentationOptions,
} from './segmentation.js';
import type {
  ContextItem,
  MediaContext,
  SegmentTranslationRequest,
  SegmentTranslator,
  TokenUsage,
  TranslationItem,
} from './translator.js';
import {
  normalizeTranslatedText,
  validateSegmentTranslation,
  validateTranslatedSubtitle,
  type TranslationIssue,
} from './validation.js';
import { ENGINE_VERSION, PROMPT_VERSION } from './version.js';

// ---------------------------------------------------------------------------
// Input / plan
// ---------------------------------------------------------------------------

export interface TranslateSubtitleInput {
  /** Source subtitle as SRT text. */
  srt: string;
  /** Language id, or `auto` / undefined to let the translator detect it. */
  sourceLanguage?: string;
  /** Target language id, script included where it matters (`sr-Latn`, `sr-Cyrl`, `hr`, …). */
  targetLanguage: string;
  profile?: TranslationProfileId;
  customInstructions?: string;
  mediaContext?: MediaContext;
}

export interface TranslationPlan {
  entries: SubtitleEntry[];
  format: SrtFormat;
  /** Irregularities tolerated while reading the source (never fatal). */
  sourceWarnings: SrtIssue[];
  sourceLanguage: LanguageDefinition | undefined;
  targetLanguage: LanguageDefinition;
  profile: TranslationProfileId;
  customInstructions: string | undefined;
  mediaContext: MediaContext | undefined;
  segmentation: SegmentationOptions;
  segments: PlannedSegment[];
}

/**
 * Parse and validate the source, resolve languages and split it into segments.
 * Deterministic: equal input and options give an equal plan (needed for resume).
 */
export function prepareTranslation(
  input: TranslateSubtitleInput,
  segmentation: Partial<SegmentationOptions> = {},
): TranslationPlan {
  const targetLanguage = resolveTargetLanguage(input.targetLanguage);
  const sourceLanguage = resolveSourceLanguage(input.sourceLanguage);

  const profile = input.profile ?? 'natural';
  if (!isTranslationProfileId(profile)) {
    throw new TranslationRequestError(`Unknown translation profile: "${String(profile)}".`);
  }
  const customInstructions = input.customInstructions?.trim() || undefined;
  if (profile === 'custom' && !customInstructions) {
    throw new TranslationRequestError('The custom profile requires custom instructions.');
  }

  let parsed;
  try {
    parsed = parseSrt(input.srt);
  } catch (err) {
    if (err instanceof SrtParseError) throw new SourceSubtitleError(err.message);
    throw err;
  }
  const check = validateSrt(parsed.entries);
  if (!check.valid) {
    throw new SourceSubtitleError(
      `The source subtitle is not usable: ${check.errors[0]?.message ?? 'invalid structure'}`,
      check.errors.map((e) => {
        const issue: TranslationIssue = { code: e.code, message: e.message };
        if (e.position !== undefined) issue.id = e.position;
        return issue;
      }),
    );
  }

  const options = resolveSegmentation(segmentation);
  return {
    entries: parsed.entries,
    format: parsed.format,
    sourceWarnings: [...parsed.warnings, ...check.warnings],
    sourceLanguage,
    targetLanguage,
    profile,
    customInstructions,
    mediaContext: input.mediaContext,
    segmentation: options,
    segments: planSegments(parsed.entries, options),
  };
}

// ---------------------------------------------------------------------------
// One segment
// ---------------------------------------------------------------------------

export interface SegmentResult {
  segmentIndex: number;
  /** Accepted translations for every entry of the segment; `id` is the 1-based file position. */
  translations: TranslationItem[];
  /** Number of translator calls made for this segment (1 = accepted first time). */
  attempts: number;
  usage: TokenUsage;
  provider?: string;
  model?: string;
  durationMs: number;
  /** Entries that came back in Cyrillic and were transliterated to Serbian Latin. */
  transliteratedEntries: number;
  /** Non-fatal observations (e.g. the model added text around its JSON). */
  warnings: TranslationIssue[];
}

export interface SegmentAttemptFailure {
  segmentIndex: number;
  attempt: number;
  issues: TranslationIssue[];
  /** True when another attempt will be made. */
  willRetry: boolean;
}

export interface TranslateSegmentOptions {
  /** Total translator calls allowed per segment, first try included. Default 3. */
  maxAttempts?: number;
  signal?: AbortSignal;
  onAttemptFailed?: (failure: SegmentAttemptFailure) => void | Promise<void>;
  /** Clock, injectable for tests. */
  now?: () => number;
}

export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Translate one planned segment, retrying while the result fails validation.
 *
 * @param accepted translations already accepted for earlier entries (position id → text);
 *                 used to show the translator how the preceding dialogue was rendered.
 * @throws SegmentFailedError when every attempt was rejected — a segment is never
 *         returned incomplete or unvalidated.
 * @throws TranslationCancelledError when the signal is aborted.
 */
export async function translateSegment(
  plan: TranslationPlan,
  segmentIndex: number,
  accepted: ReadonlyMap<number, string>,
  translator: SegmentTranslator,
  options: TranslateSegmentOptions = {},
): Promise<SegmentResult> {
  const segment = plan.segments[segmentIndex];
  if (!segment) throw new RangeError(`Segment ${segmentIndex} does not exist.`);
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const now = options.now ?? Date.now;
  const startedAt = now();

  const item = (position: number): TranslationItem => ({
    id: position + 1,
    text: plan.entries[position]?.text ?? '',
  });
  const range = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from) }, (_, i) => from + i);

  const items = range(segment.start, segment.end).map(item);
  const contextBefore = range(segment.contextStart, segment.start).map((p): ContextItem => {
    const base = item(p);
    const translation = accepted.get(base.id);
    return translation === undefined ? base : { ...base, translation };
  });
  const contextAfter = range(segment.end, segment.contextEnd).map(item);

  const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let previousIssues: TranslationIssue[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    throwIfCancelled(options.signal);

    const request: SegmentTranslationRequest = {
      segmentIndex,
      segmentCount: plan.segments.length,
      targetLanguage: plan.targetLanguage,
      profile: plan.profile,
      contextBefore,
      contextAfter,
      items,
      attempt,
      previousIssues: previousIssues.map((i) => i.message),
    };
    if (plan.sourceLanguage) request.sourceLanguage = plan.sourceLanguage;
    if (plan.customInstructions) request.customInstructions = plan.customInstructions;
    if (plan.mediaContext) request.mediaContext = plan.mediaContext;

    let issues: TranslationIssue[];
    try {
      const response = await translator.translateSegment(
        request,
        options.signal ? { signal: options.signal } : {},
      );
      throwIfCancelled(options.signal);
      usage.inputTokens += response.usage?.inputTokens ?? 0;
      usage.outputTokens += response.usage?.outputTokens ?? 0;

      const sourceById = new Map(items.map((i) => [i.id, i.text]));
      let transliteratedEntries = 0;
      const translated = response.items.map((t): TranslationItem => {
        let text = normalizeTranslatedText(t.text, sourceById.get(t.id) ?? '');
        // Guarantee: a Serbian Latin translation never contains Cyrillic.
        if (plan.targetLanguage.id === 'sr-Latn' && containsCyrillic(text)) {
          text = serbianCyrillicToLatin(text);
          transliteratedEntries++;
        }
        return { id: t.id, text };
      });

      const validation: Parameters<typeof validateSegmentTranslation>[0] = {
        source: items,
        translated,
        targetLanguage: plan.targetLanguage,
      };
      if (plan.sourceLanguage) validation.sourceLanguage = plan.sourceLanguage;
      issues = validateSegmentTranslation(validation);

      if (issues.length === 0) {
        const byId = new Map(translated.map((t) => [t.id, t.text]));
        const result: SegmentResult = {
          segmentIndex,
          translations: items.map((i) => ({ id: i.id, text: byId.get(i.id) ?? '' })),
          attempts: attempt,
          usage,
          durationMs: now() - startedAt,
          transliteratedEntries,
          warnings: response.extraneousText
            ? [
                {
                  code: 'extraneous_text',
                  message: `Segment ${segmentIndex + 1}: text around the JSON answer was discarded.`,
                },
              ]
            : [],
        };
        if (response.provider) result.provider = response.provider;
        if (response.model) result.model = response.model;
        return result;
      }
    } catch (err) {
      if (options.signal?.aborted) throw new TranslationCancelledError();
      // An unparseable reply is an invalid attempt. Anything else (network, auth,
      // rate limit) is the provider layer's responsibility and is not swallowed here.
      if (!(err instanceof TranslationResponseError)) throw err;
      issues = [{ code: 'invalid_response', message: err.message }];
    }

    previousIssues = issues;
    const willRetry = attempt < maxAttempts;
    await options.onAttemptFailed?.({ segmentIndex, attempt, issues, willRetry });
    if (!willRetry) throw new SegmentFailedError(segmentIndex, attempt, issues);
  }
  // Unreachable: the loop either returns or throws.
  throw new SegmentFailedError(segmentIndex, maxAttempts, previousIssues);
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new TranslationCancelledError();
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

export interface TranslationMetadata {
  engineVersion: string;
  promptVersion: string;
  /** Language id, or `auto` when the source language was not specified. */
  sourceLanguage: string;
  targetLanguage: string;
  targetScript: string;
  profile: TranslationProfileId;
  /** Distinct provider/model pairs that produced accepted segments. */
  models: { provider: string; model: string }[];
}

export interface TranslationStats {
  entries: number;
  segments: number;
  /** Translator calls in total. */
  attempts: number;
  /** Calls beyond the first per segment. */
  retries: number;
  transliteratedEntries: number;
  usage: TokenUsage;
  sourceCharacters: number;
  translatedCharacters: number;
  /** Sum of segment translation time (excludes time spent waiting between segments). */
  translationMs: number;
}

export interface TranslationResult {
  /** The translated subtitle as SRT text, in the source file's format (BOM, line endings). */
  srt: string;
  entries: SubtitleEntry[];
  metadata: TranslationMetadata;
  stats: TranslationStats;
  validation: {
    /** Always true: an invalid translation throws instead of being returned. */
    valid: true;
    warnings: TranslationIssue[];
  };
}

/**
 * Combine accepted segment results into the final subtitle and run the final
 * structural validation.
 *
 * @throws TranslationValidationError when a segment is missing or the result
 *         is not structurally identical to the source.
 */
export function assembleTranslation(
  plan: TranslationPlan,
  results: readonly SegmentResult[],
): TranslationResult {
  const bySegment = new Map(results.map((r) => [r.segmentIndex, r]));
  const missing = plan.segments.filter((s) => !bySegment.has(s.index));
  if (missing.length > 0) {
    throw new TranslationValidationError(
      missing.map((s) => ({
        code: 'missing_segment',
        message: `Segment ${s.index + 1} has not been translated.`,
      })),
    );
  }

  const texts = new Map<number, string>();
  for (const result of bySegment.values()) {
    for (const t of result.translations) texts.set(t.id, t.text);
  }
  const issues: TranslationIssue[] = [];
  const entries = plan.entries.map((source, i): SubtitleEntry => {
    const text = texts.get(i + 1);
    if (text === undefined) {
      issues.push({
        code: 'missing_entry',
        id: i + 1,
        message: `Entry ${i + 1} has no translation.`,
      });
    }
    return { ...source, text: text ?? '' };
  });
  if (issues.length === 0)
    issues.push(...validateTranslatedSubtitle(plan.entries, entries, plan.format));
  if (issues.length > 0) throw new TranslationValidationError(issues);

  const used = [...bySegment.values()];
  const models = new Map<string, { provider: string; model: string }>();
  for (const r of used) {
    if (r.provider === undefined && r.model === undefined) continue;
    const pair = { provider: r.provider ?? 'unknown', model: r.model ?? 'unknown' };
    models.set(`${pair.provider}/${pair.model}`, pair);
  }
  const sum = (pick: (r: SegmentResult) => number) => used.reduce((total, r) => total + pick(r), 0);
  const attempts = sum((r) => r.attempts);

  return {
    srt: serializeSrt(entries, plan.format),
    entries,
    metadata: {
      engineVersion: ENGINE_VERSION,
      promptVersion: PROMPT_VERSION,
      sourceLanguage: plan.sourceLanguage?.id ?? 'auto',
      targetLanguage: plan.targetLanguage.id,
      targetScript: plan.targetLanguage.script,
      profile: plan.profile,
      models: [...models.values()],
    },
    stats: {
      entries: entries.length,
      segments: plan.segments.length,
      attempts,
      retries: attempts - used.length,
      transliteratedEntries: sum((r) => r.transliteratedEntries),
      usage: {
        inputTokens: sum((r) => r.usage.inputTokens),
        outputTokens: sum((r) => r.usage.outputTokens),
      },
      sourceCharacters: plan.entries.reduce((n, e) => n + e.text.length, 0),
      translatedCharacters: entries.reduce((n, e) => n + e.text.length, 0),
      translationMs: sum((r) => r.durationMs),
    },
    validation: {
      valid: true,
      warnings: [
        ...plan.sourceWarnings.map((w) => {
          const issue: TranslationIssue = { code: `source_${w.code}`, message: w.message };
          if (w.position !== undefined) issue.id = w.position;
          return issue;
        }),
        ...used.sort((a, b) => a.segmentIndex - b.segmentIndex).flatMap((r) => r.warnings),
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Whole subtitle
// ---------------------------------------------------------------------------

export type TranslationProgressEvent =
  | { type: 'planned'; totalSegments: number; totalEntries: number }
  | { type: 'segment_started'; segmentIndex: number; totalSegments: number }
  | ({ type: 'segment_attempt_failed' } & SegmentAttemptFailure)
  | {
      type: 'segment_completed';
      segmentIndex: number;
      /** Segments accepted so far, this one included. */
      completedSegments: number;
      totalSegments: number;
      completedEntries: number;
      totalEntries: number;
      result: SegmentResult;
    }
  | { type: 'validating' };

export interface TranslateSubtitleOptions {
  segmentation?: Partial<SegmentationOptions>;
  maxAttemptsPerSegment?: number;
  signal?: AbortSignal;
  /**
   * Called (and awaited) after every real unit of work. `segment_completed` is
   * emitted only after a segment passed validation, so a listener that persists
   * it can report progress that is always true.
   */
  onProgress?: (event: TranslationProgressEvent) => void | Promise<void>;
  /** Results of segments accepted in an earlier run; they are not translated again. */
  completedSegments?: readonly SegmentResult[];
  now?: () => number;
}

/**
 * Translate a whole SRT subtitle, segment by segment, in order.
 *
 * Returns only a complete, validated translation; otherwise throws one of
 * SourceSubtitleError, TranslationRequestError, SegmentFailedError,
 * TranslationValidationError or TranslationCancelledError.
 */
export async function translateSubtitle(
  input: TranslateSubtitleInput,
  translator: SegmentTranslator,
  options: TranslateSubtitleOptions = {},
): Promise<TranslationResult> {
  const plan = prepareTranslation(input, options.segmentation);
  const totalSegments = plan.segments.length;
  const totalEntries = plan.entries.length;
  await options.onProgress?.({ type: 'planned', totalSegments, totalEntries });

  const results = new Map<number, SegmentResult>();
  const accepted = new Map<number, string>();
  const accept = (result: SegmentResult) => {
    results.set(result.segmentIndex, result);
    for (const t of result.translations) accepted.set(t.id, t.text);
  };
  for (const previous of options.completedSegments ?? []) {
    const segment = plan.segments[previous.segmentIndex];
    // Only trust a resumed result that matches the current plan exactly.
    const matches =
      segment !== undefined &&
      previous.translations.length === segment.end - segment.start &&
      previous.translations.every((t, i) => t.id === segment.start + i + 1);
    if (matches) accept(previous);
  }

  for (const segment of plan.segments) {
    if (results.has(segment.index)) continue;
    throwIfCancelled(options.signal);
    await options.onProgress?.({
      type: 'segment_started',
      segmentIndex: segment.index,
      totalSegments,
    });

    const segmentOptions: TranslateSegmentOptions = {
      onAttemptFailed: async (failure) => {
        await options.onProgress?.({ type: 'segment_attempt_failed', ...failure });
      },
    };
    if (options.maxAttemptsPerSegment !== undefined)
      segmentOptions.maxAttempts = options.maxAttemptsPerSegment;
    if (options.signal) segmentOptions.signal = options.signal;
    if (options.now) segmentOptions.now = options.now;

    const result = await translateSegment(
      plan,
      segment.index,
      accepted,
      translator,
      segmentOptions,
    );
    accept(result);
    await options.onProgress?.({
      type: 'segment_completed',
      segmentIndex: segment.index,
      completedSegments: results.size,
      totalSegments,
      completedEntries: accepted.size,
      totalEntries,
      result,
    });
  }

  throwIfCancelled(options.signal);
  await options.onProgress?.({ type: 'validating' });
  return assembleTranslation(plan, [...results.values()]);
}
