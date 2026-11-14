import type { TranslationIssue } from './validation.js';

/** The source subtitle cannot be translated (unparseable or structurally broken). */
export class SourceSubtitleError extends Error {
  override name = 'SourceSubtitleError';
  constructor(
    message: string,
    readonly issues: TranslationIssue[] = [],
  ) {
    super(message);
  }
}

/** The request itself is invalid (bad language, missing custom instructions, …). */
export class TranslationRequestError extends Error {
  override name = 'TranslationRequestError';
}

/** A segment still failed validation after the configured number of attempts. */
export class SegmentFailedError extends Error {
  override name = 'SegmentFailedError';
  constructor(
    readonly segmentIndex: number,
    readonly attempts: number,
    readonly issues: TranslationIssue[],
  ) {
    const summary = issues
      .slice(0, 3)
      .map((i) => i.message)
      .join(' ');
    super(
      `Segment ${segmentIndex + 1} could not be translated correctly after ${attempts} attempt(s). ${summary}`.trim(),
    );
  }
}

/** The assembled translation failed the final structural validation. */
export class TranslationValidationError extends Error {
  override name = 'TranslationValidationError';
  constructor(readonly issues: TranslationIssue[]) {
    super(
      `The translated subtitle failed validation: ${issues
        .slice(0, 3)
        .map((i) => i.message)
        .join(' ')}`,
    );
  }
}

/** The caller aborted the translation (AbortSignal). */
export class TranslationCancelledError extends Error {
  override name = 'TranslationCancelledError';
  constructor() {
    super('The translation was cancelled.');
  }
}
