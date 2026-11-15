/**
 * Phase 7: the integrated application under conditions it will meet in real
 * use — Stremio clients that send unusual requests, crashes in the middle of a
 * translation that Stremio started, hostile addresses, and the dashboard under
 * its Content Security Policy. Real processes, mock AI.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ADDON_URL, BASE_URL, LONG_SUBTITLE, Stack } from './harness.js';

let stack: Stack;
test.afterEach(async () => {
  await stack.stop();
});

interface Subtitles {
  subtitles: { id: string; url: string; lang: string }[];
}
const MOVIE_ID = 'tt0111161';

/** The owner's library has an English subtitle for the movie (no remote source in tests). */
async function librarySubtitle(): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contentBase64: readFileSync(LONG_SUBTITLE).toString('base64'),
      fileName: 'movie.en.srt',
      title: 'The Shawshank Redemption',
      targetLanguage: 'hr',
      mediaType: 'movie',
      imdbId: MOVIE_ID,
    }),
  });
  const { job } = (await res.json()) as { job: { id: string } };
  await stack.waitForJob(job.id, (j) => j.state === 'completed');
}

const list = async (path: string): Promise<Subtitles['subtitles']> => {
  const res = await fetch(`${ADDON_URL}${path}`);
  expect(res.status, path).toBe(200);
  return ((await res.json()) as Subtitles).subtitles;
};

test('Stremio client compatibility: the request shapes real clients send', async () => {
  stack = new Stack({ STREMIO_TARGET_LANGUAGES: 'sr-Latn' });
  await stack.start();
  await stack.startAddon();
  await librarySubtitle();
  const jobsBefore = (await stack.jobs()).length;

  // Stremio Desktop / Android: extras in any order, URL-encoded file names, with or without extras.
  const shapes = [
    `/subtitles/movie/${MOVIE_ID}.json`,
    `/subtitles/movie/${MOVIE_ID}/videoHash=8e245d9679d31e12&videoSize=1351044096.json`,
    `/subtitles/movie/${MOVIE_ID}/videoSize=1351044096&videoHash=8e245d9679d31e12.json`,
    `/subtitles/movie/${MOVIE_ID}/filename=The%20Shawshank%20Redemption%20(1994).mkv&videoSize=1.json`,
    `/subtitles/movie/${MOVIE_ID}/filename=%D0%A4%D0%B8%D0%BB%D1%8C%D0%BC.mkv.json`,
  ];
  for (const path of shapes) {
    const started = Date.now();
    const subs = await list(path);
    expect(Date.now() - started, path).toBeLessThan(2000);
    expect(
      subs.map((s) => s.lang),
      path,
    ).toEqual(['Serbian (Latin) · AI translate']);
  }
  // Ids and types the add-on cannot translate: an empty list, never an error.
  for (const path of [
    '/subtitles/movie/kitsu:1.json',
    '/subtitles/series/tt0903747.json',
    '/subtitles/channel/tt0111161.json',
    '/subtitles/movie/yt_id:UCxyz.json',
  ]) {
    expect(await list(path), path).toEqual([]);
  }

  // Stremio Web: CORS preflight with the private-network permission request.
  const preflight = await fetch(`${ADDON_URL}/manifest.json`, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://web.stremio.com',
      'access-control-request-method': 'GET',
      'access-control-request-private-network': 'true',
    },
  });
  expect(preflight.status).toBeLessThan(300);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');

  // A player probing an entry with HEAD must not start a translation (only a real load does).
  const [entry] = await list(`/subtitles/movie/${MOVIE_ID}.json`);
  const head = await fetch(entry!.url, { method: 'HEAD' });
  expect(head.status).toBeGreaterThanOrEqual(400);
  // 50 simultaneous requests (several clients, prefetching): all fast, none starts anything.
  const started = Date.now();
  const answers = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      fetch(`${ADDON_URL}/subtitles/movie/${MOVIE_ID}/videoSize=${i}.json`),
    ),
  );
  expect(answers.every((r) => r.status === 200)).toBe(true);
  expect(Date.now() - started).toBeLessThan(5000);
  expect((await stack.jobs()).length).toBe(jobsBefore);
});

test('a Stremio translation survives a worker crash and an add-on restart', async () => {
  stack = new Stack({ STREMIO_TARGET_LANGUAGES: 'sr-Cyrl' });
  await stack.start();
  await stack.startAddon();
  await librarySubtitle();

  const path = `/subtitles/movie/${MOVIE_ID}/videoSize=1351044096.json`;
  const [entry] = await list(path);
  const picked = await fetch(entry!.url);
  expect(await picked.text()).toContain('AI prevod je pokrenut.');
  const job = (await stack.jobs()).find((j) => j.state !== 'completed')!;

  // The worker dies half-way through; the add-on keeps answering meanwhile.
  await stack.waitForJob(job.id, (j) => j.completedSegments >= 2);
  await stack.killWorker();
  const during = await list(path);
  expect(during[0]?.lang).toMatch(/^Serbian \(Cyrillic\) · AI \d+%$/);

  await stack.startWorker();
  const done = await stack.waitForJob(job.id, (j) => j.state === 'completed');
  expect(done.attempt).toBeGreaterThanOrEqual(1);

  // The add-on itself restarts (e.g. a container update): the subtitle is still served.
  await stack.killAddon();
  await stack.startAddon();
  const ready = await list(path);
  expect(ready.map((s) => s.lang)).toEqual(['srp']);
  const srt = await (await fetch(ready[0]!.url)).text();
  expect(srt.match(/-->/g)).toHaveLength(130);
  expect(/[Ѐ-ӿ]/.test(srt)).toBe(true);
  // Only one job was ever created for it.
  expect((await stack.jobs()).filter((j) => j.id === job.id)).toHaveLength(1);
  expect((await stack.jobs()).length).toBe(2);
});

test('hostile addresses do not take the add-on down (with an access token)', async () => {
  const TOKEN = 'e2e-access-token-0123456789abcdef';
  stack = new Stack({ AUTH_TOKEN: TOKEN });
  await stack.start();
  await stack.startAddon();

  for (const path of [
    '/%E0%A4%A/manifest.json',
    '/%/manifest.json',
    `/${TOKEN}%/manifest.json`,
    '/..%2f..%2fetc%2fpasswd',
    `/${TOKEN}/files/..%2f..%2fdb%2fasc.sqlite`,
  ]) {
    const res = await fetch(`${ADDON_URL}${path}`);
    expect(res.status, path).toBeGreaterThanOrEqual(400);
    expect(res.status, path).toBeLessThan(500);
  }
  // An absurd id is just a title the add-on cannot translate: an empty list.
  const long = await fetch(`${ADDON_URL}/${TOKEN}/subtitles/movie/${'a'.repeat(5000)}.json`);
  expect(long.status).toBeLessThan(500);
  expect(stack.addonAlive()).toBe(true);
  expect((await fetch(`${ADDON_URL}/${TOKEN}/manifest.json`)).status).toBe(200);
});

test('the dashboard runs under its Content Security Policy and survives a malformed link', async ({
  page,
}) => {
  stack = new Stack();
  await stack.start();
  const violations: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') violations.push(msg.text());
  });
  const res = await page.goto(`${BASE_URL}/`);
  expect(res?.headers()['content-security-policy']).toContain("default-src 'self'");
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'live');
  await page.goto(`${BASE_URL}/#/settings`);
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.goto(`${BASE_URL}/#/jobs/%E0%A4%A`);
  await expect(page.getByTestId('job-details')).toContainText('Job not found');
  expect(violations.filter((v) => /Content Security Policy|Refused to/i.test(v))).toEqual([]);
});
