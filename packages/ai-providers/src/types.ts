import type { AiEffort, AiProviderId } from '@asc/config';
import type { LlmResponse } from '@asc/translation-engine';

export type { AiEffort, AiProviderId };

/** One text completion request, already resolved to a concrete model and settings. */
export interface ProviderRequest {
  model: string;
  system: string;
  user: string;
  /** Reasoning depth. Mapped to each provider's own control. */
  effort: AiEffort;
  /** Sampling temperature. Ignored by providers that do not accept it (Anthropic). */
  temperature?: number;
  maxOutputTokens: number;
  /** Aborts the request. The manager combines the caller's signal with the request timeout. */
  signal?: AbortSignal;
}

/**
 * A provider turns a prompt into text. Everything else — prompt construction,
 * response parsing, retries, fallback, cost — lives outside, so all providers
 * behave identically from the engine's point of view.
 *
 * Implementations must throw `ProviderError` for every failure and must not
 * retry on their own: the provider manager owns the single retry policy.
 */
export interface AiProvider {
  readonly id: AiProviderId;
  complete(request: ProviderRequest): Promise<LlmResponse>;
}

/** Test seam: lets tests serve canned HTTP responses to the real SDKs. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ProviderOptions {
  apiKey: string;
  fetch?: FetchLike;
}
