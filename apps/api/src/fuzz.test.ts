/**
 * Phase 7 robustness: hostile and malformed requests against every API route.
 * Whatever a client sends, the API answers with a 2xx or a 4xx and a JSON
 * error — never a 500, never a crash — and leaves the database usable.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureStorageDirs, loadConfig } from '@asc/config';
import { createTestDatabase, type TestDatabase } from '@asc/database';
import { buildApp } from './app.js';

const LONG = readFileSync(
  new URL('../../../fixtures/subtitles/basic-movie.srt', import.meta.url),
).toString('base64');

let t: TestDatabase;
let app: FastifyInstance;

beforeAll(async () => {
  t = await createTestDatabase();
  const config = loadConfig({
    env: { NODE_ENV: 'test', MOCK_AI: 'true', MAX_UPLOAD_BYTES: '200000' },
    rootDir: mkdtempSync(join(tmpdir(), 'asc-api-fuzz-')),
    useEnvFile: false,
  });
  ensureStorageDirs(config);
  app = await buildApp({ config, db: t.db, dashboardDir: null, rateLimitPerMinute: 100_000 });
});
afterAll(async () => {
  await app.close();
  await t.cleanup();
});

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  return { next, int, pick };
}
type Rng = ReturnType<typeof rng>;

const STRINGS = [
  '',
  ' ',
  'sr-Latn',
  'sr-Cyrl',
  'hr',
  'xx-Nope',
  '../../etc/passwd',
  '..%2F..%2F',
  '\u0000',
  '%00',
  '<script>alert(1)</script>',
  "' OR 1=1 --",
  '__proto__',
  'constructor',
  'tt0111161',
  'tt',
  '𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
  'a'.repeat(5000),
  'NaN',
  '-1',
  '1e309',
];
const NUMBERS = [0, -1, 1, 1.5, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 2, 2 ** 31, NaN];

function value(r: Rng, depth = 0): unknown {
  switch (r.int(depth > 2 ? 4 : 7)) {
    case 0:
      return r.pick(STRINGS);
    case 1:
      return r.pick(NUMBERS);
    case 2:
      return r.pick([true, false, null]);
    case 3:
      return undefined;
    case 4:
      return Array.from({ length: r.int(4) }, () => value(r, depth + 1));
    default: {
      const o: Record<string, unknown> = {};
      for (let i = r.int(5); i > 0; i--)
        o[r.pick([...STRINGS, 'media', 'ai', 'secrets'])] = value(r, depth + 1);
      return o;
    }
  }
}

/** A valid body with some fields replaced, removed or added. */
function mutateBody(r: Rng, valid: Record<string, unknown>): unknown {
  if (r.next() < 0.15) return value(r);
  const body: Record<string, unknown> = structuredClone(valid);
  const keys = Object.keys(body);
  for (let i = 1 + r.int(3); i > 0; i--) {
    const key = r.next() < 0.8 && keys.length ? r.pick(keys) : r.pick(STRINGS);
    if (r.next() < 0.2) delete body[key];
    else body[key] = value(r);
  }
  return body;
}

const VALID: Record<string, Record<string, unknown>> = {
  'POST /api/v1/jobs': { contentBase64: LONG, targetLanguage: 'sr-Latn', fileName: 'a.srt' },
  'POST /api/v1/jobs/from-media': {
    media: { type: 'series', imdbId: 'tt0903747', season: 1, episode: 2 },
    targetLanguage: 'hr',
  },
  'POST /api/v1/sources/search': { media: { type: 'movie', imdbId: 'tt0111161' } },
  'PUT /api/v1/settings': {
    ai: { provider: 'openai', temperature: 0.3 },
    stremio: { languages: ['sr-Latn'] },
    secrets: { openai: 'sk-0123456789abcdef' },
  },
  'POST /api/v1/cache/cleanup': {},
};

async function send(options: InjectOptions & { url: string }) {
  const res = await app.inject(options);
  if (res.statusCode >= 500) {
    throw new Error(
      `${options.method} ${options.url} → ${res.statusCode}: ${res.body.slice(0, 300)}`,
    );
  }
  return res;
}

describe('API fuzzing', () => {
  it('answers 600 mutated request bodies without a server error', async () => {
    const routes = Object.keys(VALID);
    for (let seed = 1; seed <= 600; seed++) {
      const r = rng(seed);
      const route = r.pick(routes);
      const [method, url] = route.split(' ') as ['POST' | 'PUT', string];
      const body = mutateBody(r, VALID[route]!);
      const res = await send({
        method,
        url,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(body) ?? 'null',
      });
      if (res.statusCode >= 400) {
        expect(res.headers['content-type']).toContain('application/json');
        expect(typeof res.json<{ error: unknown }>().error).toBe('string');
      }
    }
  });

  it('refuses broken JSON, wrong content types and oversized bodies with a 4xx', async () => {
    for (const payload of ['{', '{"a":', '[1,2', 'null', '"x"', '\u0000', '{"a":1}garbage']) {
      const res = await send({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
      const res = await send({
        method: 'POST',
        url: '/api/v1/jobs',
        headers: { 'content-type': type },
        payload: 'a=b',
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
    }
    const huge = await send({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ srt: 'x'.repeat(2_000_000), targetLanguage: 'hr' }),
    });
    expect(huge.statusCode).toBe(413);
    const settings = await send({
      method: 'PUT',
      url: '/api/v1/settings',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ defaults: { styleInstructions: 'x'.repeat(2_000_000) } }),
    });
    expect(settings.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('answers hostile ids and query strings on every route without a server error', async () => {
    const ids = [
      'x',
      '..',
      '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '%00',
      'a'.repeat(3000),
      '%F0%9D%94%98',
      '%E0%A4%A',
      '1%20OR%201=1',
    ];
    for (const id of ids) {
      for (const path of ['', '/events', '/download']) {
        // `jobs/../events` is the live event stream, which by design never ends.
        if (id === '..' && path === '/events') continue;
        const res = await send({ method: 'GET', url: `/api/v1/jobs/${id}${path}` });
        expect([400, 404, 414]).toContain(res.statusCode);
      }
      for (const action of ['cancel', 'retry']) {
        const res = await send({ method: 'POST', url: `/api/v1/jobs/${id}/${action}` });
        expect([400, 404, 414]).toContain(res.statusCode);
      }
      await send({ method: 'POST', url: `/api/v1/notifications/${id}/read` });
    }
    const r = rng(7);
    for (let i = 0; i < 200; i++) {
      const q = Array.from(
        { length: 1 + r.int(4) },
        () =>
          `${r.pick(['scope', 'status', 'limit', 'offset', 'unread', 'x'])}=${encodeURIComponent(String(r.pick([...STRINGS, ...NUMBERS])))}`,
      ).join('&');
      for (const url of ['/api/v1/jobs', '/api/v1/activity', '/api/v1/notifications']) {
        await send({ method: 'GET', url: `${url}?${q}` });
      }
    }
  });

  it('is still fully usable afterwards', async () => {
    const res = await send({
      method: 'POST',
      url: '/api/v1/jobs',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ srt: 'not a subtitle', targetLanguage: 'hr' }),
    });
    expect(res.statusCode).toBe(400);
    expect((await send({ method: 'GET', url: '/api/v1/jobs' })).statusCode).toBe(200);
    expect((await send({ method: 'GET', url: '/api/v1/settings' })).statusCode).toBe(200);
  });
});
