import type { AiProviderId } from './types.js';

export type ProviderErrorKind =
  /** Invalid or missing API key, or the key lacks permission. */
  | 'auth'
  /** Account has no credit / billing problem. */
  | 'billing'
  /** Too many requests. */
  | 'rate_limit'
  /** The request did not finish within the configured timeout. */
  | 'timeout'
  /** Could not reach the provider. */
  | 'network'
  /** Provider-side failure (5xx). */
  | 'server'
  /** Provider is temporarily overloaded. */
  | 'overloaded'
  /** The provider rejected the request as invalid (bad parameter, unsupported setting). */
  | 'bad_request'
  /** Unknown model, or the model is not available to this account. */
  | 'not_found'
  /** The model declined to answer (safety filter). */
  | 'refusal'
  /** The answer was cut off at the output token limit. */
  | 'truncated'
  /** The provider answered without any text. */
  | 'empty'
  /** The caller aborted the request. */
  | 'cancelled'
  | 'unknown';

/** Failures worth retrying against the same provider after a pause. */
const TRANSIENT: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limit',
  'timeout',
  'network',
  'server',
  'overloaded',
]);

/** Failures that will repeat for every request until the owner fixes the configuration. */
const PERSISTENT: ReadonlySet<ProviderErrorKind> = new Set(['auth', 'billing', 'not_found']);

export interface ProviderErrorDetails {
  status?: number;
  /** Delay requested by the provider (`retry-after`), in milliseconds. */
  retryAfterMs?: number;
  cause?: unknown;
}

export class ProviderError extends Error {
  override name = 'ProviderError';
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly provider: AiProviderId,
    readonly kind: ProviderErrorKind,
    message: string,
    details: ProviderErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
  }

  /** Retrying the same provider may succeed. */
  get transient(): boolean {
    return TRANSIENT.has(this.kind);
  }

  /** The provider will keep failing until its configuration is fixed. */
  get persistent(): boolean {
    return PERSISTENT.has(this.kind);
  }
}

/** Every configured provider failed for one request. */
export class AllProvidersFailedError extends Error {
  override name = 'AllProvidersFailedError';
  constructor(readonly errors: ProviderError[]) {
    super(
      'All configured AI providers failed: ' +
        errors.map((e) => `${e.provider}: ${e.kind} (${e.message})`).join('; '),
    );
  }

  /** The most recent failure (the fallback's, when a fallback was tried). */
  get last(): ProviderError {
    return this.errors[this.errors.length - 1] as ProviderError;
  }
}

/** Parse a `retry-after` header value (seconds or HTTP date) to milliseconds. */
export function parseRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Map an HTTP status to an error kind (shared by all providers). */
export function kindFromStatus(status: number | undefined): ProviderErrorKind {
  if (status === undefined) return 'network';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status === 529 || status === 503) return 'overloaded';
  if (status >= 500) return 'server';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/** Short, secret-free message for logs and the dashboard. */
export function safeMessage(err: unknown, limit = 300): string {
  const text = err instanceof Error ? err.message : String(err);
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}
