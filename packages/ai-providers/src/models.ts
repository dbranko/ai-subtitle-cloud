import type { AiProviderId } from './types.js';

export interface ProviderInfo {
  id: AiProviderId;
  name: string;
  /** Used when the owner has not chosen a model. */
  defaultModel: string;
  /** Suggestions for the settings UI; any model id the provider accepts may be configured. */
  suggestedModels: { id: string; note: string }[];
  /** Environment variable that holds the API key. */
  apiKeyEnv: string;
}

export const PROVIDERS: Record<AiProviderId, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic Claude',
    defaultModel: 'claude-opus-5-5',
    suggestedModels: [
      { id: 'claude-opus-5-5', note: 'Best quality (default)' },
      { id: 'claude-sonnet-5-5', note: 'Faster, about half the price' },
      { id: 'claude-haiku-5-5', note: 'Fastest and cheapest' },
    ],
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    defaultModel: 'gpt-6.1-sol',
    suggestedModels: [
      { id: 'gpt-6.1-sol', note: 'Flagship (default)' },
      { id: 'gpt-6.1-terra', note: 'Cheaper' },
      { id: 'gpt-6-luna', note: 'Cheapest' },
    ],
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  gemini: {
    id: 'gemini',
    name: 'Google Gemini',
    defaultModel: 'gemini-3.8-flash',
    suggestedModels: [{ id: 'gemini-3.8-flash', note: 'Default' }],
    apiKeyEnv: 'GEMINI_API_KEY',
  },
};

export function defaultModel(provider: AiProviderId): string {
  return PROVIDERS[provider].defaultModel;
}
