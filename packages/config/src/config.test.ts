import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  assertBindAllowed,
  describeConfig,
  findWorkspaceRoot,
  isLoopbackHost,
  loadConfig,
} from './index.js';

const root = resolve('/srv/asc');
const load = (env: Record<string, string> = {}) =>
  loadConfig({ env, rootDir: root, useEnvFile: false });

describe('loadConfig', () => {
  it('applies secure localhost defaults', () => {
    const c = load();
    expect(c.api).toEqual({ host: '127.0.0.1', port: 7001 });
    expect(c.addon).toEqual({ host: '127.0.0.1', port: 7000 });
    expect(c.worker.healthHost).toBe('127.0.0.1');
    expect(c.security.authToken).toBeUndefined();
    expect(c.security.allowUnauthenticatedNonLoopback).toBe(false);
  });

  it('resolves storage paths relative to the workspace root', () => {
    const c = load();
    expect(c.paths.dataDir).toBe(resolve(root, 'data'));
    expect(c.paths.subtitlesDir).toBe(resolve(root, 'data', 'subtitles'));
    expect(c.paths.cacheDir).toBe(resolve(root, 'data', 'cache'));
    expect(c.paths.databaseFile).toBe(resolve(root, 'data', 'db', 'asc.sqlite'));
    expect(c.databaseUrl).toBe(`file:${resolve(root, 'data', 'db', 'asc.sqlite')}`);
  });

  it('honours overrides for directories and database', () => {
    const custom = resolve('/mnt/big/cache');
    const c = load({ DATA_DIR: 'store', CACHE_DIR: custom, DATABASE_URL: 'file:./db/x.sqlite' });
    expect(c.paths.dataDir).toBe(resolve(root, 'store'));
    expect(c.paths.cacheDir).toBe(custom);
    expect(c.paths.databaseFile).toBe(resolve(root, 'db', 'x.sqlite'));
  });

  it('rejects invalid values with a readable error', () => {
    expect(() => load({ API_PORT: '99999' })).toThrow(ConfigError);
    expect(() => load({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(() => load({ DATABASE_URL: 'postgres://x' })).toThrow(/SQLite/);
    expect(() => load({ AUTH_TOKEN: 'short' })).toThrow(/AUTH_TOKEN/);
  });

  it('treats an empty AUTH_TOKEN as not configured', () => {
    expect(load({ AUTH_TOKEN: '' }).security.authToken).toBeUndefined();
  });

  it('reads .env from the root but lets real environment variables win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-config-'));
    writeFileSync(join(dir, '.env'), 'API_PORT=8100\nADDON_PORT=8200\n');
    const c = loadConfig({ env: { ADDON_PORT: '8300' }, rootDir: dir });
    expect(c.api.port).toBe(8100);
    expect(c.addon.port).toBe(8300);
  });
});

describe('bind guard', () => {
  it('recognises loopback hosts', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1']) {
      expect(isLoopbackHost(h)).toBe(true);
    }
    for (const h of ['0.0.0.0', '192.168.1.5', '::', 'example.com']) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });

  it('refuses to expose a service beyond localhost without authentication', () => {
    expect(() => assertBindAllowed(load(), 'api', '127.0.0.1')).not.toThrow();
    expect(() => assertBindAllowed(load(), 'api', '0.0.0.0')).toThrow(ConfigError);
    const withToken = load({ AUTH_TOKEN: 'a'.repeat(32) });
    expect(() => assertBindAllowed(withToken, 'api', '0.0.0.0')).not.toThrow();
    const optedOut = load({ ALLOW_UNAUTHENTICATED_NON_LOOPBACK: 'true' });
    expect(() => assertBindAllowed(optedOut, 'api', '0.0.0.0')).not.toThrow();
  });

  it('never includes the auth token in the loggable description', () => {
    const token = 'super-secret-token-value-1234567890';
    const text = JSON.stringify(describeConfig(load({ AUTH_TOKEN: token })));
    expect(text).not.toContain(token);
    expect(text).toContain('"authTokenConfigured":true');
  });
});

describe('findWorkspaceRoot', () => {
  it('walks up to the directory containing pnpm-workspace.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asc-root-'));
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
    const nested = join(dir, 'apps', 'api');
    mkdirSync(nested, { recursive: true });
    expect(findWorkspaceRoot(nested, {})).toBe(dir);
  });

  it('prefers ASC_ROOT when set', () => {
    expect(findWorkspaceRoot('/anywhere', { ASC_ROOT: root })).toBe(root);
  });
});
