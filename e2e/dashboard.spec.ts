/**
 * Phase 6 acceptance tests in a real browser against real processes (mock AI):
 * several jobs at once, settings (an API key never reaches the browser),
 * history with filter and pages, and the job details page with its timeline.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, LONG_SUBTITLE, Stack } from './harness.js';

let stack: Stack;

test.afterEach(async () => {
  await stack.stop();
});

const LONG = readFileSync(LONG_SUBTITLE, 'utf8');

/** A distinct subtitle each time (different content = a different translation). */
const variant = (n: number) => LONG.replace(/^(\d+\r?\n[^\n]+\r?\n)(.*)$/m, `$1Variant ${n}: $2`);

async function submit(n: number, title = `Episode ${n}`): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contentBase64: Buffer.from(variant(n)).toString('base64'),
      fileName: `episode-${n}.srt`,
      targetLanguage: 'sr-Latn',
      title,
    }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { job: { id: string } }).job.id;
}

async function open(page: Page, hash = '#/'): Promise<void> {
  await page.goto(`${BASE_URL}/${hash}`);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'live');
}

test('several translations run at the same time, each with its own live progress', async ({
  page,
}) => {
  stack = new Stack({ WORKER_CONCURRENCY: '2' });
  await stack.start();
  await open(page);
  const ids = [await submit(1), await submit(2), await submit(3)];

  const active = page.getByTestId('active-jobs').getByTestId('job');
  await expect(active).toHaveCount(3);
  // Two run in parallel (concurrency 2), the third waits in the queue.
  await expect
    .poll(
      async () =>
        (await active.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).filter(
          (s) => s === 'translating',
        ).length,
    )
    .toBe(2);
  for (const id of ids) {
    await expect(page.locator(`[data-testid="job"][data-job-id="${id}"]`)).toBeVisible();
  }

  for (const id of ids) await stack.waitForJob(id, (j) => j.state === 'completed');
  await expect(active).toHaveCount(0);
  const finished = page.getByTestId('finished-jobs').getByTestId('job');
  await expect(finished).toHaveCount(3);
  for (const card of await finished.all()) {
    await expect(card.getByTestId('job-percentage')).toHaveText('100.0%');
  }
});

test('settings are saved, and an API key never comes back to the browser', async ({ page }) => {
  stack = new Stack();
  await stack.start();
  const KEY = 'sk-ant-e2e-secret-value-9f8e7d6c5b4a';
  const bodies: string[] = [];
  page.on('response', (res) => {
    void res
      .text()
      .then((t) => bodies.push(t))
      .catch(() => undefined);
  });

  await open(page, '#/settings');
  await expect(page.getByTestId('settings')).toBeVisible();
  await page.getByTestId('secret-anthropic').fill(KEY);
  await page.getByTestId('setting-stremio-languages').fill('sr-Latn, hr');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('message')).toContainText('Settings saved');

  // The key field is empty again; only "set (…4a) · saved here" is shown.
  await expect(page.getByTestId('secret-anthropic')).toHaveValue('');
  await expect(page.getByTestId('settings')).toContainText('…5b4a');

  await page.reload();
  await expect(page.getByTestId('setting-stremio-languages')).toHaveValue('sr-Latn, hr');
  await expect(page.getByTestId('secret-anthropic')).toHaveValue('');
  expect(await page.content()).not.toContain(KEY);
  expect(bodies.some((b) => b.includes(KEY))).toBe(false);
  expect(bodies.some((b) => b.includes('…5b4a'))).toBe(true);

  // The server applies the setting: the Stremio card now lists both languages.
  await open(page, '#/');
  await expect(page.getByTestId('stremio')).toContainText('sr-Latn, hr');

  // An invalid value is refused with a readable reason and nothing is saved.
  await open(page, '#/settings');
  await page.getByTestId('setting-stremio-languages').fill('xx-Nope');
  await page.getByTestId('save-settings').click();
  await expect(page.getByTestId('settings-error')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('setting-stremio-languages')).toHaveValue('sr-Latn, hr');
});

test('history: filter by outcome and page through older translations', async ({ page }) => {
  stack = new Stack({ WORKER_CONCURRENCY: '1' });
  await stack.start();
  await stack.killWorker(); // keep jobs queued so they can be cancelled instantly
  const ids: string[] = [];
  for (let n = 1; n <= 23; n++) ids.push(await submit(n));
  for (const id of ids.slice(0, 22)) {
    const res = await fetch(`${BASE_URL}/api/v1/jobs/${id}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
  }
  await stack.startWorker();
  await stack.waitForJob(ids[22]!, (j) => j.state === 'completed');

  await open(page, '#/history');
  const rows = page.getByTestId('history-row');
  await expect(rows).toHaveCount(20);
  await expect(page.getByTestId('page-info')).toContainText('Page 1 of 2 · 23 translations');
  // Newest first: the completed one finished last.
  await expect(rows.first()).toHaveAttribute('data-state', 'completed');
  await expect(rows.first().getByRole('link', { name: 'Download' })).toBeVisible();

  await page.getByTestId('next-page').click();
  await expect(rows).toHaveCount(3);
  await expect(page.getByTestId('page-info')).toContainText('Page 2 of 2');

  await page.getByTestId('history-filter').selectOption('completed');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Episode 23');
  await page.getByTestId('history-filter').selectOption('cancelled');
  await expect(rows).toHaveCount(20);
  await expect(page.getByTestId('page-info')).toContainText('22 translations');
  await page.getByTestId('history-filter').selectOption('failed');
  await expect(rows).toHaveCount(0);
});

test('job details: facts, live progress, timeline and download', async ({ page }) => {
  stack = new Stack();
  await stack.start();
  const id = await submit(1, 'Harbor Lights');
  await open(page);
  await page.locator(`[data-testid="job"][data-job-id="${id}"]`).getByTestId('job-link').click();
  await expect(page).toHaveURL(new RegExp(`#/jobs/${id}$`));

  const details = page.getByTestId('job-details');
  await expect(page.getByTestId('details-title')).toHaveText('Harbor Lights');
  await expect(details).toContainText('sr-Latn');
  // Progress moves live on this page too.
  await expect
    .poll(async () =>
      Number((await page.getByTestId('details-percentage').innerText()).replace('%', '')),
    )
    .toBeGreaterThan(0);
  await expect(page.getByTestId('details-state')).toHaveText('Completed', { timeout: 30_000 });
  await expect(page.getByTestId('details-download')).toBeVisible();

  const timeline = page.getByTestId('timeline');
  await expect(timeline.locator('[data-kind="job.created"]')).toHaveCount(1);
  await expect(timeline.locator('[data-kind="job.completed"]')).toHaveCount(1);
  await expect(timeline).toContainText('Translating');

  // A direct link works after a reload, and an unknown id says so.
  await page.reload();
  await expect(page.getByTestId('details-title')).toHaveText('Harbor Lights');
  await page.goto(`${BASE_URL}/#/jobs/does-not-exist`);
  await expect(page.getByTestId('job-details')).toContainText('Job not found');
});
