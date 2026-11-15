import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AI_EFFORT_LEVELS, AI_PROVIDER_IDS, type AiProviderId, type AppConfig } from '@asc/config';
import type { Database } from '@asc/database';
import {
  resolveSourceLanguage,
  resolveTargetLanguage,
  TRANSLATION_PROFILES,
} from '@asc/translation-engine';

/**
 * Settings the owner changes from the dashboard.
 *
 * The environment (.env) provides the starting configuration; whatever is
 * saved here overrides it and takes effect without a restart. Ports, paths and
 * the access token stay in the environment on purpose: changing them at
 * runtime would cut the dashboard off from the server it is talking to.
 */

// ---------------------------------------------------------------------------
// Secrets at rest
// ---------------------------------------------------------------------------

export const SECRET_NAMES = [
  'anthropic',
  'openai',
  'gemini',
  'opensubtitles',
  'opensubtitlesPassword',
] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

/**
 * Key used to encrypt secrets in the database: 32 random bytes in
 * `<data dir>/secret.key`, created on first use and readable by the owner
 * only. A copy of the database alone therefore does not reveal any API key.
 */
function loadSecretKey(config: AppConfig): Buffer {
  const file = join(config.paths.dataDir, 'secret.key');
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    try {
      // `wx`: fail instead of overwriting if another process created it at the same moment.
      writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('The secret key file is damaged (secret.key).');
  return key;
}

export function encryptSecret(key: Buffer, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    data.toString('base64'),
  ].join(':');
}

/** Returns undefined when the value cannot be decrypted (wrong key, damaged data). */
export function decryptSecret(key: Buffer, stored: string): string | undefined {
  const [version, iv, tag, data] = stored.split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) return undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Stored shape and validation
// ---------------------------------------------------------------------------

const provider = z.enum(AI_PROVIDER_IDS);
const model = z.string().trim().min(1).max(100);
const languageList = z.array(z.string().trim().min(1).max(20)).max(20);

const storedSchema = z.object({
  ai: z
    .object({
      provider,
      /** null = the provider's default model. */
      model: model.nullable(),
      /** null = no fallback. */
      fallbackProvider: provider.nullable(),
      fallbackModel: model.nullable(),
      effort: z.enum(AI_EFFORT_LEVELS),
      /** null = provider default. */
      temperature: z.number().min(0).max(2).nullable(),
      maxSegmentEntries: z.number().int().min(5).max(200),
      translationProfile: z.enum(TRANSLATION_PROFILES),
    })
    .partial()
    .default({}),
  sources: z
    .object({
      languages: languageList.min(1),
      openSubtitlesUsername: z.string().trim().max(200).nullable(),
    })
    .partial()
    .default({}),
  cache: z
    .object({
      maxAgeDays: z.number().int().min(0).max(100_000),
      maxSizeMb: z.number().int().min(0).max(10_000_000),
    })
    .partial()
    .default({}),
  stremio: z
    .object({
      targetLanguages: languageList,
      autoTranslate: z.boolean(),
      dailyJobLimit: z.number().int().min(0).max(100_000),
      profile: z.enum(TRANSLATION_PROFILES),
      languageLabels: z.record(z.string().max(20), z.string().trim().min(1).max(60)),
    })
    .partial()
    .default({}),
  defaults: z
    .object({
      /** Target language preselected in the dashboard. */
      targetLanguage: z.string().trim().min(1).max(20),
      /** Style instructions used with the custom profile (and offered as a default). */
      customInstructions: z.string().trim().max(2000),
    })
    .partial()
    .default({}),
});
export type StoredSettings = z.infer<typeof storedSchema>;

const secretValue = z.string().trim().min(1).max(500).nullable();
/** A change request: any subset of the stored settings, plus secrets to set (string) or remove (null). */
export const settingsPatchSchema = storedSchema
  .extend({
    secrets: z
      .object(
        Object.fromEntries(SECRET_NAMES.map((n) => [n, secretValue])) as Record<
          SecretName,
          typeof secretValue
        >,
      )
      .partial(),
  })
  .partial();
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export class SettingsError extends Error {
  override name = 'SettingsError';
}

/** Checks that need knowledge of languages and profiles. Throws SettingsError with a readable reason. */
function validateStored(settings: StoredSettings): void {
  const check = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      throw new SettingsError(err instanceof Error ? err.message : 'Invalid setting.');
    }
  };
  for (const id of settings.stremio.targetLanguages ?? []) check(() => resolveTargetLanguage(id));
  if (settings.defaults.targetLanguage)
    check(() => resolveTargetLanguage(settings.defaults.targetLanguage ?? ''));
  for (const id of settings.sources.languages ?? []) {
    check(() => {
      if (!resolveSourceLanguage(id)) throw new Error(`"${id}" is not a source language.`);
    });
  }
  for (const id of Object.keys(settings.stremio.languageLabels ?? {}))
    check(() => resolveTargetLanguage(id));
  const usesCustom =
    settings.ai.translationProfile === 'custom' || settings.stremio.profile === 'custom';
  if (usesCustom && !settings.defaults.customInstructions) {
    throw new SettingsError(
      'The custom profile needs style instructions (set them under Translation).',
    );
  }
}

// ---------------------------------------------------------------------------
// Applying settings to the configuration
// ---------------------------------------------------------------------------

type Secrets = Partial<Record<SecretName, string>>;

/** The environment configuration with the saved settings laid over it. Pure. */
export function applySettings(
  base: AppConfig,
  stored: StoredSettings,
  secrets: Secrets,
): AppConfig {
  const has = <T extends object>(section: T, key: keyof T) => Object.hasOwn(section, key);
  const { ai, sources, cache, stremio } = stored;

  const apiKeys = { ...base.ai.apiKeys };
  for (const id of AI_PROVIDER_IDS) {
    if (secrets[id]) apiKeys[id] = secrets[id];
  }

  return {
    ...base,
    ai: {
      ...base.ai,
      apiKeys,
      provider: ai.provider ?? base.ai.provider,
      model: has(ai, 'model') ? (ai.model ?? undefined) : base.ai.model,
      fallbackProvider: has(ai, 'fallbackProvider')
        ? (ai.fallbackProvider ?? undefined)
        : base.ai.fallbackProvider,
      fallbackModel: has(ai, 'fallbackModel')
        ? (ai.fallbackModel ?? undefined)
        : base.ai.fallbackModel,
      effort: ai.effort ?? base.ai.effort,
      temperature: has(ai, 'temperature') ? (ai.temperature ?? undefined) : base.ai.temperature,
      maxSegmentEntries: ai.maxSegmentEntries ?? base.ai.maxSegmentEntries,
      translationProfile: ai.translationProfile ?? base.ai.translationProfile,
    },
    sources: {
      ...base.sources,
      languages: sources.languages ?? base.sources.languages,
      openSubtitles: {
        ...base.sources.openSubtitles,
        apiKey: secrets.opensubtitles ?? base.sources.openSubtitles.apiKey,
        username: has(sources, 'openSubtitlesUsername')
          ? (sources.openSubtitlesUsername ?? undefined)
          : base.sources.openSubtitles.username,
        password: secrets.opensubtitlesPassword ?? base.sources.openSubtitles.password,
      },
    },
    cache: {
      maxAgeDays: cache.maxAgeDays ?? base.cache.maxAgeDays,
      maxSizeMb: cache.maxSizeMb ?? base.cache.maxSizeMb,
    },
    stremio: {
      ...base.stremio,
      targetLanguages: stremio.targetLanguages ?? base.stremio.targetLanguages,
      autoTranslate: stremio.autoTranslate ?? base.stremio.autoTranslate,
      dailyJobLimit: stremio.dailyJobLimit ?? base.stremio.dailyJobLimit,
      // Without its own setting the add-on follows the general default profile.
      profile: stremio.profile ?? ai.translationProfile ?? base.stremio.profile,
      languageLabels: stremio.languageLabels ?? base.stremio.languageLabels,
    },
  };
}

// ---------------------------------------------------------------------------
// What the dashboard may see
// ---------------------------------------------------------------------------

export interface SecretStatus {
  configured: boolean;
  /** Where the value in use comes from. */
  source: 'settings' | 'environment' | null;
  /** Last characters, to recognise which key it is. Never the key. */
  hint: string | null;
}

export interface SettingsView {
  ai: {
    provider: AiProviderId;
    model: string | null;
    fallbackProvider: AiProviderId | null;
    fallbackModel: string | null;
    effort: string;
    temperature: number | null;
    maxSegmentEntries: number;
    translationProfile: string;
  };
  apiKeys: Record<AiProviderId, SecretStatus>;
  sources: {
    languages: string[];
    openSubtitles: { apiKey: SecretStatus; username: string | null; password: SecretStatus };
  };
  cache: {
    maxAgeDays: number;
    maxSizeMb: number;
    cacheDirectory: string;
    subtitlesDirectory: string;
  };
  stremio: {
    targetLanguages: string[];
    autoTranslate: boolean;
    dailyJobLimit: number;
    profile: string;
    languageLabels: Record<string, string>;
  };
  defaults: { targetLanguage: string; customInstructions: string };
  /** True when translations are simulated (MOCK_AI in the environment). */
  mockAi: boolean;
}

function secretStatus(
  saved: string | undefined,
  fromEnvironment: string | undefined,
): SecretStatus {
  const value = saved ?? fromEnvironment;
  if (!value) return { configured: false, source: null, hint: null };
  return {
    configured: true,
    source: saved ? 'settings' : 'environment',
    // Only for keys long enough that four characters reveal nothing useful.
    hint: value.length >= 12 ? `…${value.slice(-4)}` : null,
  };
}

export interface DefaultRequestSettings {
  targetLanguage: string;
  customInstructions: string;
}

interface Loaded {
  stored: StoredSettings;
  secrets: Secrets;
  config: AppConfig;
}

const SETTINGS_KEY = 'settings';
const secretKeyName = (name: SecretName) => `secret:${name}`;

/**
 * Reads and writes dashboard settings and hands every process the effective
 * configuration. The API, the worker and the add-on each have one; a change
 * saved through any of them is seen by the others within `ttlMs`.
 */
export class SettingsProvider {
  private cached: { at: number; value: Loaded } | undefined;
  private key: Buffer | undefined;

  constructor(
    private readonly db: Database,
    private readonly base: AppConfig,
    private readonly ttlMs = 2000,
  ) {}

  /** The configuration to use right now: environment plus saved settings. */
  async config(): Promise<AppConfig> {
    return (await this.load()).config;
  }

  /** Defaults for new requests that are not part of the process configuration. */
  async defaults(): Promise<DefaultRequestSettings> {
    const { stored } = await this.load();
    return {
      targetLanguage: stored.defaults.targetLanguage ?? 'sr-Latn',
      customInstructions: stored.defaults.customInstructions ?? '',
    };
  }

  /** Settings as shown in the dashboard. Contains no secret. */
  async view(): Promise<SettingsView> {
    const { stored, secrets, config } = await this.load();
    const env = this.base;
    return {
      ai: {
        provider: config.ai.provider,
        model: config.ai.model ?? null,
        fallbackProvider: config.ai.fallbackProvider ?? null,
        fallbackModel: config.ai.fallbackModel ?? null,
        effort: config.ai.effort,
        temperature: config.ai.temperature ?? null,
        maxSegmentEntries: config.ai.maxSegmentEntries,
        translationProfile: config.ai.translationProfile,
      },
      apiKeys: Object.fromEntries(
        AI_PROVIDER_IDS.map((id) => [id, secretStatus(secrets[id], env.ai.apiKeys[id])]),
      ) as Record<AiProviderId, SecretStatus>,
      sources: {
        languages: config.sources.languages,
        openSubtitles: {
          apiKey: secretStatus(secrets.opensubtitles, env.sources.openSubtitles.apiKey),
          username: config.sources.openSubtitles.username ?? null,
          password: {
            ...secretStatus(secrets.opensubtitlesPassword, env.sources.openSubtitles.password),
            hint: null,
          },
        },
      },
      cache: {
        ...config.cache,
        cacheDirectory: config.paths.cacheDir,
        subtitlesDirectory: config.paths.subtitlesDir,
      },
      stremio: {
        targetLanguages: config.stremio.targetLanguages,
        autoTranslate: config.stremio.autoTranslate,
        dailyJobLimit: config.stremio.dailyJobLimit,
        profile: config.stremio.profile,
        languageLabels: config.stremio.languageLabels,
      },
      defaults: {
        targetLanguage: stored.defaults.targetLanguage ?? 'sr-Latn',
        customInstructions: stored.defaults.customInstructions ?? '',
      },
      mockAi: config.mockAi.enabled,
    };
  }

  /**
   * Save a change. Sections are merged key by key; a secret given as a string
   * is stored encrypted, given as null it is removed (the environment value,
   * if any, is used again).
   *
   * @throws SettingsError when a value is not acceptable.
   */
  async update(input: unknown, now = new Date()): Promise<SettingsView> {
    const parsed = settingsPatchSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SettingsError(
        `${issue?.path.join('.') || 'settings'}: ${issue?.message ?? 'invalid value'}`,
      );
    }
    const patch = parsed.data;
    const current = (await this.load(true)).stored;
    const next: StoredSettings = {
      ai: { ...current.ai, ...patch.ai },
      sources: { ...current.sources, ...patch.sources },
      cache: { ...current.cache, ...patch.cache },
      stremio: { ...current.stremio, ...patch.stremio },
      defaults: { ...current.defaults, ...patch.defaults },
    };
    validateStored(next);

    const key = this.secretKey();
    await this.db.$transaction(async (tx) => {
      await tx.setting.upsert({
        where: { key: SETTINGS_KEY },
        create: { key: SETTINGS_KEY, value: JSON.stringify(next), updatedAt: now },
        update: { value: JSON.stringify(next), updatedAt: now },
      });
      for (const [name, value] of Object.entries(patch.secrets ?? {}) as [
        SecretName,
        string | null,
      ][]) {
        if (value === null) {
          await tx.setting.deleteMany({ where: { key: secretKeyName(name) } });
        } else {
          const encrypted = encryptSecret(key, value);
          await tx.setting.upsert({
            where: { key: secretKeyName(name) },
            create: { key: secretKeyName(name), value: encrypted, updatedAt: now },
            update: { value: encrypted, updatedAt: now },
          });
        }
      }
    });
    this.cached = undefined;
    return this.view();
  }

  private secretKey(): Buffer {
    this.key ??= loadSecretKey(this.base);
    return this.key;
  }

  private async load(fresh = false): Promise<Loaded> {
    if (!fresh && this.cached && Date.now() - this.cached.at < this.ttlMs) return this.cached.value;
    const rows = await this.db.setting.findMany();
    let stored: StoredSettings = storedSchema.parse({});
    const secrets: Secrets = {};
    for (const row of rows) {
      if (row.key === SETTINGS_KEY) {
        // A setting written by a newer or older version must not stop the application.
        const parsed = storedSchema.safeParse(JSON.parse(row.value));
        if (parsed.success) stored = parsed.data;
      } else if (row.key.startsWith('secret:')) {
        const name = row.key.slice('secret:'.length) as SecretName;
        const value = SECRET_NAMES.includes(name)
          ? decryptSecret(this.secretKey(), row.value)
          : undefined;
        if (value) secrets[name] = value;
      }
    }
    const value: Loaded = { stored, secrets, config: applySettings(this.base, stored, secrets) };
    this.cached = { at: Date.now(), value };
    return value;
  }
}
