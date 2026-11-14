import { describe, expect, it } from 'vitest';
import type { LlmResponse } from '@asc/translation-engine';
import {
  AllProvidersFailedError,
  createProviderManager,
  parsePricing,
  ProviderConfigError,
  ProviderError,
  type AiProvider,
  type AiProviderId,
  type ProviderErrorKind,
  type ProviderEvent,
  type ProviderManagerOptions,
  type ProviderRequest,
} from './index.js';

type Step = ProviderErrorKind | 'ok' | 'hang' | { kind: ProviderErrorKind; retryAfterMs: number };

/** Provider double that plays a script of outcomes, one per call. */
function scripted(id: AiProviderId, script: Step[]) {
  const requests: ProviderRequest[] = [];
  const provider: AiProvider = {
    id,
    async complete(request): Promise<LlmResponse> {
      requests.push(request);
      const step = script[Math.min(requests.length - 1, script.length - 1)] ?? 'ok';
      if (step === 'ok') {
        return {
          text: `answer from ${id}`,
          provider: id,
          model: request.model,
          usage: { inputTokens: 1000, outputTokens: 500 },
        };
      }
      if (step === 'hang') {
        await new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')));
        });
      }
      const spec =
        typeof step === 'string'
          ? { kind: step as ProviderErrorKind, retryAfterMs: undefined }
          : step;
      throw new ProviderError(id, spec.kind, `simulated ${spec.kind}`, {
        ...(spec.retryAfterMs === undefined ? {} : { retryAfterMs: spec.retryAfterMs }),
      });
    },
  };
  return { provider, requests };
}

function setup(
  primaryScript: Step[],
  fallbackScript?: Step[],
  overrides: Partial<ProviderManagerOptions> = {},
) {
  const primary = scripted('anthropic', primaryScript);
  const fallback = fallbackScript ? scripted('openai', fallbackScript) : undefined;
  const events: ProviderEvent[] = [];
  const sleeps: number[] = [];
  const manager = createProviderManager({
    providers: { anthropic: primary.provider, ...(fallback ? { openai: fallback.provider } : {}) },
    primary: { provider: 'anthropic', model: 'claude-opus-5-5' },
    fallback: fallback ? { provider: 'openai', model: 'gpt-6.1-sol' } : undefined,
    effort: 'medium',
    maxOutputTokens: 32_000,
    requestTimeoutMs: 10_000,
    onEvent: (e) => events.push(e),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
    ...overrides,
  });
  return { manager, primary, fallback, events, sleeps };
}
const ask = { system: 'S', user: 'U' };

describe('provider manager — success path', () => {
  it('calls the preferred provider with the configured model and settings', async () => {
    const { manager, primary, fallback } = setup(['ok'], ['ok'], {
      effort: 'high',
      temperature: 0.2,
    });
    const response = await manager.complete(ask);
    expect(response).toMatchObject({
      text: 'answer from anthropic',
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    });
    expect(primary.requests[0]).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'S',
      user: 'U',
      effort: 'high',
      temperature: 0.2,
      maxOutputTokens: 32_000,
    });
    expect(primary.requests[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fallback?.requests).toHaveLength(0);
    expect(manager.targets).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5-5' },
      { provider: 'openai', model: 'gpt-6.1-sol' },
    ]);
  });

  it('tracks token usage and estimated cost', async () => {
    const pricing = parsePricing({
      models: { anthropic: { 'claude-opus-5-5': { inputPerMTok: 4, outputPerMTok: 20 } } },
    });
    const { manager, events } = setup(['ok'], undefined, { pricing });
    const first = await manager.complete(ask);
    await manager.complete(ask);
    // 1000 in × $4/M + 500 out × $20/M = $0.014
    expect(first.costUsd).toBeCloseTo(0.014, 10);
    expect(manager.totals()).toEqual({
      calls: 2,
      failedCalls: 0,
      inputTokens: 2000,
      outputTokens: 1000,
      costUsd: 0.028,
    });
    expect(events.filter((e) => e.type === 'completed')).toHaveLength(2);
  });

  it('reports an unknown cost when the model has no configured price', async () => {
    const { manager } = setup(['ok']);
    const response = await manager.complete(ask);
    expect(response.costUsd).toBeUndefined();
    expect(manager.totals().costUsd).toBeNull();
  });
});

describe('provider manager — retries', () => {
  it.each(['rate_limit', 'timeout', 'network', 'server', 'overloaded'] as const)(
    'retries a transient "%s" failure with exponential backoff',
    async (kind) => {
      const { manager, primary, events, sleeps } = setup([kind, kind, 'ok']);
      const response = await manager.complete(ask);
      expect(response.provider).toBe('anthropic');
      expect(primary.requests).toHaveLength(3);
      expect(sleeps).toEqual([1000, 2000]);
      const failed = events.filter((e) => e.type === 'attempt_failed');
      expect(failed.map((e) => [e.attempt, e.kind, e.retryInMs])).toEqual([
        [1, kind, 1000],
        [2, kind, 2000],
      ]);
      expect(manager.totals()).toMatchObject({ calls: 1, failedCalls: 2 });
    },
  );

  it('adds jitter and caps the backoff', async () => {
    const { manager, sleeps } = setup(['server', 'server', 'server', 'server', 'ok'], undefined, {
      random: () => 0,
      retry: { maxRetries: 4, baseDelayMs: 1000, maxDelayMs: 3000 },
    });
    await manager.complete(ask);
    expect(sleeps).toEqual([500, 1000, 1500, 1500]);
  });

  it('waits exactly as long as the provider asks (retry-after)', async () => {
    const { manager, sleeps } = setup([{ kind: 'rate_limit', retryAfterMs: 7000 }, 'ok']);
    await manager.complete(ask);
    expect(sleeps).toEqual([7000]);
  });

  it('does not wait out an unreasonably long retry-after: it falls back instead', async () => {
    const { manager, primary, sleeps } = setup(
      [{ kind: 'rate_limit', retryAfterMs: 3_600_000 }],
      ['ok'],
    );
    const response = await manager.complete(ask);
    expect(response.provider).toBe('openai');
    expect(primary.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('gives up after the retry limit when there is no fallback', async () => {
    const { manager, primary } = setup(['server'], undefined, { retry: { maxRetries: 2 } });
    const error = await manager.complete(ask).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllProvidersFailedError);
    expect((error as AllProvidersFailedError).last).toMatchObject({
      provider: 'anthropic',
      kind: 'server',
    });
    expect(primary.requests).toHaveLength(3);
  });

  it('retries a provider that does not answer in time (timeout)', async () => {
    const { manager, primary, events } = setup(['hang', 'ok'], undefined, { requestTimeoutMs: 30 });
    const response = await manager.complete(ask);
    expect(response.provider).toBe('anthropic');
    expect(primary.requests).toHaveLength(2);
    expect(primary.requests[0]?.signal?.aborted).toBe(true);
    expect(events[0]).toMatchObject({ type: 'attempt_failed', kind: 'timeout', attempt: 1 });
  });
});

describe('provider manager — fallback', () => {
  it('falls back after the preferred provider keeps timing out', async () => {
    const { manager, primary, fallback, events } = setup(['hang'], ['ok'], {
      requestTimeoutMs: 20,
      retry: { maxRetries: 1 },
    });
    const response = await manager.complete(ask);
    expect(response).toMatchObject({
      provider: 'openai',
      model: 'gpt-6.1-sol',
      text: 'answer from openai',
    });
    expect(primary.requests).toHaveLength(2);
    expect(fallback?.requests).toHaveLength(1);
    expect(fallback?.requests[0]?.model).toBe('gpt-6.1-sol');
    expect(events.map((e) => e.type)).toEqual([
      'attempt_failed',
      'attempt_failed',
      'fallback',
      'completed',
    ]);
    expect(events[2]).toMatchObject({
      type: 'fallback',
      from: { provider: 'anthropic' },
      to: { provider: 'openai', model: 'gpt-6.1-sol' },
      reason: 'timeout',
    });
  });

  it.each(['refusal', 'truncated', 'empty', 'bad_request', 'unknown'] as const)(
    'falls back immediately on a non-transient "%s" failure, without retrying',
    async (kind) => {
      const { manager, primary, sleeps } = setup([kind], ['ok']);
      const response = await manager.complete(ask);
      expect(response.provider).toBe('openai');
      expect(primary.requests).toHaveLength(1);
      expect(sleeps).toEqual([]);
    },
  );

  it('keeps using the preferred provider for later requests after a one-off failure', async () => {
    const { manager, primary, fallback } = setup(['refusal', 'ok'], ['ok']);
    expect((await manager.complete(ask)).provider).toBe('openai');
    expect((await manager.complete(ask)).provider).toBe('anthropic');
    expect(primary.requests).toHaveLength(2);
    expect(fallback?.requests).toHaveLength(1);
  });

  it.each(['auth', 'billing', 'not_found'] as const)(
    'stops calling a provider whose configuration is broken (%s)',
    async (kind) => {
      const { manager, primary, fallback, events } = setup([kind], ['ok']);
      for (let i = 0; i < 3; i++) expect((await manager.complete(ask)).provider).toBe('openai');
      expect(primary.requests).toHaveLength(1);
      expect(fallback?.requests).toHaveLength(3);
      expect(events.filter((e) => e.type === 'provider_disabled')).toEqual([
        { type: 'provider_disabled', provider: 'anthropic', reason: kind },
      ]);
    },
  );

  it('retries the fallback provider with the same policy', async () => {
    const { manager, fallback, sleeps } = setup(['refusal'], ['overloaded', 'ok']);
    expect((await manager.complete(ask)).provider).toBe('openai');
    expect(fallback?.requests).toHaveLength(2);
    expect(sleeps).toEqual([1000]);
  });

  it('fails with every cause when all providers fail', async () => {
    const { manager } = setup(['auth'], ['server'], { retry: { maxRetries: 1 } });
    const error = (await manager.complete(ask).catch((e: unknown) => e)) as AllProvidersFailedError;
    expect(error).toBeInstanceOf(AllProvidersFailedError);
    expect(error.errors.map((e) => [e.provider, e.kind])).toEqual([
      ['anthropic', 'auth'],
      ['openai', 'server'],
    ]);
    expect(error.message).toContain('anthropic: auth');
    expect(error.message).toContain('openai: server');
    expect(error.last.provider).toBe('openai');
  });

  it('ignores a fallback identical to the preferred provider and model', () => {
    const { provider } = scripted('anthropic', ['ok']);
    const manager = createProviderManager({
      providers: { anthropic: provider },
      primary: { provider: 'anthropic', model: 'm' },
      fallback: { provider: 'anthropic', model: 'm' },
      effort: 'medium',
      maxOutputTokens: 1000,
      requestTimeoutMs: 1000,
    });
    expect(manager.targets).toHaveLength(1);
  });

  it('supports a second model of the same provider as fallback', async () => {
    const primary = scripted('anthropic', ['refusal', 'ok']);
    const manager = createProviderManager({
      providers: { anthropic: primary.provider },
      primary: { provider: 'anthropic', model: 'claude-opus-5-5' },
      fallback: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      effort: 'medium',
      maxOutputTokens: 1000,
      requestTimeoutMs: 1000,
    });
    expect((await manager.complete(ask)).model).toBe('claude-sonnet-5-5');
    expect(primary.requests.map((r) => r.model)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
  });
});

describe('provider manager — cancellation', () => {
  it('does not retry or fall back when the caller cancels', async () => {
    const controller = new AbortController();
    const { manager, primary, fallback } = setup(['hang'], ['ok']);
    const promise = manager.complete({ ...ask, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    const error = (await promise.catch((e: unknown) => e)) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('cancelled');
    expect(primary.requests).toHaveLength(1);
    expect(fallback?.requests).toHaveLength(0);
  });

  it('stops while waiting between retries', async () => {
    const controller = new AbortController();
    const { manager, primary } = setup(['server'], ['ok'], {
      sleep: (_ms, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          controller.abort();
        }),
    });
    const error = (await manager
      .complete({ ...ask, signal: controller.signal })
      .catch((e: unknown) => e)) as ProviderError;
    expect(error.kind).toBe('cancelled');
    expect(primary.requests).toHaveLength(1);
  });

  it('makes no call when already cancelled', async () => {
    const { manager, primary } = setup(['ok']);
    await expect(manager.complete({ ...ask, signal: AbortSignal.abort() })).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(primary.requests).toHaveLength(0);
  });
});

describe('provider manager — configuration', () => {
  const base = { effort: 'medium' as const, maxOutputTokens: 1000, requestTimeoutMs: 1000 };

  it('refuses a selected provider that has no API key', () => {
    expect(() =>
      createProviderManager({
        ...base,
        providers: {},
        primary: { provider: 'gemini', model: 'm' },
      }),
    ).toThrow(ProviderConfigError);
    const { provider } = scripted('anthropic', ['ok']);
    expect(() =>
      createProviderManager({
        ...base,
        providers: { anthropic: provider },
        primary: { provider: 'anthropic', model: 'm' },
        fallback: { provider: 'openai', model: 'm' },
      }),
    ).toThrow(/"openai" is selected but has no API key/);
  });

  it('refuses an empty model id', () => {
    const { provider } = scripted('anthropic', ['ok']);
    expect(() =>
      createProviderManager({
        ...base,
        providers: { anthropic: provider },
        primary: { provider: 'anthropic', model: ' ' },
      }),
    ).toThrow(/No model configured/);
  });
});
