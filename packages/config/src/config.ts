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

  AUTH_TOKEN: optionalString,
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
  worker: { healthHost: string; healthPort: number; heartbeatIntervalMs: number };
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
    security: {
      authTokenConfigured: config.security.authToken !== undefined,
      allowUnauthenticatedNonLoopback: config.security.allowUnauthenticatedNonLoopback,
    },
  };
}
