import { describe, expect, it } from 'vitest';
import {
  createAnthropicProvider,
  createGeminiProvider,
  createOpenAiProvider,
  ProviderError,
  type AiProvider,
  type ProviderRequest,
} from './index.js';
import {
  anthropicError,
  anthropicStream,
  fakeHttp,
  geminiError,
  geminiResponse,
  openAiError,
  openAiResponse,
} from './test-http.js';

const JSON_TEXT = '{"translations":[{"id":1,"text":"Zdravo"}]}';
const request = (overrides: Partial<ProviderRequest> = {}): ProviderRequest => ({
  model: 'test-model',
  system: 'SYSTEM PROMPT',
  user: 'USER PROMPT',
  effort: 'medium',
  maxOutputTokens: 32_000,
  ...overrides,
});

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

describe('Anthropic provider', () => {
  const make = (handler: Parameters<typeof fakeHttp>[0]) => {
    const http = fakeHttp(handler);
    return {
      http,
      provider: createAnthropicProvider({ apiKey: 'sk-ant-test-key', fetch: http.fetch }),
    };
  };

  it('returns text, the answering model and token usage', async () => {
    const { provider } = make(() =>
      anthropicStream({
        text: JSON_TEXT,
        model: 'claude-haiku-5-5',
        inputTokens: 120,
        outputTokens: 40,
        cacheReadTokens: 30,
      }),
    );
    expect(await provider.complete(request({ model: 'claude-haiku-5-5' }))).toEqual({
      text: JSON_TEXT,
      provider: 'anthropic',
      model: 'claude-haiku-5-5',
      usage: { inputTokens: 150, outputTokens: 40 },
    });
  });

  it('sends a streaming request to the official endpoint with effort, schema and a cacheable system prompt', async () => {
    const { provider, http } = make(() => anthropicStream({ text: JSON_TEXT }));
    await provider.complete(
      request({ model: 'claude-haiku-5-5', effort: 'low', temperature: 0.4 }),
    );
    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    // The SDK decides which header carries the key; it must be sent, and only as a header.
    const credentials = [call.headers['x-api-key'], call.headers.authorization].join(' ');
    expect(credentials).toContain('sk-ant-test-key');
    expect(JSON.stringify(call.body)).not.toContain('sk-ant-test-key');
    expect(call.body).toMatchObject({
      model: 'claude-haiku-5-5',
      max_tokens: 32_000,
      stream: true,
      system: [{ type: 'text', text: 'SYSTEM PROMPT', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'USER PROMPT' }],
    });
    const output = call.body.output_config as {
      effort: string;
      format: { type: string; schema: unknown };
    };
    expect(output.effort).toBe('low');
    expect(output.format.type).toBe('json_schema');
    expect(JSON.stringify(output.format.schema)).toContain('translations');
    // Current Claude models reject sampling parameters and explicit thinking budgets.
    expect(call.body.temperature).toBeUndefined();
    expect(call.body.thinking).toBeUndefined();
    expect(call.body.fallbacks).toBeUndefined();
  });

  it('opts into the server-side refusal fallback on models that support it', async () => {
    const { provider, http } = make(() =>
      anthropicStream({ text: JSON_TEXT, model: 'claude-opus-5-5' }),
    );
    await provider.complete(request({ model: 'claude-opus-5-5' }));
    const call = http.calls[0]!;
    expect(call.url).toContain('https://api.anthropic.com/v1/messages');
    expect(call.body.fallbacks).toBe('default');
    expect(call.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
  });

  it.each([
    [401, 'authentication_error', 'auth'],
    [403, 'permission_error', 'auth'],
    [402, 'billing_error', 'billing'],
    [404, 'not_found_error', 'not_found'],
    [400, 'invalid_request_error', 'bad_request'],
    [429, 'rate_limit_error', 'rate_limit'],
    [500, 'api_error', 'server'],
    [529, 'overloaded_error', 'overloaded'],
  ])('maps HTTP %i (%s) to "%s"', async (status, type, kind) => {
    const { provider, http } = make(() => anthropicError(status, type));
    const error = await failure(provider.complete(request()));
    expect(error).toMatchObject({ provider: 'anthropic', kind, status });
    // The provider itself never retries: that is the manager's job.
    expect(http.calls).toHaveLength(1);
  });

  it('reads retry-after from a rate-limit response', async () => {
    const { provider } = make(() =>
      anthropicError(429, 'rate_limit_error', { 'retry-after': '7' }),
    );
    expect((await failure(provider.complete(request()))).retryAfterMs).toBe(7000);
  });

  it('reports a refusal, a truncated answer and an empty answer as errors', async () => {
    const refusal = make(() =>
      anthropicStream({ stopReason: 'refusal', stopDetails: { type: 'refusal', category: 'bio' } }),
    );
    expect(await failure(refusal.provider.complete(request()))).toMatchObject({ kind: 'refusal' });
    const truncated = make(() =>
      anthropicStream({ text: '{"translations":[{"id":1,"te', stopReason: 'max_tokens' }),
    );
    expect(await failure(truncated.provider.complete(request()))).toMatchObject({
      kind: 'truncated',
    });
    const empty = make(() => anthropicStream({}));
    expect(await failure(empty.provider.complete(request()))).toMatchObject({ kind: 'empty' });
  });

  it('reports an aborted request as cancelled and a transport failure as network', async () => {
    const aborted = make(() => anthropicStream({ text: JSON_TEXT }));
    const error = await failure(
      aborted.provider.complete(request({ signal: AbortSignal.abort() })),
    );
    expect(error.kind).toBe('cancelled');
    const offline = make(() => {
      throw new TypeError('fetch failed');
    });
    expect((await failure(offline.provider.complete(request()))).kind).toBe('network');
  });

  it('never puts the API key into an error message', async () => {
    const { provider } = make(() => anthropicError(401, 'authentication_error'));
    const error = await failure(provider.complete(request()));
    expect(error.message).not.toContain('sk-ant-test-key');
  });
});

describe('OpenAI provider', () => {
  const make = (handler: Parameters<typeof fakeHttp>[0]) => {
    const http = fakeHttp(handler);
    return {
      http,
      provider: createOpenAiProvider({ apiKey: 'sk-openai-test-key', fetch: http.fetch }),
    };
  };

  it('returns text, model and token usage', async () => {
    const { provider } = make(() =>
      openAiResponse({
        text: JSON_TEXT,
        model: 'gpt-6.1-terra',
        inputTokens: 90,
        outputTokens: 35,
      }),
    );
    expect(await provider.complete(request({ model: 'gpt-6.1-terra' }))).toEqual({
      text: JSON_TEXT,
      provider: 'openai',
      model: 'gpt-6.1-terra',
      usage: { inputTokens: 90, outputTokens: 35 },
    });
  });

  it('sends a Responses API request with strict JSON schema, effort and no server-side storage', async () => {
    const { provider, http } = make(() => openAiResponse({ text: JSON_TEXT }));
    await provider.complete(request({ model: 'gpt-6.1-sol', effort: 'high' }));
    const call = http.calls[0]!;
    expect(call.url).toBe('https://api.openai.com/v1/responses');
    expect(call.headers.authorization).toBe('Bearer sk-openai-test-key');
    expect(call.body).toMatchObject({
      model: 'gpt-6.1-sol',
      instructions: 'SYSTEM PROMPT',
      input: 'USER PROMPT',
      max_output_tokens: 32_000,
      reasoning: { effort: 'high' },
      store: false,
      text: { format: { type: 'json_schema', name: 'subtitle_translations', strict: true } },
    });
    expect(call.body.temperature).toBeUndefined();
  });

  it('sends temperature only when configured', async () => {
    const { provider, http } = make(() => openAiResponse({ text: JSON_TEXT }));
    await provider.complete(request({ temperature: 0.3 }));
    expect(http.calls[0]?.body.temperature).toBe(0.3);
  });

  it.each([
    [401, 'invalid_api_key', 'auth'],
    [404, 'model_not_found', 'not_found'],
    [400, 'invalid_request_error', 'bad_request'],
    [429, 'rate_limit_exceeded', 'rate_limit'],
    [429, 'insufficient_quota', 'billing'],
    [500, 'server_error', 'server'],
    [503, 'overloaded', 'overloaded'],
  ])('maps HTTP %i (%s) to "%s"', async (status, code, kind) => {
    const { provider, http } = make(() => openAiError(status, code));
    expect(await failure(provider.complete(request()))).toMatchObject({
      provider: 'openai',
      kind,
      status,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('reads retry-after from a rate-limit response', async () => {
    const { provider } = make(() =>
      openAiError(429, 'rate_limit_exceeded', { 'retry-after': '2' }),
    );
    expect((await failure(provider.complete(request()))).retryAfterMs).toBe(2000);
  });

  it('reports truncated, filtered, refused and empty answers as errors', async () => {
    const cases: [Parameters<typeof openAiResponse>[0], string][] = [
      [{ status: 'incomplete', incompleteReason: 'max_output_tokens', text: '{"tr' }, 'truncated'],
      [{ status: 'incomplete', incompleteReason: 'content_filter' }, 'refusal'],
      [{ refusal: true }, 'refusal'],
      [{ text: '  ' }, 'empty'],
    ];
    for (const [reply, kind] of cases) {
      const { provider } = make(() => openAiResponse(reply));
      expect((await failure(provider.complete(request()))).kind, JSON.stringify(reply)).toBe(kind);
    }
  });

  it('reports an aborted request as cancelled and a transport failure as network', async () => {
    const aborted = make(() => openAiResponse({ text: JSON_TEXT }));
    expect(
      (await failure(aborted.provider.complete(request({ signal: AbortSignal.abort() })))).kind,
    ).toBe('cancelled');
    const offline = make(() => {
      throw new TypeError('fetch failed');
    });
    expect((await failure(offline.provider.complete(request()))).kind).toBe('network');
  });
});

describe('Gemini provider', () => {
  const make = (handler: Parameters<typeof fakeHttp>[0]) => {
    const http = fakeHttp(handler);
    return {
      http,
      provider: createGeminiProvider({ apiKey: 'gemini-test-key', fetch: http.fetch }),
    };
  };

  it('returns text, model and usage including thinking tokens', async () => {
    const { provider } = make(() =>
      geminiResponse({ text: JSON_TEXT, inputTokens: 80, outputTokens: 30, thoughtsTokens: 12 }),
    );
    expect(await provider.complete(request({ model: 'gemini-3.8-flash' }))).toEqual({
      text: JSON_TEXT,
      provider: 'gemini',
      model: 'gemini-3.8-flash',
      usage: { inputTokens: 80, outputTokens: 42 },
    });
  });

  it('sends a generateContent request with JSON schema, system instruction and thinking level', async () => {
    const { provider, http } = make(() => geminiResponse({ text: JSON_TEXT }));
    await provider.complete(
      request({ model: 'gemini-3.8-flash', effort: 'low', temperature: 0.2 }),
    );
    const call = http.calls[0]!;
    expect(call.url).toMatch(
      /^https:\/\/generativelanguage\.googleapis\.com\/v1(beta)?\/models\/gemini-3\.8-flash:generateContent$/,
    );
    expect(call.headers['x-goog-api-key']).toBe('gemini-test-key');
    expect(call.url).not.toContain('gemini-test-key');
    const body = call.body as {
      contents: { parts: { text: string }[] }[];
      systemInstruction: { parts: { text: string }[] };
      generationConfig: Record<string, unknown>;
    };
    expect(body.contents[0]?.parts[0]?.text).toBe('USER PROMPT');
    expect(body.systemInstruction.parts[0]?.text).toBe('SYSTEM PROMPT');
    expect(body.generationConfig).toMatchObject({
      responseMimeType: 'application/json',
      maxOutputTokens: 32_000,
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: 'LOW' },
    });
    expect(JSON.stringify(body.generationConfig)).toContain('translations');
  });

  it('does not send a thinking level to models that predate it', async () => {
    const { provider, http } = make(() => geminiResponse({ text: JSON_TEXT }));
    await provider.complete(request({ model: 'gemini-2.0-flash' }));
    const config = (http.calls[0]?.body as { generationConfig: Record<string, unknown> })
      .generationConfig;
    expect(config.thinkingConfig).toBeUndefined();
  });

  it.each([
    [400, 'API key not valid. Please pass a valid API key.', 'auth'],
    [403, 'Permission denied', 'auth'],
    [404, 'models/nope is not found', 'not_found'],
    [400, 'Invalid JSON payload', 'bad_request'],
    [429, 'Resource exhausted', 'rate_limit'],
    [500, 'Internal error', 'server'],
    [503, 'The model is overloaded', 'overloaded'],
  ])('maps HTTP %i (%s) to "%s"', async (status, message, kind) => {
    const { provider, http } = make(() => geminiError(status, message));
    expect(await failure(provider.complete(request()))).toMatchObject({
      provider: 'gemini',
      kind,
      status,
    });
    expect(http.calls).toHaveLength(1);
  });

  it('reports blocked, truncated and empty answers as errors', async () => {
    const cases: [Parameters<typeof geminiResponse>[0], string][] = [
      [{ blockReason: 'SAFETY' }, 'refusal'],
      [{ text: 'x', finishReason: 'SAFETY' }, 'refusal'],
      [{ text: 'x', finishReason: 'PROHIBITED_CONTENT' }, 'refusal'],
      [{ text: '{"tr', finishReason: 'MAX_TOKENS' }, 'truncated'],
      [{}, 'empty'],
    ];
    for (const [reply, kind] of cases) {
      const { provider } = make(() => geminiResponse(reply));
      expect((await failure(provider.complete(request()))).kind, JSON.stringify(reply)).toBe(kind);
    }
  });

  it('reports an aborted request as cancelled and a transport failure as network', async () => {
    const aborted = make(() => geminiResponse({ text: JSON_TEXT }));
    expect(
      (await failure(aborted.provider.complete(request({ signal: AbortSignal.abort() })))).kind,
    ).toBe('cancelled');
    const offline = make(() => {
      throw new TypeError('fetch failed');
    });
    expect((await failure(offline.provider.complete(request()))).kind).toBe('network');
  });
});

describe('all providers', () => {
  it('implement the same interface and identify themselves', () => {
    const providers: AiProvider[] = [
      createAnthropicProvider({ apiKey: 'k' }),
      createOpenAiProvider({ apiKey: 'k' }),
      createGeminiProvider({ apiKey: 'k' }),
    ];
    expect(providers.map((p) => p.id)).toEqual(['anthropic', 'openai', 'gemini']);
    for (const p of providers) expect(typeof p.complete).toBe('function');
  });
});
