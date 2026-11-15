/**
 * Phase 5: the Stremio add-on as real processes.
 *
 * The add-on, API and worker run as separate Node processes sharing one
 * database, exactly as in production. The test plays the part of the Stremio
 * client over HTTP (Stremio Desktop itself cannot run in the test environment).
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ADDON_URL, BASE_URL, LONG_SUBTITLE, Stack } from './harness.js';

let stack: Stack;

test.beforeEach(async () => {
  stack = new Stack({ STREMIO_TARGET_LANGUAGES: 'sr-Latn,sr-Cyrl' });
  await stack.start();
  await stack.startAddon();
});
test.afterEach(async () => {
  await stack.stop();
});

interface Subtitles {
  subtitles: { id: string; url: string; lang: string }[];
}
const EPISODE = `${ADDON_URL}/subtitles/series/tt0903747:2:5/videoHash=abcdef0123456789&videoSize=123456.json`;

test('Stremio flow: manifest, translate entries, translation only when picked, progress in the dashboard, subtitle on the next request', async ({
  page,
}) => {
  // The add-on process serves a valid manifest through the SDK.
  const manifest = await fetch(`${ADDON_URL}/manifest.json`);
  expect(manifest.status).toBe(200);
  expect(manifest.headers.get('access-control-allow-origin')).toBe('*');
  expect(await manifest.json()).toMatchObject({
    id: 'local.ai-subtitle-cloud',
    resources: ['subtitles'],
    types: ['movie', 'series'],
  });

  // The owner has a subtitle for this episode in the library (no remote source in the test).
  const upload = await fetch(`${BASE_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contentBase64: readFileSync(LONG_SUBTITLE).toString('base64'),
      fileName: 'episode.srt',
      title: 'Breaking Bad',
      targetLanguage: 'hr',
      mediaType: 'series',
      imdbId: 'tt0903747',
      season: 2,
      episode: 5,
    }),
  });
  const uploaded = ((await upload.json()) as { job: { id: string } }).job;
  await stack.waitForJob(uploaded.id, (j) => j.state === 'completed');

  await page.goto(BASE_URL);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'live');
  await expect(page.getByTestId('manifest-url')).toHaveText(`${ADDON_URL}/manifest.json`);

  // Stremio opens the episode: the add-on answers immediately, offering one
  // "AI translate" entry per language and starting nothing.
  const started = Date.now();
  const first = await fetch(EPISODE);
  expect(Date.now() - started).toBeLessThan(2000);
  expect(first.headers.get('cache-control')).toBe('max-age=0, public');
  const offered = ((await first.json()) as Subtitles).subtitles;
  expect(offered.map((s) => s.lang)).toEqual([
    'Serbian (Latin) · AI translate',
    'Serbian (Cyrillic) · AI translate',
  ]);
  expect((await stack.jobs()).length).toBe(1);

  // The viewer picks both entries in the subtitle menu: Stremio loads them, which starts the jobs.
  for (const entry of offered) {
    const picked = await fetch(entry.url);
    expect(picked.status).toBe(200);
    expect(await picked.text()).toContain('AI prevod je pokrenut.');
  }

  // The dashboard — the companion progress page — shows the jobs Stremio started, live.
  const stremioJobs = page.locator('[data-testid=job]', { hasText: 'requested by Stremio' });
  await expect(stremioJobs).toHaveCount(2);
  await expect(stremioJobs.first()).toContainText('Breaking Bad S02E05');

  // Asking again while it is translating creates nothing new and still does not block.
  await fetch(EPISODE);
  await fetch(offered[0]?.url ?? '');
  expect((await stack.jobs()).length).toBe(3);

  await expect(
    page.locator('[data-testid=job][data-state=completed]', { hasText: 'requested by Stremio' }),
  ).toHaveCount(2, {
    timeout: 60_000,
  });

  // The next request from Stremio lists both languages.
  const ready = await fetch(EPISODE);
  expect(ready.headers.get('cache-control')).toBe(
    'max-age=300, stale-while-revalidate=300, public',
  );
  const { subtitles } = (await ready.json()) as Subtitles;
  expect(subtitles.map((s) => s.lang)).toEqual(['srp', 'srp']);
  expect(new Set(subtitles.map((s) => s.id)).size).toBe(2);

  // Each URL is a real SRT file in the right script.
  const [latin, cyrillic] = await Promise.all(
    subtitles.map(async (s) => (await fetch(s.url)).text()),
  );
  for (const srt of [latin, cyrillic]) {
    expect(srt?.startsWith('1\n00:00:20,000 --> ')).toBe(true);
    expect(srt?.match(/-->/g)).toHaveLength(130);
  }
  expect(/[Ѐ-ӿ]/.test(latin ?? '')).toBe(false);
  expect(/[Ѐ-ӿ]/.test(cyrillic ?? '')).toBe(true);
  const head = await fetch(subtitles[0]?.url ?? '');
  expect(head.headers.get('content-type')).toBe('application/x-subrip; charset=utf-8');
  expect(head.headers.get('access-control-allow-origin')).toBe('*');
});

test('the add-on keeps answering from the cache while the worker and the API are down', async () => {
  const upload = await fetch(`${BASE_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contentBase64: readFileSync(LONG_SUBTITLE).toString('base64'),
      targetLanguage: 'hr',
      mediaType: 'series',
      imdbId: 'tt0903747',
      season: 2,
      episode: 5,
    }),
  });
  await stack.waitForJob(
    ((await upload.json()) as { job: { id: string } }).job.id,
    (j) => j.state === 'completed',
  );
  const offered = ((await (await fetch(EPISODE)).json()) as Subtitles).subtitles;
  for (const entry of offered) await fetch(entry.url);
  await expect
    .poll(
      async () =>
        ((await (await fetch(EPISODE)).json()) as Subtitles).subtitles.filter(
          (s) => s.lang === 'srp',
        ).length,
      { timeout: 60_000 },
    )
    .toBe(2);

  await stack.killWorker();
  await stack.killApi();
  const res = await fetch(EPISODE);
  const { subtitles } = (await res.json()) as Subtitles;
  expect(subtitles).toHaveLength(2);
  expect((await fetch(subtitles[0]?.url ?? '')).status).toBe(200);
});
