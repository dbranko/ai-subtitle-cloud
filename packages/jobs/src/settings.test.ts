import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@asc/config';
import { resolveTargets } from '@asc/ai-providers';
import {
  applySettings,
  createJob,
  decryptSecret,
  encryptSecret,
  JobRequestError,
  SettingsError,
  SettingsProvider,
} from './index.js';
import { fixtureText } from './test-fixtures.js';
import { createContext, type TestContext } from './test-helpers.js';

let ctx: TestContext;
let settings: SettingsProvider;
beforeEach(async () => {
  ctx = await createContext({ MOCK_AI: 'false' });
  settings = new SettingsProvider(ctx.db, ctx.config, 0);
});
afterEach(async () => {
  await ctx.cleanup();
});

const SECRET = 'sk-ant-a-very-secret-api-key-value-1234';

describe('settings — defaults', () => {
  it('shows the environment configuration when nothing was saved', async () => {
    const view = await settings.view();
    expect(view.ai).toEqual({
      provider: 'anthropic',
      model: null,
      fallbackProvider: null,
      fallbackModel: null,
      effort: 'medium',
      temperature: null,
      maxSegmentEntries: 60,
      translationProfile: 'natural',
    });
    expect(view.apiKeys.anthropic).toEqual({ configured: false, source: null, hint: null });
    expect(view.stremio).toMatchObject({
      targetLanguages: ['sr-Latn'],
      autoTranslate: false,
      dailyJobLimit: 20,
    });
    expect(view.sources.languages).toEqual(['en']);
    expect(view.defaults).toEqual({ targetLanguage: 'sr-Latn', customInstructions: '' });
    expect(view.cache).toMatchObject({
      maxAgeDays: 0,
      maxSizeMb: 0,
      cacheDirectory: ctx.config.paths.cacheDir,
    });
    expect(await settings.config()).toEqual(ctx.config);
  });

  it('reports keys that come from the environment without revealing them', async () => {
    const withEnv = loadConfig({
      env: { ANTHROPIC_API_KEY: SECRET, OPENSUBTITLES_API_KEY: 'os-key-from-environment' },
      rootDir: ctx.config.rootDir,
      useEnvFile: false,
    });
    const view = await new SettingsProvider(ctx.db, withEnv, 0).view();
    expect(view.apiKeys.anthropic).toEqual({
      configured: true,
      source: 'environment',
      hint: '…1234',
    });
    expect(view.sources.openSubtitles.apiKey).toMatchObject({
      configured: true,
      source: 'environment',
    });
    expect(JSON.stringify(view)).not.toContain(SECRET);
  });
});

describe('settings — saving', () => {
  it('saves provider, models, languages and limits, and applies them to the configuration', async () => {
    const view = await settings.update({
      ai: {
        provider: 'openai',
        model: 'gpt-6.1-terra',
        fallbackProvider: 'gemini',
        fallbackModel: null,
        effort: 'high',
        temperature: 0.4,
        maxSegmentEntries: 45,
        translationProfile: 'cinematic',
      },
      sources: { languages: ['en', 'de'], openSubtitlesUsername: 'owner' },
      cache: { maxAgeDays: 90, maxSizeMb: 500 },
      stremio: {
        targetLanguages: ['sr-Latn', 'sr-Cyrl'],
        autoTranslate: false,
        dailyJobLimit: 5,
        languageLabels: { 'sr-Cyrl': 'Српски' },
      },
      defaults: { targetLanguage: 'sr-Cyrl', customInstructions: 'Use informal address.' },
    });
    expect(view.ai).toMatchObject({
      provider: 'openai',
      model: 'gpt-6.1-terra',
      fallbackProvider: 'gemini',
      effort: 'high',
      temperature: 0.4,
    });
    expect(view.defaults).toEqual({
      targetLanguage: 'sr-Cyrl',
      customInstructions: 'Use informal address.',
    });

    const config = await settings.config();
    expect(config.ai).toMatchObject({
      provider: 'openai',
      model: 'gpt-6.1-terra',
      fallbackProvider: 'gemini',
      fallbackModel: undefined,
      effort: 'high',
      temperature: 0.4,
      maxSegmentEntries: 45,
      translationProfile: 'cinematic',
    });
    expect(resolveTargets(config)).toEqual({
      primary: { provider: 'openai', model: 'gpt-6.1-terra' },
      fallback: { provider: 'gemini', model: 'gemini-3.8-flash' },
    });
    expect(config.sources.languages).toEqual(['en', 'de']);
    expect(config.sources.openSubtitles.username).toBe('owner');
    expect(config.cache).toEqual({ maxAgeDays: 90, maxSizeMb: 500 });
    expect(config.stremio).toMatchObject({
      targetLanguages: ['sr-Latn', 'sr-Cyrl'],
      autoTranslate: false,
      dailyJobLimit: 5,
      profile: 'cinematic', // follows the default profile unless set separately
      languageLabels: { 'sr-Cyrl': 'Српски' },
    });
    // What cannot be changed here stays exactly as the environment says.
    expect(config.paths).toEqual(ctx.config.paths);
    expect(config.api).toEqual(ctx.config.api);
    expect(config.security).toEqual(ctx.config.security);
  });

  it('changes only what a request mentions', async () => {
    await settings.update({ ai: { provider: 'gemini', effort: 'low' } });
    await settings.update({ ai: { effort: 'high' }, cache: { maxAgeDays: 30 } });
    const view = await settings.view();
    expect(view.ai).toMatchObject({ provider: 'gemini', effort: 'high' });
    expect(view.cache).toMatchObject({ maxAgeDays: 30, maxSizeMb: 0 });
  });

  it('lets a value be cleared explicitly', async () => {
    await settings.update({
      ai: { model: 'claude-haiku-5-5', fallbackProvider: 'openai', temperature: 1 },
    });
    await settings.update({ ai: { model: null, fallbackProvider: null, temperature: null } });
    expect((await settings.view()).ai).toMatchObject({
      model: null,
      fallbackProvider: null,
      temperature: null,
    });
  });

  it('survives a restart and is seen by other processes', async () => {
    await settings.update({ ai: { provider: 'openai' }, stremio: { targetLanguages: ['hr'] } });
    // Another process (the worker, the add-on) has its own provider over the same database.
    const other = new SettingsProvider(ctx.db, ctx.config, 0);
    expect((await other.config()).ai.provider).toBe('openai');
    expect((await other.config()).stremio.targetLanguages).toEqual(['hr']);
  });

  it.each([
    ['unknown provider', { ai: { provider: 'skynet' } }, /ai\.provider/],
    ['bad effort', { ai: { effort: 'extreme' } }, /ai\.effort/],
    ['temperature out of range', { ai: { temperature: 9 } }, /ai\.temperature/],
    ['segment size out of range', { ai: { maxSegmentEntries: 2 } }, /maxSegmentEntries/],
    ['unknown profile', { ai: { translationProfile: 'poetic' } }, /translationProfile/],
    [
      'Bosnian as a Stremio target',
      { stremio: { targetLanguages: ['sr-Latn', 'bs'] } },
      /not available as a target/,
    ],
    ['bare Serbian as default target', { defaults: { targetLanguage: 'sr' } }, /explicit script/],
    ['unknown source language', { sources: { languages: ['xx'] } }, /Unknown source language/],
    ['no source language', { sources: { languages: [] } }, /sources\.languages/],
    [
      'custom profile without instructions',
      { ai: { translationProfile: 'custom' } },
      /needs style instructions/,
    ],
    ['negative limit', { stremio: { dailyJobLimit: -1 } }, /dailyJobLimit/],
    ['not an object', 'nonsense', /settings/],
  ])('rejects %s and keeps the previous settings', async (_name, patch, message) => {
    await settings.update({ ai: { effort: 'low' } });
    await expect(settings.update(patch)).rejects.toThrow(SettingsError);
    await expect(settings.update(patch)).rejects.toThrow(message);
    expect((await settings.view()).ai.effort).toBe('low');
    expect((await settings.view()).stremio.targetLanguages).toEqual(['sr-Latn']);
  });

  it('accepts the custom profile once instructions exist', async () => {
    await settings.update({
      ai: { translationProfile: 'custom' },
      defaults: { customInstructions: 'Keep it formal.' },
    });
    expect((await settings.config()).ai.translationProfile).toBe('custom');
  });
});

describe('settings — secrets', () => {
  it('stores API keys encrypted and never returns them', async () => {
    const view = await settings.update({
      secrets: {
        anthropic: SECRET,
        opensubtitles: 'os-secret-key-0000',
        opensubtitlesPassword: 'hunter2',
      },
    });
    expect(view.apiKeys.anthropic).toEqual({ configured: true, source: 'settings', hint: '…1234' });
    expect(view.sources.openSubtitles.apiKey).toMatchObject({
      configured: true,
      source: 'settings',
    });
    // A password gets no hint at all, and a short value none either.
    expect(view.sources.openSubtitles.password).toEqual({
      configured: true,
      source: 'settings',
      hint: null,
    });
    const text = JSON.stringify(view);
    for (const secret of [SECRET, 'os-secret-key-0000', 'hunter2'])
      expect(text).not.toContain(secret);

    // In the database there is only ciphertext.
    const rows = await ctx.db.setting.findMany();
    const stored = JSON.stringify(rows);
    for (const secret of [SECRET, 'os-secret-key-0000', 'hunter2'])
      expect(stored).not.toContain(secret);
    expect(rows.find((r) => r.key === 'secret:anthropic')?.value).toMatch(/^v1:/);

    // …but the processes get the real values.
    const config = await settings.config();
    expect(config.ai.apiKeys.anthropic).toBe(SECRET);
    expect(config.sources.openSubtitles).toMatchObject({
      apiKey: 'os-secret-key-0000',
      password: 'hunter2',
    });
  });

  it('keeps the encryption key in a private file outside the database', async () => {
    await settings.update({ secrets: { openai: 'sk-openai-secret-000000' } });
    const keyFile = join(ctx.config.paths.dataDir, 'secret.key');
    expect(existsSync(keyFile)).toBe(true);
    expect(Buffer.from(readFileSync(keyFile, 'utf8'), 'base64')).toHaveLength(32);
    if (process.platform !== 'win32') expect(statSync(keyFile).mode & 0o077).toBe(0);
  });

  it('prefers a saved key over the environment and falls back when it is removed', async () => {
    const withEnv = loadConfig({
      env: { OPENAI_API_KEY: 'sk-from-environment-0001' },
      rootDir: ctx.config.rootDir,
      useEnvFile: false,
    });
    const provider = new SettingsProvider(ctx.db, withEnv, 0);
    await provider.update({ secrets: { openai: 'sk-from-dashboard-0002' } });
    expect((await provider.config()).ai.apiKeys.openai).toBe('sk-from-dashboard-0002');
    expect((await provider.view()).apiKeys.openai.source).toBe('settings');

    await provider.update({ secrets: { openai: null } });
    expect((await provider.config()).ai.apiKeys.openai).toBe('sk-from-environment-0001');
    expect((await provider.view()).apiKeys.openai.source).toBe('environment');
  });

  it('leaves other secrets untouched when one is changed', async () => {
    await settings.update({ secrets: { anthropic: SECRET, gemini: 'gemini-secret-key-0003' } });
    await settings.update({ secrets: { gemini: null }, ai: { effort: 'high' } });
    const config = await settings.config();
    expect(config.ai.apiKeys).toEqual({ anthropic: SECRET });
  });

  it('treats a secret it cannot decrypt as not configured instead of failing', async () => {
    await settings.update({ secrets: { anthropic: SECRET } });
    rmSync(join(ctx.config.paths.dataDir, 'secret.key')); // e.g. the database was copied without the key
    const fresh = new SettingsProvider(ctx.db, ctx.config, 0);
    expect((await fresh.view()).apiKeys.anthropic.configured).toBe(false);
    expect((await fresh.config()).ai.apiKeys.anthropic).toBeUndefined();
  });

  it('encrypts with authentication: a changed value is rejected', () => {
    const key = Buffer.alloc(32, 7);
    const sealed = encryptSecret(key, 'hello');
    expect(decryptSecret(key, sealed)).toBe('hello');
    expect(encryptSecret(key, 'hello')).not.toBe(sealed); // fresh nonce every time
    expect(decryptSecret(Buffer.alloc(32, 8), sealed)).toBeUndefined();
    expect(decryptSecret(key, sealed.slice(0, -4) + 'AAAA')).toBeUndefined();
    expect(decryptSecret(key, 'garbage')).toBeUndefined();
  });
});

describe('settings — effect on new work', () => {
  const srt = fixtureText('basic-movie.srt');

  it('makes a provider usable as soon as its key is saved', async () => {
    await expect(
      createJob(ctx.db, await settings.config(), { srt, targetLanguage: 'hr' }),
    ).rejects.toThrow(JobRequestError);
    await settings.update({
      ai: { provider: 'openai', model: 'gpt-6.1-terra' },
      secrets: { openai: 'sk-openai-secret-000000' },
    });
    const { job } = await createJob(ctx.db, await settings.config(), { srt, targetLanguage: 'hr' });
    expect(job).toMatchObject({ provider: 'openai', model: 'gpt-6.1-terra' });
  });

  it('is a pure overlay: applying nothing changes nothing', () => {
    expect(
      applySettings(ctx.config, { ai: {}, sources: {}, cache: {}, stremio: {}, defaults: {} }, {}),
    ).toEqual(ctx.config);
  });
});
