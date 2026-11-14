import type { LanguageDefinition } from './languages.js';
import type { TranslationProfileId } from './profiles.js';
import { buildSegmentPrompt } from './prompt.js';
import { parseTranslationResponse } from './response.js';

/** One subtitle to translate. `id` is the 1-based position of the entry in the file. */
export interface TranslationItem {
  id: number;
  text: string;
}

/** A neighbouring subtitle given for continuity only; it must not be returned. */
export interface ContextItem {
  id: number;
  text: string;
  /** Already-accepted translation (available for preceding context). */
  translation?: string;
}

export interface MediaContext {
  type?: 'movie' | 'series';
  title?: string;
  year?: number;
  season?: number;
  episode?: number;
  episodeTitle?: string;
  /** Short plot summary or any note that helps disambiguate names, genders, terminology. */
  synopsis?: string;
}

export interface SegmentTranslationRequest {
  segmentIndex: number;
  segmentCount: number;
  /** Undefined = unknown; the translator detects it. */
  sourceLanguage?: LanguageDefinition;
  targetLanguage: LanguageDefinition;
  profile: TranslationProfileId;
  /** Owner's style instructions (required for the `custom` profile, optional otherwise). */
  customInstructions?: string;
  mediaContext?: MediaContext;
  contextBefore: ContextItem[];
  contextAfter: ContextItem[];
  items: TranslationItem[];
  /** 1 for the first try; incremented on every retry of the same segment. */
  attempt: number;
  /** Why the previous attempt was rejected (empty on the first attempt). */
  previousIssues: string[];
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface SegmentTranslationResponse {
  items: TranslationItem[];
  usage?: TokenUsage;
  provider?: string;
  model?: string;
  /** Estimated cost of this call in USD, when pricing for the model is configured. */
  costUsd?: number;
  /** The model wrapped its answer in text that had to be discarded. */
  extraneousText?: boolean;
}

export interface TranslateCallOptions {
  signal?: AbortSignal;
}

/**
 * The contextual translation interface the engine depends on.
 * Anything that can translate one segment given its context implements this:
 * a real AI provider (Phase 2), the mock translator, or a test double.
 */
export interface SegmentTranslator {
  translateSegment(
    request: SegmentTranslationRequest,
    options?: TranslateCallOptions,
  ): Promise<SegmentTranslationResponse>;
}

// ---------------------------------------------------------------------------
// Text-level model access. A provider only has to turn a prompt into text;
// prompt construction and response parsing stay in the engine so they are
// identical (and identically tested) for every provider.
// ---------------------------------------------------------------------------

export interface LlmRequest {
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface LlmResponse {
  text: string;
  usage?: TokenUsage;
  provider?: string;
  model?: string;
  /** Estimated cost of this call in USD, when pricing for the model is configured. */
  costUsd?: number;
}

export interface LlmClient {
  complete(request: LlmRequest): Promise<LlmResponse>;
}

/** Adapt a text-completion client to the segment translation interface. */
export function createLlmTranslator(client: LlmClient): SegmentTranslator {
  return {
    async translateSegment(request, options = {}) {
      const prompt = buildSegmentPrompt(request);
      const llmRequest: LlmRequest = { system: prompt.system, user: prompt.user };
      if (options.signal) llmRequest.signal = options.signal;
      const completion = await client.complete(llmRequest);
      const parsed = parseTranslationResponse(completion.text);
      const response: SegmentTranslationResponse = { items: parsed.items };
      if (parsed.extraneousText) response.extraneousText = true;
      if (completion.usage) response.usage = completion.usage;
      if (completion.provider) response.provider = completion.provider;
      if (completion.model) response.model = completion.model;
      if (completion.costUsd !== undefined) response.costUsd = completion.costUsd;
      return response;
    },
  };
}
