import type { AppConfig } from '@asc/config';
import { adaptSegmentation, type SegmentationOptions } from '@asc/translation-engine';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import {
  createProviderManager,
  ProviderConfigError,
  type ProviderEvent,
  type ProviderManager,
  type ProviderTarget,
} from './manager.js';
import { defaultModel, PROVIDERS } from './models.js';
import { createOpenAiProvider } from './openai.js';
import { loadPricing, type PricingTable } from './pricing.js';
import type { AiEffort, AiProvider, AiProviderId, FetchLike, ProviderOptions } from './types.js';

const FACTORIES: Record<AiProviderId, (options: ProviderOptions) => AiProvider> = {
  anthropic: createAnthropicProvider,
  openai: createOpenAiProvider,
  gemini: createGeminiProvider,
};

/** Create one provider instance. */
export function createProvider(id: AiProviderId, options: ProviderOptions): AiProvider {
  return FACTORIES[id](options);
}

/** Per-request choices that override the configured defaults (e.g. a manual translation). */
export interface ProviderSelection {
  provider?: AiProviderId | undefined;
  model?: string | undefined;
  /** `null` disables the configured fallback. */
  fallbackProvider?: AiProviderId | null | undefined;
  fallbackModel?: string | undefined;
  effort?: AiEffort | undefined;
  temperature?: number | undefined;
}

export interface ManagerDeps {
  onEvent?: (event: ProviderEvent) => void;
  pricing?: PricingTable;
  /** Test seam: HTTP transport handed to the provider SDKs. */
  fetch?: FetchLike;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Resolve which provider/model pairs a request will use, applying defaults. */
export function resolveTargets(
  config: AppConfig,
  selection: ProviderSelection = {},
): { primary: ProviderTarget; fallback: ProviderTarget | undefined } {
  const provider = selection.provider ?? config.ai.provider;
  // A configured model belongs to the configured provider; another provider gets its own default.
  const configuredModel = provider === config.ai.provider ? config.ai.model : undefined;
  const primary: ProviderTarget = {
    provider,
    model: selection.model ?? configuredModel ?? defaultModel(provider),
  };

  const fallbackProvider =
    selection.fallbackProvider === null
      ? undefined
      : (selection.fallbackProvider ?? config.ai.fallbackProvider);
  if (!fallbackProvider) return { primary, fallback: undefined };
  const configuredFallbackModel =
    fallbackProvider === config.ai.fallbackProvider ? config.ai.fallbackModel : undefined;
  return {
    primary,
    fallback: {
      provider: fallbackProvider,
      model: selection.fallbackModel ?? configuredFallbackModel ?? defaultModel(fallbackProvider),
    },
  };
}

/** Build the provider manager from the application configuration. */
export function createProviderManagerFromConfig(
  config: AppConfig,
  selection: ProviderSelection = {},
  deps: ManagerDeps = {},
): ProviderManager {
  const { primary, fallback } = resolveTargets(config, selection);

  const providers: Partial<Record<AiProviderId, AiProvider>> = {};
  for (const id of new Set([primary.provider, ...(fallback ? [fallback.provider] : [])])) {
    const apiKey = config.ai.apiKeys[id];
    if (!apiKey) {
      throw new ProviderConfigError(
        `${PROVIDERS[id].name} is selected but ${PROVIDERS[id].apiKeyEnv} is not set.`,
      );
    }
    providers[id] = createProvider(id, { apiKey, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  }

  return createProviderManager({
    providers,
    primary,
    fallback,
    effort: selection.effort ?? config.ai.effort,
    temperature: selection.temperature ?? config.ai.temperature,
    maxOutputTokens: config.ai.maxOutputTokens,
    requestTimeoutMs: config.ai.requestTimeoutMs,
    retry: { maxRetries: config.ai.maxRetries },
    pricing: deps.pricing ?? loadPricing(config.ai.pricingFile),
    ...(deps.onEvent ? { onEvent: deps.onEvent } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
  });
}

/** Segment sizes for the engine: the owner's maximum, shrunk to fit the output limit. */
export function segmentationFromConfig(config: AppConfig): SegmentationOptions {
  const maxEntries = config.ai.maxSegmentEntries;
  return adaptSegmentation(
    {
      maxEntries,
      targetEntries: Math.min(40, maxEntries),
      minEntries: Math.min(30, maxEntries),
    },
    { maxOutputTokens: config.ai.maxOutputTokens },
  );
}

export interface ProviderStatus {
  id: AiProviderId;
  name: string;
  /** Whether an API key is present. The key itself is never exposed. */
  configured: boolean;
  defaultModel: string;
  suggestedModels: { id: string; note: string }[];
  isPreferred: boolean;
  isFallback: boolean;
}

/** Provider overview that is safe to send to the dashboard. */
export function describeProviders(config: AppConfig): ProviderStatus[] {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    configured: config.ai.apiKeys[p.id] !== undefined,
    defaultModel: p.defaultModel,
    suggestedModels: p.suggestedModels,
    isPreferred: config.ai.provider === p.id,
    isFallback: config.ai.fallbackProvider === p.id,
  }));
}
