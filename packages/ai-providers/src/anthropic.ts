import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import type { LlmResponse } from '@asc/translation-engine';
import { kindFromStatus, parseRetryAfter, ProviderError, safeMessage } from './errors.js';
import { TRANSLATION_OUTPUT_SCHEMA } from './schema.js';
import type { AiProvider, ProviderOptions, ProviderRequest } from './types.js';

const ID = 'anthropic' as const;

/**
 * Models whose safety classifiers can decline a request and for which the API
 * offers a server-side fallback: on a decline the same request is re-run on
 * another Claude model inside the same call, instead of failing the segment.
 */
const SERVER_SIDE_FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);
const SERVER_SIDE_FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// The SDK helper adapts the schema to the API's structured-output rules. Only the
// wire fields are sent: its auto-parser is left out on purpose so that an unusual
// reply reaches the engine's own tolerant parser and validation instead of
// surfacing as an SDK parse error.
const helperFormat = jsonSchemaOutputFormat(TRANSLATION_OUTPUT_SCHEMA);
const OUTPUT_FORMAT = { type: helperFormat.type, schema: helperFormat.schema };

export function createAnthropicProvider(options: ProviderOptions): AiProvider {
  const client = new Anthropic({
    apiKey: options.apiKey,
    // Explicit on purpose: never inherit ANTHROPIC_BASE_URL / auth tokens from the environment.
    baseURL: 'https://api.anthropic.com',
    authToken: null,
    // The provider manager owns the retry policy.
    maxRetries: 0,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  return {
    id: ID,
    async complete(request: ProviderRequest): Promise<LlmResponse> {
      // Current Claude models reject sampling parameters, so `temperature` is not sent;
      // `effort` is the supported control. Thinking is left at the model default (adaptive).
      const params = {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        // The system prompt is identical for every segment of a job: mark it cacheable.
        system: [
          {
            type: 'text' as const,
            text: request.system,
            cache_control: { type: 'ephemeral' as const },
          },
        ],
        messages: [{ role: 'user' as const, content: request.user }],
        output_config: {
          effort: request.effort,
          format: OUTPUT_FORMAT,
        },
      };
      const requestOptions = request.signal ? { signal: request.signal } : {};

      let message: Anthropic.Message | Anthropic.Beta.BetaMessage;
      try {
        // Streaming keeps long generations clear of HTTP idle timeouts.
        message = SERVER_SIDE_FALLBACK_MODELS.has(request.model)
          ? await client.beta.messages
              .stream(
                { ...params, betas: [SERVER_SIDE_FALLBACK_BETA], fallbacks: 'default' },
                requestOptions,
              )
              .finalMessage()
          : await client.messages.stream(params, requestOptions).finalMessage();
      } catch (err) {
        throw toProviderError(err);
      }

      if (message.stop_reason === 'refusal') {
        const category = message.stop_details?.category;
        throw new ProviderError(
          ID,
          'refusal',
          `The model declined to translate this segment${category ? ` (category: ${category})` : ''}.`,
        );
      }
      if (message.stop_reason === 'max_tokens') {
        throw new ProviderError(
          ID,
          'truncated',
          'The answer was cut off at the output token limit.',
        );
      }

      let text = '';
      for (const block of message.content) {
        if (block.type === 'text') text += block.text;
      }
      if (text.trim() === '') throw new ProviderError(ID, 'empty', 'The model returned no text.');

      const usage = message.usage;
      return {
        text,
        provider: ID,
        // The model that actually answered (differs from the request after a server-side fallback).
        model: message.model,
        usage: {
          inputTokens:
            usage.input_tokens +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0),
          outputTokens: usage.output_tokens,
        },
      };
    },
  };
}

function toProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = safeMessage(err);
  // Most specific first. APIConnectionError is a subclass of APIError in this SDK.
  if (err instanceof Anthropic.APIUserAbortError) {
    return new ProviderError(ID, 'cancelled', 'The request was aborted.', { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError(ID, 'timeout', 'The request timed out.', { cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ProviderError(ID, 'network', message, { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    const retryAfterMs = parseRetryAfter(err.headers?.get('retry-after'));
    return new ProviderError(ID, 'rate_limit', message, {
      status: 429,
      cause: err,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new ProviderError(ID, 'auth', message, { status: err.status, cause: err });
  }
  if (err instanceof Anthropic.NotFoundError) {
    return new ProviderError(ID, 'not_found', message, { status: 404, cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    const status = typeof err.status === 'number' ? err.status : undefined;
    const retryAfterMs = parseRetryAfter((err.headers as Headers | undefined)?.get('retry-after'));
    return new ProviderError(ID, kindFromStatus(status), message, {
      cause: err,
      ...(status === undefined ? {} : { status }),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  return new ProviderError(ID, 'unknown', message, { cause: err });
}
