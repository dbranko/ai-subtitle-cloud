import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { findWorkspaceRoot, readEnvFile } from './root.js';

const port = (fallback: number) => z.coerce.number().int().min(1).max(65535).default(fallback);

const bool = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0', ''])
    .default(fallback ? 'true' : 'false')
    .transform((v) => v === 'true' || v === '1');

/** Treat empty strings (e.g. `AUTH_TOKEN=` in .env) as "not set". */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

export const AI_PROVIDER_IDS = ['anthropic', 'openai', 'gemini'] as const;
export type AiProviderId = (typeof AI_PROVIDER_IDS)[number];
export const AI_EFFORT_LEVELS = ['low', 'medium', 'high'] as const;
export type AiEffort = (typeof AI_EFFORT_LEVELS)[number];

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATA_DIR: z.string().default('./data'),
  DATABASE_URL: optionalString,
  SUBTITLES_DIR: optionalString,
  CACHE_DIR: optionalString,
  LOGS_DIR: optionalString,
  JOBS_DIR: optionalString,

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: port(7001),
  ADDON_HOST: z.string().default('127.0.0.1'),
  ADDON_PORT: port(7000),
  WORKER_HEALTH_HOST: z.string().default('127.0.0.1'),
  WORKER_HEALTH_PORT: port(7002),
  WORKER_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(250).default(5000),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(1000),
  WORKER_LEASE_MS: z.coerce.number().int().min(500).default(30_000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(1),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  SEGMENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .min(1024)
    .default(5 * 1024 * 1024),
  MOCK_AI: bool(false),
  MOCK_AI_DELAY_MS: z.coerce.number().int().min(0).default(1000),

  AUTH_TOKEN: optionalString,

  ANTHROPIC_API_KEY: optionalString,
  OPENAI_API_KEY: optionalString,
  GEMINI_API_KEY: optionalString,
  AI_PROVIDER: z.enum(AI_PROVIDER_IDS).default('anthropic'),
  AI_MODEL: optionalString,
  AI_FALLBACK_PROVIDER: z
    .enum(AI_PROVIDER_IDS)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  AI_FALLBACK_MODEL: optionalString,
  AI_EFFORT: z.enum(AI_EFFORT_LEVELS).default('medium'),
  AI_TEMPERATURE: optionalString.transform((v, ctx) => {
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 2) {
      ctx.addIssue({ code: 'custom', message: 'must be a number between 0 and 2' });
      return z.NEVER;
    }
    return n;
  }),
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1024).max(128_000).default(32_000),
  AI_MAX_SEGMENT_ENTRIES: z.coerce.number().int().min(5).max(200).default(60),
  AI_TRANSLATION_PROFILE: z.string().default('natural'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5000).default(180_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(3),
  PRICING_FILE: optionalString,
  ALLOW_UNAUTHENTICATED_NON_LOOPBACK: bool(false),
});

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  rootDir: string;
  paths: {
    dataDir: string;
    subtitlesDir: string;
    cacheDir: string;
    logsDir: string;
    jobsDir: string;
    /** Absolute path of the SQLite file, or `:memory:`. */
    databaseFile: string;
  };
  /** Prisma-style SQLite URL (`file:/abs/path.sqlite`). */
  databaseUrl: string;
  api: { host: string; port: number };
  addon: { host: string; port: number };
  worker: {
    healthHost: string;
    healthPort: number;
    heartbeatIntervalMs: number;
    /** How often an idle worker looks for queued jobs. */
    pollIntervalMs: number;
    /** How long a job claim stays valid without renewal; a dead worker's jobs are recovered after this. */
    leaseMs: number;
    /** Jobs processed at the same time. */
    concurrency: number;
  };
  jobs: {
    /** Runs allowed per job (first run + automatic recoveries) before it fails as interrupted. */
    maxAttempts: number;
    /** Translator calls allowed per segment before the job fails. */
    segmentMaxAttempts: number;
    /** Largest accepted subtitle upload. */
    maxUploadBytes: number;
  };
  /** Use the built-in mock translator instead of a real provider (no API calls, no cost). */
  mockAi: { enabled: boolean; delayMs: number };
  ai: {
    /** API keys by provider. Server-side only: never log, never send to the browser or Stremio. */
    apiKeys: Partial<Record<AiProviderId, string>>;
    provider: AiProviderId;
    /** Undefined = the provider's default model. */
    model: string | undefined;
    fallbackProvider: AiProviderId | undefined;
    fallbackModel: string | undefined;
    effort: AiEffort;
    /** Only sent to providers that accept it; undefined = provider default. */
    temperature: number | undefined;
    maxOutputTokens: number;
    maxSegmentEntries: number;
    translationProfile: string;
    requestTimeoutMs: number;
    maxRetries: number;
    /** JSON file with per-model prices used for cost estimates. */
    pricingFile: string;
  };
  security: {
    /** Shared secret required when any service is bound beyond localhost. Never log this. */
    authToken: string | undefined;
    allowUnauthenticatedNonLoopback: boolean;
  };
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export interface LoadConfigOptions {
  env?: Record<string, string | undefined>;
  rootDir?: string;
  /** Read `<root>/.env` (default true). Tests pass false for hermetic config. */
  useEnvFile?: boolean;
}

const MIN_AUTH_TOKEN_LENGTH = 24;

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  const processEnv = options.env ?? process.env;
  const rootDir = options.rootDir ?? findWorkspaceRoot(process.cwd(), processEnv);
  const fileEnv = options.useEnvFile === false ? {} : readEnvFile(rootDir);
  const merged = { ...fileEnv, ...definedOnly(processEnv) };

  const parsed = envSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new ConfigError(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const e = parsed.data;

  const abs = (p: string) => (isAbsolute(p) ? p : resolve(rootDir, p));
  const dataDir = abs(e.DATA_DIR);
  const databaseFile = resolveDatabaseFile(e.DATABASE_URL, dataDir, rootDir);

  if (e.AUTH_TOKEN !== undefined && e.AUTH_TOKEN.length < MIN_AUTH_TOKEN_LENGTH) {
    throw new ConfigError(`AUTH_TOKEN must be at least ${MIN_AUTH_TOKEN_LENGTH} characters long.`);
  }

  return {
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    rootDir,
    paths: {
      dataDir,
      subtitlesDir: abs(e.SUBTITLES_DIR ?? resolve(dataDir, 'subtitles')),
      cacheDir: abs(e.CACHE_DIR ?? resolve(dataDir, 'cache')),
      logsDir: abs(e.LOGS_DIR ?? resolve(dataDir, 'logs')),
      jobsDir: abs(e.JOBS_DIR ?? resolve(dataDir, 'jobs')),
      databaseFile,
    },
    databaseUrl: databaseFile === ':memory:' ? 'file::memory:' : `file:${databaseFile}`,
    api: { host: e.API_HOST, port: e.API_PORT },
    addon: { host: e.ADDON_HOST, port: e.ADDON_PORT },
    worker: {
      healthHost: e.WORKER_HEALTH_HOST,
      healthPort: e.WORKER_HEALTH_PORT,
      heartbeatIntervalMs: e.WORKER_HEARTBEAT_INTERVAL_MS,
      pollIntervalMs: e.WORKER_POLL_INTERVAL_MS,
      leaseMs: e.WORKER_LEASE_MS,
      concurrency: e.WORKER_CONCURRENCY,
    },
    jobs: {
      maxAttempts: e.JOB_MAX_ATTEMPTS,
      segmentMaxAttempts: e.SEGMENT_MAX_ATTEMPTS,
      maxUploadBytes: e.MAX_UPLOAD_BYTES,
    },
    mockAi: { enabled: e.MOCK_AI, delayMs: e.MOCK_AI_DELAY_MS },
    ai: {
      apiKeys: definedOnly({
        anthropic: e.ANTHROPIC_API_KEY,
        openai: e.OPENAI_API_KEY,
        gemini: e.GEMINI_API_KEY,
      }),
      provider: e.AI_PROVIDER,
      model: e.AI_MODEL,
      fallbackProvider: e.AI_FALLBACK_PROVIDER,
      fallbackModel: e.AI_FALLBACK_MODEL,
      effort: e.AI_EFFORT,
      temperature: e.AI_TEMPERATURE,
      maxOutputTokens: e.AI_MAX_OUTPUT_TOKENS,
      maxSegmentEntries: e.AI_MAX_SEGMENT_ENTRIES,
      translationProfile: e.AI_TRANSLATION_PROFILE,
      requestTimeoutMs: e.AI_REQUEST_TIMEOUT_MS,
      maxRetries: e.AI_MAX_RETRIES,
      pricingFile: abs(e.PRICING_FILE ?? resolve(rootDir, 'config', 'pricing.json')),
    },
    security: {
      authToken: e.AUTH_TOKEN,
      allowUnauthenticatedNonLoopback: e.ALLOW_UNAUTHENTICATED_NON_LOOPBACK,
    },
  };
}

function definedOnly(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
}

function resolveDatabaseFile(url: string | undefined, dataDir: string, rootDir: string): string {
  if (url === undefined) return resolve(dataDir, 'db', 'asc.sqlite');
  if (!url.startsWith('file:')) {
    throw new ConfigError('DATABASE_URL must be a SQLite URL starting with "file:".');
  }
  const path = url.slice('file:'.length).split('?')[0] ?? '';
  if (path === ':memory:') return ':memory:';
  if (path === '') throw new ConfigError('DATABASE_URL does not contain a file path.');
  return isAbsolute(path) ? path : resolve(rootDir, path);
}

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h);
}

/**
 * Security guard, called by every HTTP-serving process before it listens.
 * Binding beyond localhost is refused unless an AUTH_TOKEN is configured, or the
 * operator explicitly declared that the network boundary is enforced elsewhere
 * (e.g. Docker publishing the port on 127.0.0.1 only).
 */
export function assertBindAllowed(config: AppConfig, service: string, host: string): void {
  if (isLoopbackHost(host)) return;
  if (config.security.authToken !== undefined) return;
  if (config.security.allowUnauthenticatedNonLoopback) return;
  throw new ConfigError(
    `${service} is configured to listen on non-loopback host "${host}" without AUTH_TOKEN. ` +
      'Set AUTH_TOKEN, bind to 127.0.0.1, or (only when another layer restricts access) ' +
      'set ALLOW_UNAUTHENTICATED_NON_LOOPBACK=true.',
  );
}

/** Config view that is safe to log: secrets are reduced to a boolean. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    logLevel: config.logLevel,
    rootDir: config.rootDir,
    paths: config.paths,
    api: config.api,
    addon: config.addon,
    worker: config.worker,
    jobs: config.jobs,
    mockAi: config.mockAi,
    ai: {
      ...config.ai,
      // Keys are reduced to "configured: yes/no".
      apiKeys: Object.fromEntries(
        AI_PROVIDER_IDS.map((id) => [id, config.ai.apiKeys[id] !== undefined]),
      ),
    },
    security: {
      authTokenConfigured: config.security.authToken !== undefined,
      allowUnauthenticatedNonLoopback: config.security.allowUnauthenticatedNonLoopback,
    },
  };
}
