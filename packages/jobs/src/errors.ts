import { AllProvidersFailedError, ProviderConfigError, ProviderError } from '@asc/ai-providers';
import { SourceError, SourceValidationError } from '@asc/subtitle-sources';
import {
  SegmentFailedError,
  SourceSubtitleError,
  TranslationRequestError,
  TranslationValidationError,
  UnsupportedLanguageError,
} from '@asc/translation-engine';

/** The worker no longer owns the job (lease expired and someone else took it, or it was cancelled). */
export class LostLockError extends Error {
  override name = 'LostLockError';
  constructor(jobId: string) {
    super(`Job ${jobId} is no longer owned by this worker.`);
  }
}

export class JobNotFoundError extends Error {
  override name = 'JobNotFoundError';
  constructor(jobId: string) {
    super(`Job ${jobId} does not exist.`);
  }
}

/** The request is understood but cannot be applied to the job in its current state. */
export class JobConflictError extends Error {
  override name = 'JobConflictError';
}

/** The request to create a job is invalid (bad subtitle, language, profile, provider…). */
export class JobRequestError extends Error {
  override name = 'JobRequestError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Saving a job's files failed. */
export class JobStorageError extends Error {
  override name = 'JobStorageError';
  constructor(
    readonly code: 'source_missing' | 'source_changed' | 'save_failed',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** A discovery job could not obtain a usable source subtitle. */
export class JobSourceError extends Error {
  override name = 'JobSourceError';
  constructor(
    readonly code: 'source_not_found' | 'source_invalid' | 'source_unavailable',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Not a failure: the job must wait (another job is already producing the very
 * same translation). It goes back to the queue and is looked at again later.
 */
export class DeferJobError extends Error {
  override name = 'DeferJobError';
  constructor(
    message: string,
    readonly delayMs = 5000,
  ) {
    super(message);
  }
}

export interface JobFailure {
  code: string;
  message: string;
}

const MAX_MESSAGE = 500;

/** Turn any error into a stable code and an owner-readable, secret-free message. */
export function describeFailure(err: unknown): JobFailure {
  const text = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  const message = text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text;
  if (err instanceof JobStorageError || err instanceof JobSourceError) {
    return { code: err.code, message };
  }
  if (err instanceof SourceError) return { code: `source_${err.kind}`, message };
  if (err instanceof SourceValidationError) return { code: 'source_invalid', message };
  if (err instanceof SourceSubtitleError) return { code: 'source_invalid', message };
  if (err instanceof UnsupportedLanguageError || err instanceof TranslationRequestError) {
    return { code: 'invalid_request', message };
  }
  if (err instanceof SegmentFailedError) return { code: 'segment_failed', message };
  if (err instanceof TranslationValidationError) return { code: 'validation_failed', message };
  if (err instanceof AllProvidersFailedError) return { code: `provider_${err.last.kind}`, message };
  if (err instanceof ProviderError) return { code: `provider_${err.kind}`, message };
  if (err instanceof ProviderConfigError) return { code: 'provider_not_configured', message };
  return { code: 'internal_error', message: message || 'Unexpected error.' };
}
