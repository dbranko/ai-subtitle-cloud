/**
 * Phase 3 acceptance tests in a real browser against real processes.
 *
 * Covers the mandatory tests that are about what the owner actually sees:
 * B (browser refresh), C (browser closure), D (application restart),
 * J (automatic SSE reconnection), plus cancellation, duplicates and
 * notifications from the browser's point of view.
 */
import { expect, test, type Page } from '@playwright/test';
import { BASE_URL, LONG_SUBTITLE, Stack } from './harness.js';

let stack: Stack;

test.beforeEach(async () => {
  stack = new Stack();
  await stack.start();
});
test.afterEach(async () => {
  await stack.stop();
});

const jobCard = (page: Page) => page.getByTestId('job').first();
const percentage = async (page: Page) =>
  Number((await jobCard(page).getByTestId('job-percentage').innerText()).replace('%', ''));
const segmentsDone = async (page: Page) =>
  Number((await jobCard(page).getByTestId('job-segments').innerText()).split('/')[0]?.trim());

/** Upload the long fixture through the form and return the new job's id. */
async function startTranslation(page: Page): Promise<string> {
  await page.goto(BASE_URL);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'live');
  await page.getByTestId('file').setInputFiles(LONG_SUBTITLE);
  await page.getByTestId('start').click();
  await expect(jobCard(page)).toBeVisible();
  const id = await jobCard(page).getAttribute('data-job-id');
  expect(id).toBeTruthy();
  return id as string;
}

async function waitForSegments(page: Page, atLeast: number): Promise<void> {
  await expect.poll(() => segmentsDone(page), { timeout: 30_000 }).toBeGreaterThanOrEqual(atLeast);
}

test('TEST A (browser) — progress moves segment by segment and ends at 100%', async ({ page }) => {
  const id = await startTranslation(page);
  const seen: number[] = [];
  while ((await jobCard(page).getAttribute('data-state')) !== 'completed') {
    seen.push(await percentage(page));
    await page.waitForTimeout(150);
  }
  // Several distinct intermediate values were displayed, never decreasing.
  const distinct = [...new Set(seen)];
  expect(distinct.length).toBeGreaterThanOrEqual(4);
  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(Math.max(...seen)).toBeLessThan(100);

  await expect(jobCard(page).getByTestId('job-percentage')).toHaveText('100.0%');
  await expect(jobCard(page).getByTestId('download')).toBeVisible();
  const job = await stack.job(id);
  expect(job).toMatchObject({ state: 'completed', percentage: 100 });
  expect(job.completedSegments).toBe(job.totalSegments);
});

test('TEST B — browser refresh: the same job continues and its progress is restored', async ({
  page,
}) => {
  const id = await startTranslation(page);
  await waitForSegments(page, 2);
  const before = await percentage(page);
  expect(before).toBeGreaterThan(25);

  await page.reload();

  // The same job (not a new one) is shown again, at or beyond the progress it had.
  await expect(jobCard(page)).toHaveAttribute('data-job-id', id);
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'live');
  expect(await percentage(page)).toBeGreaterThanOrEqual(before);
  expect(await stack.jobs()).toHaveLength(1);

  // And it keeps updating live after the refresh, through to completion.
  await expect(jobCard(page)).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
  await expect(jobCard(page).getByTestId('job-percentage')).toHaveText('100.0%');
  expect((await stack.job(id)).attempt).toBe(1);
});

test('TEST C — browser closure: the translation continues with no browser at all', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const id = await startTranslation(page);
  await waitForSegments(page, 1);
  const atClose = await stack.job(id);
  await context.close(); // the dashboard is gone

  const finished = await stack.waitForJob(id, (j) => j.state === 'completed');
  expect(finished.completedSegments).toBeGreaterThan(atClose.completedSegments);
  expect(finished.percentage).toBe(100);

  // Opening the dashboard later shows the result and the notification that was kept for the owner.
  const later = await (await browser.newContext()).newPage();
  await later.goto(BASE_URL);
  await expect(jobCard(later)).toHaveAttribute('data-job-id', id);
  await expect(jobCard(later)).toHaveAttribute('data-state', 'completed');
  await expect(later.getByTestId('notification')).toHaveCount(1);
  await expect(later.getByTestId('notification')).toContainText('Translation completed');
  await later.context().close();
});

test('TEST D — application restart: a killed worker and API recover the job', async ({ page }) => {
  const id = await startTranslation(page);
  await waitForSegments(page, 2);
  const before = await stack.job(id);

  // The whole application dies without any chance to clean up.
  await stack.killWorker();
  await stack.killApi();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'reconnecting');

  await stack.startApi();
  await stack.startWorker();

  // The job is recovered (second run) and finishes; finished segments are kept, not redone.
  const finished = await stack.waitForJob(id, (j) => j.state === 'completed');
  expect(finished.attempt).toBe(2);
  expect(finished.completedSegments).toBe(finished.totalSegments);
  expect(finished.totalSegments).toBe(before.totalSegments);
  expect(await stack.jobs()).toHaveLength(1);

  // The page that stayed open reconnected by itself and shows the final state, without a reload.
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'live', {
    timeout: 30_000,
  });
  await expect(jobCard(page)).toHaveAttribute('data-job-id', id);
  await expect(jobCard(page)).toHaveAttribute('data-state', 'completed', { timeout: 30_000 });
  await expect(jobCard(page).getByTestId('job-percentage')).toHaveText('100.0%');
});

test('TEST D (worker only) — progress survives a worker crash and never goes backwards on screen', async ({
  page,
}) => {
  const id = await startTranslation(page);
  await waitForSegments(page, 2);
  const before = await percentage(page);

  await stack.killWorker();
  // While no worker exists the job is neither lost nor falsely advanced.
  await page.waitForTimeout(1000);
  expect(await percentage(page)).toBe(before);
  await expect(jobCard(page)).toHaveAttribute('data-state', 'translating');

  await stack.startWorker();
  const samples: number[] = [];
  while ((await jobCard(page).getAttribute('data-state')) !== 'completed') {
    samples.push(await percentage(page));
    await page.waitForTimeout(150);
  }
  expect(Math.min(...samples)).toBeGreaterThanOrEqual(before);
  expect(samples).toEqual([...samples].sort((a, b) => a - b));
  expect((await stack.job(id)).attempt).toBe(2);
});

test('TEST J — SSE reconnects automatically and the page loses no state', async ({ page }) => {
  const id = await startTranslation(page);
  await waitForSegments(page, 1);
  const before = await percentage(page);

  // Only the API goes away: the event stream breaks while the worker keeps translating.
  await stack.killApi();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'reconnecting');
  // The job stays on screen with its last known progress.
  await expect(jobCard(page)).toHaveAttribute('data-job-id', id);
  expect(await percentage(page)).toBeGreaterThanOrEqual(before);

  await page.waitForTimeout(1500); // the worker completes more segments meanwhile
  await stack.startApi();

  // No reload: the browser reconnects, receives the current state and continues live.
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'live', {
    timeout: 30_000,
  });
  await expect.poll(() => percentage(page)).toBeGreaterThan(before);
  await expect(jobCard(page)).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
  await expect(jobCard(page).getByTestId('job-percentage')).toHaveText('100.0%');
  await expect(page.getByTestId('job')).toHaveCount(1);
  expect((await stack.job(id)).attempt).toBe(1); // the worker was never interrupted
});

test('TEST I (browser) — one completion notification, shown once, even across a reconnect', async ({
  browser,
}) => {
  const context = await browser.newContext({ permissions: ['notifications'] });
  const page = await context.newPage();
  // Count desktop notifications the page raises.
  await page.addInitScript(() => {
    const shown: string[] = [];
    (window as unknown as { __shown: string[] }).__shown = shown;
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = () => Promise.resolve('granted');
      constructor(title: string) {
        shown.push(title);
      }
    }
    (window as unknown as { Notification: unknown }).Notification = FakeNotification;
  });

  const id = await startTranslation(page);
  // Desktop notifications are off until the owner turns them on.
  await expect(page.getByTestId('enable-desktop')).toBeVisible();
  await page.getByTestId('enable-desktop').click();
  await expect(page.getByTestId('enable-desktop')).toHaveCount(0);

  // The API restarts while the job finishes: the completion is learned from the reconnect snapshot.
  await waitForSegments(page, 1);
  await stack.killApi();
  await page.waitForTimeout(6500); // long enough for the worker to finish the job
  await stack.startApi();

  await expect(jobCard(page)).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
  await expect(page.getByTestId('notification')).toHaveCount(1);
  await expect(page.getByTestId('unread-count')).toHaveText('1');
  // Force one more reconnect: nothing is announced a second time.
  await stack.killApi();
  await stack.startApi();
  await expect(page.getByTestId('connection')).toHaveAttribute('data-state', 'live', {
    timeout: 30_000,
  });
  await page.waitForTimeout(500);

  const shown = await page.evaluate(() => (window as unknown as { __shown: string[] }).__shown);
  expect(shown).toEqual(['Translation completed']);
  await expect(page.getByTestId('notification')).toHaveCount(1);

  // Dismissing it is remembered by the server, also after a reload.
  await page.getByTestId('notification').getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('notification')).toHaveCount(0);
  await page.reload();
  await expect(jobCard(page)).toHaveAttribute('data-job-id', id);
  await expect(page.getByTestId('notification')).toHaveCount(0);
  await context.close();
});

test('TEST F (browser) — cancelling stops the job and nothing is published', async ({ page }) => {
  const id = await startTranslation(page);
  await waitForSegments(page, 1);
  await jobCard(page).getByRole('button', { name: 'Cancel' }).click();

  await expect(jobCard(page)).toHaveAttribute('data-state', 'cancelled');
  const cancelled = await stack.job(id);
  expect(cancelled.state).toBe('cancelled');
  expect(cancelled.percentage).toBeLessThan(100);

  await page.waitForTimeout(2000);
  const later = await stack.job(id);
  expect(later.completedSegments).toBe(cancelled.completedSegments);
  expect(later.state).toBe('cancelled');
  await expect(jobCard(page).getByTestId('download')).toHaveCount(0);
  await expect(page.getByTestId('notification')).toHaveCount(0);
  expect((await fetch(`${BASE_URL}/api/v1/jobs/${id}/download`)).status).toBe(409);
});

test('TEST E (browser) — submitting the same subtitle twice shows one job', async ({ page }) => {
  const id = await startTranslation(page);
  await page.getByTestId('start').click();
  await expect(page.getByTestId('message')).toContainText('already in progress');
  await expect(page.getByTestId('job')).toHaveCount(1);
  await expect(jobCard(page)).toHaveAttribute('data-job-id', id);
  expect(await stack.jobs()).toHaveLength(1);

  // A second browser tab sees the very same job, live.
  const other = await page.context().newPage();
  await other.goto(BASE_URL);
  await expect(jobCard(other)).toHaveAttribute('data-job-id', id);
  await expect(jobCard(other)).toHaveAttribute('data-state', 'completed', { timeout: 60_000 });
  await expect(jobCard(page)).toHaveAttribute('data-state', 'completed');
});
