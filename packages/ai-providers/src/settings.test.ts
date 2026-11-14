import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeConfig, loadConfig } from '@asc/config';
import { parseSrt } from '@asc/subtitle-parser';
import { containsCyrillic, translateSubtitle } from '@asc/translation-engine';
import {
  AllProvidersFailedError,
  createProviderManagerFromConfig,
  describeProviders,
  EMPTY_PRICING,
  estimateCost,
  findPrice,
  loadPricing,
  parsePricing,
  PricingError,
  ProviderConfigError,
  PROVIDERS,
  resolveTargets,
  segmentationFromConfig,
  type ProviderEvent,
} from './index.js';
import { fixtureText } from './test-fixtures.js';
import {
  anthropicError,
  anthropicStream,
  fakeHttp,
  geminiResponse,
  openAiResponse,
  translateFromPrompt,
  type RecordedCall,
} from './test-http.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-secret-key-value',
  OPENAI_API_KEY: 'sk-openai-secret-key-value',
  GEMINI_API_KEY: 'gemini-secret-key-value',
};
const config = (env: Record<string, string> = {}) =>
  loadConfig({ env: { ...KEYS, ...env }, rootDir: REPO_ROOT, useEnvFile: false });
const noSleep = () => Promise.resolve();

/** A fake of all three provider APIs whose "models" really translate the prompt. */
function fakeProviders(
  target: string,
  behaviour: { anthropic?: (call: RecordedCall) => Response | undefined } = {},
) {
  return fakeHttp((call) => {
    const host = new URL(call.url).host;
    if (host === 'api.anthropic.com') {
      const override = behaviour.anthropic?.(call);
      if (override) return override;
      const user = (call.body.messages as { content: string }[])[0]?.content ?? '';
      return anthropicStream({
        text: translateFromPrompt(user, target),
        model: String(call.body.model),
      });
    }
    if (host === 'api.openai.com') {
      return openAiResponse({
        text: translateFromPrompt(String(call.body.input), target),
        model: String(call.body.model),
      });
    }
    const contents = call.body.contents as { parts: { text: string }[] }[];
    return geminiResponse({ text: translateFromPrompt(contents[0]?.parts[0]?.text ?? '', target) });
  });
}

describe('configuration', () => {
  it('has safe defaults and reads provider settings from the environment', () => {
    const defaults = config();
    expect(defaults.ai).toMatchObject({
      provider: 'anthropic',
      model: undefined,
      fallbackProvider: undefined,
      effort: 'medium',
      temperature: undefined,
      maxOutputTokens: 32_000,
      maxSegmentEntries: 60,
      requestTimeoutMs: 180_000,
      maxRetries: 3,
      pricingFile: resolve(REPO_ROOT, 'config', 'pricing.json'),
    });
    const custom = config({
      AI_PROVIDER: 'gemini',
      AI_MODEL: 'gemini-4-argon',
      AI_FALLBACK_PROVIDER: 'openai',
      AI_FALLBACK_MODEL: 'gpt-6.1-terra',
      AI_EFFORT: 'high',
      AI_TEMPERATURE: '0.3',
      AI_MAX_SEGMENT_ENTRIES: '45',
    });
    expect(custom.ai).toMatchObject({
      provider: 'gemini',
      model: 'gemini-4-argon',
      fallbackProvider: 'openai',
      fallbackModel: 'gpt-6.1-terra',
      effort: 'high',
      temperature: 0.3,
      maxSegmentEntries: 45,
    });
  });

  it('rejects invalid provider settings', () => {
    expect(() => config({ AI_PROVIDER: 'skynet' })).toThrow(/AI_PROVIDER/);
    expect(() => config({ AI_EFFORT: 'extreme' })).toThrow(/AI_EFFORT/);
    expect(() => config({ AI_TEMPERATURE: 'hot' })).toThrow(/AI_TEMPERATURE/);
    expect(() => config({ AI_TEMPERATURE: '5' })).toThrow(/AI_TEMPERATURE/);
  });

  it('treats empty values as not set', () => {
    const c = loadConfig({
      env: { ANTHROPIC_API_KEY: '', AI_FALLBACK_PROVIDER: '', AI_TEMPERATURE: '', AI_MODEL: '' },
      rootDir: REPO_ROOT,
      useEnvFile: false,
    });
    expect(c.ai.apiKeys).toEqual({});
    expect(c.ai.fallbackProvider).toBeUndefined();
    expect(c.ai.temperature).toBeUndefined();
    expect(c.ai.model).toBeUndefined();
  });

  it('never exposes API keys in the loggable config or the provider overview', () => {
    const c = config();
    const loggable = JSON.stringify(describeConfig(c));
    const overview = JSON.stringify(describeProviders(c));
    for (const secret of Object.values(KEYS)) {
      expect(loggable).not.toContain(secret);
      expect(overview).not.toContain(secret);
    }
    expect(describeConfig(c).ai).toMatchObject({
      apiKeys: { anthropic: true, openai: true, gemini: true },
    });
  });

  it('describes which providers are usable', () => {
    const c = loadConfig({
      env: {
        OPENAI_API_KEY: KEYS.OPENAI_API_KEY,
        AI_PROVIDER: 'openai',
        AI_FALLBACK_PROVIDER: 'gemini',
      },
      rootDir: REPO_ROOT,
      useEnvFile: false,
    });
    expect(
      describeProviders(c).map((p) => [p.id, p.configured, p.isPreferred, p.isFallback]),
    ).toEqual([
      ['anthropic', false, false, false],
      ['openai', true, true, false],
      ['gemini', false, false, true],
    ]);
  });
});

describe('resolveTargets', () => {
  it('uses each provider’s default model unless one is configured', () => {
    expect(resolveTargets(config())).toEqual({
      primary: { provider: 'anthropic', model: PROVIDERS.anthropic.defaultModel },
      fallback: undefined,
    });
    expect(
      resolveTargets(config({ AI_MODEL: 'claude-sonnet-5-5', AI_FALLBACK_PROVIDER: 'gemini' })),
    ).toEqual({
      primary: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      fallback: { provider: 'gemini', model: PROVIDERS.gemini.defaultModel },
    });
  });

  it('lets a single request override provider, model and fallback', () => {
    const c = config({
      AI_MODEL: 'claude-sonnet-5-5',
      AI_FALLBACK_PROVIDER: 'openai',
      AI_FALLBACK_MODEL: 'gpt-6-luna',
    });
    // The configured model belongs to the configured provider, not to the override.
    expect(resolveTargets(c, { provider: 'gemini' }).primary).toEqual({
      provider: 'gemini',
      model: PROVIDERS.gemini.defaultModel,
    });
    expect(resolveTargets(c, { provider: 'openai', model: 'gpt-6.1-terra' }).primary).toEqual({
      provider: 'openai',
      model: 'gpt-6.1-terra',
    });
    expect(resolveTargets(c).fallback).toEqual({ provider: 'openai', model: 'gpt-6-luna' });
    expect(resolveTargets(c, { fallbackProvider: null }).fallback).toBeUndefined();
    expect(resolveTargets(c, { fallbackProvider: 'gemini' }).fallback).toEqual({
      provider: 'gemini',
      model: PROVIDERS.gemini.defaultModel,
    });
  });

  it('has a default model for every provider', () => {
    for (const p of Object.values(PROVIDERS)) {
      expect(p.defaultModel).not.toBe('');
      expect(p.suggestedModels.map((m) => m.id)).toContain(p.defaultModel);
    }
  });
});

describe('createProviderManagerFromConfig', () => {
  it('fails clearly when the selected provider has no key', () => {
    const c = loadConfig({ env: {}, rootDir: REPO_ROOT, useEnvFile: false });
    expect(() => createProviderManagerFromConfig(c)).toThrow(ProviderConfigError);
    expect(() => createProviderManagerFromConfig(c)).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(() =>
      createProviderManagerFromConfig(
        config(),
        { provider: 'anthropic' },
        { pricing: EMPTY_PRICING },
      ),
    ).not.toThrow();
  });

  it('adapts segment size to the owner’s maximum', () => {
    expect(segmentationFromConfig(config())).toMatchObject({
      minEntries: 30,
      targetEntries: 40,
      maxEntries: 60,
    });
    expect(segmentationFromConfig(config({ AI_MAX_SEGMENT_ENTRIES: '20' }))).toMatchObject({
      minEntries: 20,
      targetEntries: 20,
      maxEntries: 20,
    });
    expect(segmentationFromConfig(config({ AI_MAX_OUTPUT_TOKENS: '2048' })).maxChars).toBe(1024);
  });
});

describe('end to end: engine → manager → provider SDK → HTTP', () => {
  const srt = fixtureText('long-episode.srt');
  const source = parseSrt(srt);

  it.each([
    ['anthropic', 'claude-opus-5-5', 'api.anthropic.com'],
    ['openai', 'gpt-6.1-sol', 'api.openai.com'],
    ['gemini', 'gemini-3.8-flash', 'generativelanguage.googleapis.com'],
  ] as const)('translates a long subtitle through %s', async (provider, model, host) => {
    const http = fakeProviders('sr-Latn');
    const manager = createProviderManagerFromConfig(
      config({ AI_PROVIDER: provider }),
      {},
      { fetch: http.fetch },
    );
    const result = await translateSubtitle(
      { srt, sourceLanguage: 'en', targetLanguage: 'sr-Latn' },
      manager.translator,
      {
        segmentation: segmentationFromConfig(config()),
      },
    );

    expect(result.entries).toHaveLength(130);
    result.entries.forEach((entry, i) => {
      expect(entry.index).toBe(source.entries[i]?.index);
      expect(entry.startMs).toBe(source.entries[i]?.startMs);
      expect(entry.endMs).toBe(source.entries[i]?.endMs);
      expect(entry.text).not.toBe('');
    });
    expect(containsCyrillic(result.srt)).toBe(false);
    expect(result.metadata.models).toEqual([{ provider, model }]);
    expect(http.calls).toHaveLength(result.stats.segments);
    expect(http.calls.every((c) => new URL(c.url).host === host)).toBe(true);
    expect(result.stats.usage.inputTokens).toBeGreaterThan(0);
    // Cost comes from config/pricing.json, which prices every default model.
    expect(result.stats.costUsd).toBeGreaterThan(0);
    expect(manager.totals().costUsd).toBeCloseTo(result.stats.costUsd ?? -1, 6);
  });

  it('sends the engine prompt, not timestamps, to the provider', async () => {
    const http = fakeProviders('hr');
    const manager = createProviderManagerFromConfig(config(), {}, { fetch: http.fetch });
    await translateSubtitle(
      { srt: fixtureText('basic-movie.srt'), targetLanguage: 'hr' },
      manager.translator,
    );
    const body = JSON.stringify(http.calls[0]?.body);
    expect(body).toContain('professional subtitle translator');
    expect(body).toContain('Croatian');
    expect(body).not.toContain('-->');
    expect(body).not.toContain('00:00:12');
  });

  it('retries an overloaded provider and then falls back to the second provider', async () => {
    const http = fakeProviders('hr', { anthropic: () => anthropicError(529, 'overloaded_error') });
    const events: ProviderEvent[] = [];
    const manager = createProviderManagerFromConfig(
      config({ AI_FALLBACK_PROVIDER: 'openai', AI_MAX_RETRIES: '2' }),
      {},
      { fetch: http.fetch, sleep: noSleep, onEvent: (e) => events.push(e) },
    );
    const result = await translateSubtitle(
      { srt: fixtureText('basic-movie.srt'), targetLanguage: 'hr' },
      manager.translator,
    );
    expect(result.metadata.models).toEqual([{ provider: 'openai', model: 'gpt-6.1-sol' }]);
    const hosts = http.calls.map((c) => new URL(c.url).host);
    expect(hosts).toEqual([
      'api.anthropic.com',
      'api.anthropic.com',
      'api.anthropic.com',
      'api.openai.com',
    ]);
    expect(events.map((e) => e.type)).toEqual([
      'attempt_failed',
      'attempt_failed',
      'attempt_failed',
      'fallback',
      'completed',
    ]);
    expect(manager.totals()).toMatchObject({ calls: 1, failedCalls: 3 });
  });

  it('uses the fallback for every later segment once the preferred key is rejected', async () => {
    const http = fakeProviders('hr', {
      anthropic: () => anthropicError(401, 'authentication_error'),
    });
    const manager = createProviderManagerFromConfig(
      config({ AI_FALLBACK_PROVIDER: 'gemini' }),
      {},
      { fetch: http.fetch, sleep: noSleep },
    );
    const result = await translateSubtitle({ srt, targetLanguage: 'hr' }, manager.translator);
    expect(result.stats.segments).toBeGreaterThan(2);
    const hosts = http.calls.map((c) => new URL(c.url).host);
    expect(hosts.filter((h) => h === 'api.anthropic.com')).toHaveLength(1);
    expect(hosts.filter((h) => h === 'generativelanguage.googleapis.com')).toHaveLength(
      result.stats.segments,
    );
  });

  it('fails the translation with a clear error when no provider can answer', async () => {
    const http = fakeProviders('hr', {
      anthropic: () => anthropicError(401, 'authentication_error'),
    });
    const manager = createProviderManagerFromConfig(
      config(),
      {},
      { fetch: http.fetch, sleep: noSleep },
    );
    const error = await translateSubtitle(
      { srt: fixtureText('basic-movie.srt'), targetLanguage: 'hr' },
      manager.translator,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AllProvidersFailedError);
    expect((error as Error).message).toContain('anthropic: auth');
    expect((error as Error).message).not.toContain(KEYS.ANTHROPIC_API_KEY);
  });

  it('retries a segment when a real provider returns an incomplete translation', async () => {
    let call = 0;
    const http = fakeHttp((recorded) => {
      call++;
      const user = (recorded.body.messages as { content: string }[])[0]?.content ?? '';
      const full = JSON.parse(translateFromPrompt(user, 'hr')) as { translations: unknown[] };
      if (call === 1) full.translations.pop();
      return anthropicStream({ text: JSON.stringify(full) });
    });
    const manager = createProviderManagerFromConfig(config(), {}, { fetch: http.fetch });
    const result = await translateSubtitle(
      { srt: fixtureText('basic-movie.srt'), targetLanguage: 'hr' },
      manager.translator,
    );
    expect(result.stats).toMatchObject({ attempts: 2, retries: 1, entries: 12 });
    const retryPrompt = (http.calls[1]?.body.messages as { content: string }[])[0]?.content ?? '';
    expect(retryPrompt).toContain('Your previous answer for this part was rejected');
    // Both attempts are paid for.
    expect(manager.totals().calls).toBe(2);
  });
});

describe('pricing', () => {
  it('ships a valid pricing file that covers every default model', () => {
    const pricing = loadPricing(resolve(REPO_ROOT, 'config', 'pricing.json'));
    for (const p of Object.values(PROVIDERS)) {
      expect(findPrice(pricing, p.id, p.defaultModel), `${p.id}/${p.defaultModel}`).toBeDefined();
    }
    expect(findPrice(pricing, 'anthropic', 'claude-opus-5-5')).toEqual({
      inputPerMTok: 4,
      outputPerMTok: 20,
    });
  });

  it('estimates cost from token usage', () => {
    const pricing = parsePricing({
      models: { openai: { m: { inputPerMTok: 2, outputPerMTok: 10 } } },
    });
    expect(estimateCost(pricing, 'openai', 'm', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(
      2,
    );
    expect(
      estimateCost(pricing, 'openai', 'm', { inputTokens: 12_345, outputTokens: 6789 }),
    ).toBeCloseTo(0.09258, 8);
    expect(
      estimateCost(pricing, 'openai', 'unknown-model', { inputTokens: 1, outputTokens: 1 }),
    ).toBeUndefined();
    expect(
      estimateCost(pricing, 'gemini', 'm', { inputTokens: 1, outputTokens: 1 }),
    ).toBeUndefined();
    expect(estimateCost(pricing, 'openai', 'm', undefined)).toBeUndefined();
  });

  it('is configurable: a custom file changes the estimate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-pricing-'));
    const file = join(dir, 'pricing.json');
    writeFileSync(
      file,
      JSON.stringify({
        models: { anthropic: { 'claude-opus-5-5': { inputPerMTok: 100, outputPerMTok: 0 } } },
      }),
    );
    const c = config({ PRICING_FILE: file });
    expect(c.ai.pricingFile).toBe(file);
    expect(
      estimateCost(loadPricing(file), 'anthropic', 'claude-opus-5-5', {
        inputTokens: 10_000,
        outputTokens: 5,
      }),
    ).toBe(1);
  });

  it('treats a missing file as "no prices" and rejects a malformed one', () => {
    expect(loadPricing(join(tmpdir(), 'does-not-exist.json'))).toEqual(EMPTY_PRICING);
    const dir = mkdtempSync(join(tmpdir(), 'asc-pricing-'));
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    expect(() => loadPricing(join(dir, 'broken.json'))).toThrow(PricingError);
    expect(() =>
      parsePricing({ models: { openai: { m: { inputPerMTok: -1, outputPerMTok: 1 } } } }),
    ).toThrow(/Invalid pricing data/);
  });
});
