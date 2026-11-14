import { ApiError, FinishReason, GoogleGenAI, ThinkingLevel } from '@google/genai';
import type { LlmResponse } from '@asc/translation-engine';
import { kindFromStatus, ProviderError, safeMessage } from './errors.js';
import { TRANSLATION_OUTPUT_SCHEMA } from './schema.js';
import type { AiEffort, AiProvider, ProviderOptions, ProviderRequest } from './types.js';

const ID = 'gemini' as const;

const THINKING_LEVEL: Record<AiEffort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/** `thinkingLevel` exists from Gemini 3 on; older models reject it. */
const SUPPORTS_THINKING_LEVEL = /^gemini-(?:[3-9]|\d{2,})/;

const BLOCKED: ReadonlySet<string> = new Set([
  FinishReason.SAFETY,
  FinishReason.RECITATION,
  FinishReason.BLOCKLIST,
  FinishReason.PROHIBITED_CONTENT,
  FinishReason.SPII,
]);

export function createGeminiProvider(options: ProviderOptions): AiProvider {
  const client = new GoogleGenAI({
    apiKey: options.apiKey,
    vertexai: false,
    httpOptions: {
      baseUrl: 'https://generativelanguage.googleapis.com',
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  });

  return {
    id: ID,
    async complete(request: ProviderRequest): Promise<LlmResponse> {
      let response;
      try {
        response = await client.models.generateContent({
          model: request.model,
          contents: request.user,
          config: {
            systemInstruction: request.system,
            responseMimeType: 'application/json',
            responseJsonSchema: TRANSLATION_OUTPUT_SCHEMA,
            maxOutputTokens: request.maxOutputTokens,
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
            ...(SUPPORTS_THINKING_LEVEL.test(request.model)
              ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL[request.effort] } }
              : {}),
            ...(request.signal ? { abortSignal: request.signal } : {}),
          },
        });
      } catch (err) {
        throw toProviderError(err, request.signal);
      }

      const blockReason = response.promptFeedback?.blockReason;
      if (blockReason) {
        throw new ProviderError(ID, 'refusal', `The request was blocked (${blockReason}).`);
      }
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason === FinishReason.MAX_TOKENS) {
        throw new ProviderError(
          ID,
          'truncated',
          'The answer was cut off at the output token limit.',
        );
      }
      if (finishReason !== undefined && BLOCKED.has(finishReason)) {
        throw new ProviderError(ID, 'refusal', `The answer was blocked (${finishReason}).`);
      }

      const text = response.text ?? '';
      if (text.trim() === '') throw new ProviderError(ID, 'empty', 'The model returned no text.');

      const result: LlmResponse = {
        text,
        provider: ID,
        model: response.modelVersion ?? request.model,
      };
      const usage = response.usageMetadata;
      if (usage) {
        result.usage = {
          inputTokens: usage.promptTokenCount ?? 0,
          // Thinking tokens are reported separately but billed as output.
          outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
        };
      }
      return result;
    },
  };
}

function toProviderError(err: unknown, signal: AbortSignal | undefined): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = safeMessage(err);
  if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
    return new ProviderError(ID, 'cancelled', 'The request was aborted.', { cause: err });
  }
  if (err instanceof ApiError) {
    // Gemini reports an invalid API key as 400 INVALID_ARGUMENT.
    const kind =
      err.status === 400 && /api[ _-]?key/i.test(err.message) ? 'auth' : kindFromStatus(err.status);
    return new ProviderError(ID, kind, message, { status: err.status, cause: err });
  }
  // The SDK surfaces transport failures as plain fetch errors.
  if (
    err instanceof TypeError ||
    (err instanceof Error && /fetch failed|network|ECONN|ENOTFOUND|socket/i.test(err.message))
  ) {
    return new ProviderError(ID, 'network', message, { cause: err });
  }
  return new ProviderError(ID, 'unknown', message, { cause: err });
}
