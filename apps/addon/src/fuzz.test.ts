/**
 * Phase 7 robustness: whatever URL reaches the add-on — from Stremio, a broken
 * client or a scanner — it answers quickly with a valid response and never a
 * server error. A subtitles request always gets a subtitles list.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureStorageDirs, loadConfig } from '@asc/config';
import { createTestDatabase, type TestDatabase } from '@asc/database';
import { buildAddonApp } from './app.js';

let t: TestDatabase;
let app: FastifyInstance;
const TOKEN = 'fuzz-token-0123456789abcdefghij';

async function start(env: Record<string, string> = {}) {
  t = await createTestDatabase();
  const config = loadConfig({
    env: {
      NODE_ENV: 'test',
      MOCK_AI: 'true',
      STREMIO_TARGET_LANGUAGES: 'sr-Latn,hr',
      STREMIO_DAILY_JOB_LIMIT: '1000',
      ...env,
    },
    rootDir: mkdtempSync(join(tmpdir(), 'asc-addon-fuzz-')),
    useEnvFile: false,
  });
  ensureStorageDirs(config);
  app = await buildAddonApp({ config, db: t.db });
}
afterEach(async () => {
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

const TYPES = ['movie', 'series', 'channel', 'tv', 'other', '', '..', 'MOVIE', '%00'];
const IDS = [
  'tt0111161',
  'tt0903747:2:5',
  'tt0903747:0:0',
  'tt0903747:-1:5',
  'tt0903747:99999999999:1',
  'tt0903747:a:b',
  'tt',
  'tt0111161:1',
  'kitsu:1',
  'yt_id:abc',
  'local:abc',
  '..',
  '%2e%2e',
  '%E0%A4%A',
  '%',
  'tt0111161%00',
  'a'.repeat(2000),
  '',
];
const EXTRAS = [
  '',
  'videoHash=abcdef0123456789&videoSize=123',
  'videoHash=zz&videoSize=-1',
  'videoSize=1e309',
  'filename=The.Movie.2020.mkv',
  'filename=%E0%A4%A',
  'filename=..%2F..%2Fsecret',
  '=&=&&',
  'videoHash',
  '%',
  'a=' + 'b'.repeat(3000),
];
const LANGS = ['sr-Latn', 'hr', 'sr-Cyrl', 'xx', '', '..', '%00'];

function randomPath(r: ReturnType<typeof rng>): string {
  const type = r.pick(TYPES);
  const id = r.pick(IDS);
  const extra = r.pick(EXTRAS);
  switch (r.int(5)) {
    case 0:
    case 1:
      return extra ? `/subtitles/${type}/${id}/${extra}.json` : `/subtitles/${type}/${id}.json`;
    case 2:
      return `/translate/${r.pick(LANGS)}/${type}/${id}${r.pick(['.srt', '', '.json'])}${extra ? `?${extra}` : ''}`;
    case 3:
      return `/files/${r.pick([...IDS, 'x.srt', '../../etc/passwd', '%2e%2e%2fsecret.srt'])}`;
    default:
      return r.pick([
        '/manifest.json',
        '/',
        '/configure',
        '/subtitles',
        '/subtitles/movie',
        '/catalog/movie/top.json',
        '/meta/movie/tt0111161.json',
        '/stream/movie/tt0111161.json',
        '//manifest.json',
        '/manifest.json?x=%',
        '/%',
      ]);
  }
}

async function hammer(prefix: string, count: number) {
  for (let seed = 1; seed <= count; seed++) {
    const r = rng(seed);
    const url = prefix + randomPath(r);
    const method = r.next() < 0.15 ? 'HEAD' : r.next() < 0.1 ? 'OPTIONS' : 'GET';
    const started = performance.now();
    const res = await app.inject({ method, url });
    const ms = performance.now() - started;
    if (res.statusCode >= 500 || ms > 2000) {
      throw new Error(`seed ${seed}: ${method} ${url} → ${res.statusCode} in ${Math.round(ms)} ms`);
    }
    if (method === 'GET' && res.statusCode === 200 && url.includes('/subtitles/')) {
      expect(Array.isArray(res.json<{ subtitles: unknown }>().subtitles)).toBe(true);
    }
  }
}

describe('add-on fuzzing', () => {
  it('answers 800 random Stremio-like requests without a server error', async () => {
    await start();
    await hammer('', 800);
  });

  it('with an access token: malformed token segments are refused, never a server error', async () => {
    await start({ AUTH_TOKEN: TOKEN });
    await hammer('', 300);
    await hammer(`/${TOKEN}`, 300);
    for (const prefix of ['/%E0%A4%A', '/%', `/${TOKEN}%`, `/${TOKEN.slice(0, -1)}`, '/%00']) {
      const res = await app.inject({ method: 'GET', url: `${prefix}/manifest.json` });
      // 400 (malformed address) or 401 (wrong token) — never the manifest, never a crash.
      expect([400, 401]).toContain(res.statusCode);
      expect(res.body).not.toContain('"resources"');
    }
  });
});
