import OpenAI from 'openai';
import type { LlmResponse } from '@asc/translation-engine';
import { kindFromStatus, parseRetryAfter, ProviderError, safeMessage } from './errors.js';
import { TRANSLATION_OUTPUT_SCHEMA, TRANSLATION_OUTPUT_SCHEMA_NAME } from './schema.js';
import type { AiProvider, ProviderOptions, ProviderRequest } from './types.js';

const ID = 'openai' as const;

/**
 * Error type/code values OpenAI sends (with HTTP 429) when the account is out of
 * credit. Observed live: type `insufficient_quota`, code `credit_balance_exhausted`.
 */
const BILLING_CODES: ReadonlySet<string> = new Set([
  'insufficient_quota',
  'credit_balance_exhausted',
  'billing_hard_limit_reached',
]);

export function createOpenAiProvider(options: ProviderOptions): AiProvider {
  const client = new OpenAI({
    apiKey: options.apiKey,
    // Explicit on purpose: never inherit OPENAI_BASE_URL / organisation settings from the environment.
    baseURL: 'https://api.openai.com/v1',
    organization: null,
    project: null,
    // The provider manager owns the retry policy.
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    id: ID,
    async complete(request: ProviderRequest): Promise<LlmResponse> {
      let response: OpenAI.Responses.Response;
      try {
        response = await client.responses.create(
          {
            model: request.model,
            instructions: request.system,
            input: request.user,
            max_output_tokens: request.maxOutputTokens,
            reasoning: { effort: request.effort },
            text: {
              format: {
                type: 'json_schema',
                name: TRANSLATION_OUTPUT_SCHEMA_NAME,
                schema: TRANSLATION_OUTPUT_SCHEMA,
                strict: true,
              },
            },
            // Subtitles are the owner's private data: do not keep them on the provider side.
            store: false,
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          },
          request.signal ? { signal: request.signal } : {},
        );
      } catch (err) {
        throw toProviderError(err);
      }

      if (response.status === 'incomplete') {
        const reason = response.incomplete_details?.reason;
        if (reason === 'max_output_tokens') {
          throw new ProviderError(
            ID,
            'truncated',
            'The answer was cut off at the output token limit.',
          );
        }
        if (reason === 'content_filter') {
          throw new ProviderError(ID, 'refusal', 'The answer was blocked by the content filter.');
        }
        throw new ProviderError(
          ID,
          'unknown',
          `The response is incomplete (${reason ?? 'no reason given'}).`,
        );
      }
      if (response.status === 'failed') {
        throw new ProviderError(
          ID,
          'server',
          safeMessage(response.error?.message ?? 'The response failed.'),
        );
      }

      const refused = response.output.some(
        (item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'),
      );
      if (refused)
        throw new ProviderError(ID, 'refusal', 'The model declined to translate this segment.');

      const text = response.output_text;
      if (text.trim() === '') throw new ProviderError(ID, 'empty', 'The model returned no text.');

      const result: LlmResponse = { text, provider: ID, model: response.model };
      if (response.usage) {
        result.usage = {
          inputTokens: response.usage.input_tokens,
          // Includes reasoning tokens, which are billed as output.
          outputTokens: response.usage.output_tokens,
        };
      }
      return result;
    },
  };
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = safeMessage(err);
  // Most specific first. APIConnectionError is a subclass of APIError in this SDK.
  if (err instanceof OpenAI.APIUserAbortError) {
    return new ProviderError(ID, 'cancelled', 'The request was aborted.', { cause: err });
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError(ID, 'timeout', 'The request timed out.', { cause: err });
  }
  if (err instanceof OpenAI.APIConnectionError) {
    return new ProviderError(ID, 'network', message, { cause: err });
  }
  if (err instanceof OpenAI.RateLimitError) {
    // OpenAI uses 429 both for rate limits and for an exhausted quota; the latter never recovers by waiting.
    if (BILLING_CODES.has(err.type ?? '') || BILLING_CODES.has(err.code ?? '')) {
      return new ProviderError(ID, 'billing', message, { status: 429, cause: err });
    }
    const retryAfterMs = parseRetryAfter(err.headers?.get('retry-after'));
    return new ProviderError(ID, 'rate_limit', message, {
      status: 429,
      cause: err,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) {
    return new ProviderError(ID, 'auth', message, { status: err.status, cause: err });
  }
  if (err instanceof OpenAI.NotFoundError) {
    return new ProviderError(ID, 'not_found', message, { status: 404, cause: err });
  }
  if (err instanceof OpenAI.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    return new ProviderError(ID, kindFromStatus(status), message, {
      cause: err,
      ...(status === undefined ? {} : { status }),
    });
  }
  return new ProviderError(ID, 'unknown', message, { cause: err });
}
