import { setTimeout as sleepTimer } from 'node:timers/promises';
import {
  createLlmTranslator,
  TranslationResponseError,
  type LlmClient,
  type LlmRequest,
  type LlmResponse,
  type SegmentTranslator,
} from '@asc/translation-engine';
import {
  AllProvidersFailedError,
  ProviderError,
  safeMessage,
  type ProviderErrorKind,
} from './errors.js';
import { EMPTY_PRICING, estimateCost, type PricingTable } from './pricing.js';
import type { AiEffort, AiProvider, AiProviderId } from './types.js';

export interface ProviderTarget {
  provider: AiProviderId;
  model: string;
}

export interface RetryPolicy {
  /** Retries after the first attempt, per provider, for transient failures. */
  maxRetries: number;
  /** First backoff delay; doubles on every retry. */
  baseDelayMs: number;
  /** Upper bound for a computed backoff delay. */
  maxDelayMs: number;
  /** A provider-requested wait (`retry-after`) longer than this is not waited out. */
  maxRetryAfterMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  maxRetryAfterMs: 120_000,
};

export type ProviderEvent =
  | {
      type: 'attempt_failed';
      provider: AiProviderId;
      model: string;
      attempt: number;
      kind: ProviderErrorKind;
      message: string;
      /** Set when the same provider will be tried again after `delayMs`. */
      retryInMs?: number;
    }
  | { type: 'fallback'; from: ProviderTarget; to: ProviderTarget; reason: ProviderErrorKind }
  | { type: 'provider_disabled'; provider: AiProviderId; reason: ProviderErrorKind }
  | {
      type: 'completed';
      provider: AiProviderId;
      model: string;
      attempt: number;
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      costUsd: number | undefined;
    };

export interface UsageTotals {
  /** Successful provider calls. */
  calls: number;
  /** Failed provider calls (each retry counts). */
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of estimated costs; null when at least one successful call had no configured price. */
  costUsd: number | null;
}

export interface ProviderManagerOptions {
  /** Ready-to-use providers (those with an API key). */
  providers: Partial<Record<AiProviderId, AiProvider>>;
  primary: ProviderTarget;
  fallback?: ProviderTarget | undefined;
  effort: AiEffort;
  temperature?: number | undefined;
  maxOutputTokens: number;
  /** Time limit for a single provider call. */
  requestTimeoutMs: number;
  retry?: Partial<RetryPolicy>;
  pricing?: PricingTable;
  onEvent?: (event: ProviderEvent) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export class ProviderConfigError extends Error {
  override name = 'ProviderConfigError';
}

export interface ProviderManager extends LlmClient {
  /** The provider chain in the order it is tried. */
  readonly targets: readonly ProviderTarget[];
  /** Segment translator for the translation engine, backed by this manager. */
  readonly translator: SegmentTranslator;
  totals(): UsageTotals;
}

const defaultSleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
  await sleepTimer(ms, undefined, signal ? { signal } : {});
};

/** Failures of one answer (not of the provider): worth asking the same segment again. */
const ANSWER_FAULTS: ReadonlySet<ProviderErrorKind> = new Set(['truncated', 'empty']);

/**
 * One entry point for all AI calls.
 *
 * Policy, identical for every provider:
 *  1. Call the preferred provider. Transient failures (rate limit, timeout,
 *     network, 5xx, overload) are retried with exponential backoff, honouring
 *     the provider's `retry-after`.
 *  2. When retries are exhausted, or the failure is not transient (bad key,
 *     unknown model, refusal, truncated answer…), the fallback provider is
 *     tried with the same policy.
 *  3. A provider that fails for a configuration reason (key, billing, model)
 *     is skipped for the rest of this manager's life instead of being retried
 *     on every segment.
 *  4. If everything fails, `AllProvidersFailedError` carries every cause.
 *     Cancellation is never retried and never falls back.
 */
export function createProviderManager(options: ProviderManagerOptions): ProviderManager {
  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  const pricing = options.pricing ?? EMPTY_PRICING;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const emit = (event: ProviderEvent) => options.onEvent?.(event);

  const targets: ProviderTarget[] = [options.primary];
  const fb = options.fallback;
  if (fb && !(fb.provider === options.primary.provider && fb.model === options.primary.model)) {
    targets.push(fb);
  }
  for (const target of targets) {
    if (!options.providers[target.provider]) {
      throw new ProviderConfigError(
        `AI provider "${target.provider}" is selected but has no API key configured.`,
      );
    }
    if (target.model.trim() === '') {
      throw new ProviderConfigError(`No model configured for AI provider "${target.provider}".`);
    }
  }

  const disabled = new Map<AiProviderId, ProviderError>();
  const totals: UsageTotals = {
    calls: 0,
    failedCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };

  const cancelled = (provider: AiProviderId) =>
    new ProviderError(provider, 'cancelled', 'The request was cancelled.');

  async function callWithRetries(
    target: ProviderTarget,
    request: LlmRequest,
  ): Promise<LlmResponse> {
    const provider = options.providers[target.provider] as AiProvider;
    for (let attempt = 1; ; attempt++) {
      if (request.signal?.aborted) throw cancelled(target.provider);

      const timeout = AbortSignal.timeout(options.requestTimeoutMs);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      const startedAt = now();
      let error: ProviderError;
      try {
        const response = await provider.complete({
          model: target.model,
          system: request.system,
          user: request.user,
          effort: options.effort,
          maxOutputTokens: options.maxOutputTokens,
          signal,
          ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        });
        const model = response.model ?? target.model;
        const costUsd = estimateCost(pricing, target.provider, model, response.usage);
        totals.calls++;
        totals.inputTokens += response.usage?.inputTokens ?? 0;
        totals.outputTokens += response.usage?.outputTokens ?? 0;
        totals.costUsd =
          totals.costUsd === null || costUsd === undefined ? null : totals.costUsd + costUsd;
        emit({
          type: 'completed',
          provider: target.provider,
          model,
          attempt,
          durationMs: now() - startedAt,
          inputTokens: response.usage?.inputTokens ?? 0,
          outputTokens: response.usage?.outputTokens ?? 0,
          costUsd,
        });
        const result: LlmResponse = { ...response, provider: target.provider, model };
        if (costUsd !== undefined) result.costUsd = costUsd;
        return result;
      } catch (err) {
        if (request.signal?.aborted) throw cancelled(target.provider);
        if (timeout.aborted) {
          error = new ProviderError(
            target.provider,
            'timeout',
            `No answer within ${Math.round(options.requestTimeoutMs / 1000)}s.`,
            { cause: err },
          );
        } else if (err instanceof ProviderError) {
          error = err;
        } else {
          error = new ProviderError(target.provider, 'unknown', safeMessage(err), { cause: err });
        }
      }

      totals.failedCalls++;
      const waitable =
        error.retryAfterMs === undefined || error.retryAfterMs <= retry.maxRetryAfterMs;
      const willRetry = error.transient && attempt <= retry.maxRetries && waitable;
      const backoff = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
      // Full backoff down to half of it, so parallel jobs do not retry in lockstep.
      const delayMs = error.retryAfterMs ?? Math.round(backoff * (0.5 + random() * 0.5));
      emit({
        type: 'attempt_failed',
        provider: target.provider,
        model: target.model,
        attempt,
        kind: error.kind,
        message: error.message,
        ...(willRetry ? { retryInMs: delayMs } : {}),
      });
      if (!willRetry) throw error;
      try {
        await sleep(delayMs, request.signal);
      } catch {
        throw cancelled(target.provider);
      }
    }
  }

  async function complete(request: LlmRequest): Promise<LlmResponse> {
    const errors: ProviderError[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i] as ProviderTarget;
      const known = disabled.get(target.provider);
      if (known) {
        errors.push(known);
        continue;
      }
      try {
        return await callWithRetries(target, request);
      } catch (err) {
        const error = err as ProviderError;
        if (error.kind === 'cancelled') throw error;
        errors.push(error);
        if (error.persistent) {
          disabled.set(target.provider, error);
          emit({ type: 'provider_disabled', provider: target.provider, reason: error.kind });
        }
        const next = targets.slice(i + 1).find((t) => !disabled.has(t.provider));
        if (next) emit({ type: 'fallback', from: target, to: next, reason: error.kind });
      }
    }
    throw new AllProvidersFailedError(errors);
  }

  /**
   * For the translation engine, an answer that every provider cut off or left
   * empty is a bad answer for this segment, not a broken provider: the engine
   * asks for the segment again (bounded by its attempt limit) instead of
   * failing the whole job on one oversized or empty reply.
   */
  const segmentClient: LlmClient = {
    async complete(request) {
      try {
        return await complete(request);
      } catch (err) {
        if (
          err instanceof AllProvidersFailedError &&
          err.errors.every((e) => ANSWER_FAULTS.has(e.kind))
        ) {
          throw new TranslationResponseError(
            err.last.kind === 'truncated'
              ? 'The answer was cut off before it was complete.'
              : 'The answer contained no text.',
            { cause: err },
          );
        }
        throw err;
      }
    },
  };
  return {
    targets,
    complete,
    translator: createLlmTranslator(segmentClient),
    totals: () => ({ ...totals }),
  };
}
