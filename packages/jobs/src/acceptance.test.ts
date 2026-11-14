/**
 * Phase 3 mandatory acceptance tests (engine level).
 *
 * Every test runs the real worker against a real, migrated SQLite database and
 * the real translation engine; only the AI provider is replaced by a mock.
 * Tests B (browser refresh) and J (SSE in a browser) are additionally covered
 * end-to-end in apps/api and in the Playwright suite.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createProviderManager,
  ProviderError,
  type AiProvider,
  type AiProviderId,
} from '@asc/ai-providers';
import { parseSrt } from '@asc/subtitle-parser';
import {
  containsCyrillic,
  createLlmTranslator,
  mockTranslateText,
  prepareTranslation,
  resolveTargetLanguage,
  translateSubtitle,
} from '@asc/translation-engine';
import { segmentationFromConfig } from '@asc/ai-providers';
import {
  claimNextJob,
  getJob,
  InvalidTransitionError,
  JobConflictError,
  JobRequestError,
  listNotifications,
  LostLockError,
  markNotificationRead,
  outputPath,
  readEventsAfter,
  readSnapshot,
  recoverExpiredJobs,
  requestCancel,
  retryJob,
  transitionJob,
  waitForJob,
  type TranslatorFactory,
} from './index.js';
import { fixtureText } from './test-fixtures.js';
import {
  createContext,
  createWorker,
  eventLog,
  jobEvents,
  mock,
  submit,
  type TestContext,
} from './test-helpers.js';

let ctx: TestContext;
beforeEach(async () => {
  ctx = await createContext();
});
afterEach(async () => {
  await ctx.cleanup();
});

const srt = fixtureText('long-episode.srt');
const segmentCount = () =>
  prepareTranslation({ srt, targetLanguage: 'sr-Latn' }, segmentationFromConfig(ctx.config))
    .segments.length;
const until = (
  predicate: Parameters<typeof waitForJob>[2] extends infer O
    ? O extends { until?: infer U }
      ? NonNullable<U>
      : never
    : never,
) => ({ until: predicate });

// ---------------------------------------------------------------------------
describe('TEST A — long translation', () => {
  it('reports progress as each segment completes, from real completed work only', async () => {
    const total = segmentCount();
    expect(total).toBeGreaterThanOrEqual(3);
    const { job } = await submit(ctx);
    expect(job).toMatchObject({ state: 'queued', percentage: 0, totalEntries: 130 });

    const translator = mock({ delayMs: 15 });
    (await createWorker(ctx, translator)).start();
    const finished = await waitForJob(ctx.db, job.id);
    expect(finished.state).toBe('completed');

    const events = jobEvents(await eventLog(ctx.db, job.id));

    // Every state of the pipeline was passed, in order.
    const states = events.map((e) => e.job.state).filter((s, i, all) => s !== all[i - 1]);
    expect(states).toEqual([
      'queued',
      'locating_source',
      'downloading_source',
      'parsing',
      'preparing_context',
      'translating',
      'validating',
      'saving',
      'completed',
    ]);

    // One progress update per accepted segment, each exactly one segment further.
    const steps = events
      .filter((e) => e.job.state === 'translating')
      .map((e) => e.job.completedSegments)
      .filter((n, i, all) => n !== all[i - 1]);
    expect(steps).toEqual(Array.from({ length: total + 1 }, (_, i) => i));

    // The percentage is the weighted formula applied to the stored segment count.
    for (const e of events.filter((x) => x.job.state === 'translating')) {
      const expected = Math.round((25 + (65 * e.job.completedSegments) / total) * 10) / 10;
      expect(e.job.percentage).toBe(expected);
      expect(e.job.totalSegments).toBe(total);
    }
    // Progress never goes backwards.
    const percentages = events.map((e) => e.job.percentage);
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    expect(percentages[percentages.length - 1]).toBe(100);

    // Counters match the work that was done.
    expect(finished).toMatchObject({
      completedSegments: total,
      totalSegments: total,
      completedEntries: 130,
      totalEntries: 130,
      percentage: 100,
      currentSegment: null,
      lockedBy: null,
      activeKey: null,
    });
    expect(translator.calls).toHaveLength(total);
    expect(await ctx.db.jobSegment.count({ where: { jobId: job.id } })).toBe(total);
  });

  it('shows the segment being translated and an estimate once two segments were measured', async () => {
    const { job } = await submit(ctx);
    (await createWorker(ctx, mock({ delayMs: 25 }))).start();
    await waitForJob(ctx.db, job.id);
    const events = jobEvents(await eventLog(ctx.db, job.id)).filter(
      (e) => e.job.state === 'translating',
    );

    const current = events.map((e) => e.job.currentSegment).filter((n): n is number => n !== null);
    expect([...new Set(current)]).toEqual(Array.from({ length: segmentCount() }, (_, i) => i + 1));

    for (const e of events) {
      // No guess before there is evidence.
      if (e.job.completedSegments < 2) expect(e.job.etaSeconds).toBeNull();
    }
    const withEstimate = events.filter((e) => e.job.etaSeconds !== null);
    expect(withEstimate.length).toBeGreaterThan(0);
    for (const e of withEstimate) expect(e.job.etaSeconds).toBeGreaterThanOrEqual(0);
  });

  it('produces the same subtitle as a direct engine run and stores it under the job id', async () => {
    const { job } = await submit(ctx);
    (await createWorker(ctx, mock())).start();
    const finished = await waitForJob(ctx.db, job.id);

    const direct = await translateSubtitle({ srt, targetLanguage: 'sr-Latn' }, mock(), {
      segmentation: segmentationFromConfig(ctx.config),
    });
    const stored = readFileSync(outputPath(ctx.config, finished.outputFile!), 'utf8');
    expect(stored).toBe(direct.srt);
    expect(finished.outputFile).toBe(`${job.id}.sr-Latn.srt`);
    expect(parseSrt(stored).entries).toHaveLength(130);
    expect(containsCyrillic(stored)).toBe(false);
    expect(JSON.parse(finished.usedModels!)).toEqual([
      { provider: 'mock', model: 'mock-pseudo-1' },
    ]);
    expect(finished.inputTokens).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe('TEST C — browser closure (no client connected at all)', () => {
  it('runs the job to completion with nothing but the worker and the database', async () => {
    // No API server, no SSE connection, no dashboard exists in this test.
    const { job } = await submit(ctx);
    (await createWorker(ctx, mock({ delayMs: 10 }))).start();
    const finished = await waitForJob(ctx.db, job.id);
    expect(finished.state).toBe('completed');
    // What a browser opened later would be shown:
    const snapshot = await readSnapshot(ctx.db);
    expect(snapshot.jobs.find((j) => j.id === job.id)).toMatchObject({
      state: 'completed',
      percentage: 100,
    });
    expect(snapshot.notifications).toHaveLength(1);
    expect(snapshot.notifications[0]).toMatchObject({
      kind: 'completed',
      jobId: job.id,
      read: false,
    });
  });
});

// ---------------------------------------------------------------------------
describe('TEST D — application restart', () => {
  it('recovers a job whose worker was killed and resumes from the last accepted segment', async () => {
    const total = segmentCount();
    const { job } = await submit(ctx);

    const first = mock({ delayMs: 60 });
    const worker1 = await createWorker(ctx, first, { id: 'worker-before-crash' });
    worker1.start();
    await waitForJob(
      ctx.db,
      job.id,
      until((j) => j.completedSegments >= 1),
    );
    await worker1.kill(); // like kill -9: nothing is written, the lock stays

    const crashed = (await getJob(ctx.db, job.id))!;
    expect(crashed.state).toBe('translating');
    expect(crashed.lockedBy).toBe('worker-before-crash');
    const savedBeforeCrash = crashed.completedSegments;
    expect(savedBeforeCrash).toBeGreaterThanOrEqual(1);
    expect(savedBeforeCrash).toBeLessThan(total);

    // A new worker process starts (own database connection).
    const second = mock();
    const worker2 = await createWorker(ctx, second, {
      id: 'worker-after-restart',
      separateConnection: true,
    });
    worker2.start();

    // The dead worker's claim is respected until its lease runs out…
    await sleep(150);
    expect((await getJob(ctx.db, job.id))!.lockedBy).toBe('worker-before-crash');

    // …then the job is recovered and finished.
    const finished = await waitForJob(ctx.db, job.id);
    expect(finished).toMatchObject({
      state: 'completed',
      attempt: 2,
      percentage: 100,
      completedSegments: total,
    });

    // Segments accepted before the crash were NOT translated again.
    const redone = second.calls.map((c) => c.segmentIndex);
    expect(redone).toEqual(
      Array.from({ length: total - savedBeforeCrash }, (_, i) => i + savedBeforeCrash),
    );
    // The resumed segment still got the earlier translations as context.
    expect(second.calls[0]?.contextBefore.every((c) => c.translation !== undefined)).toBe(true);

    // The result is identical to an uninterrupted run.
    const direct = await translateSubtitle({ srt, targetLanguage: 'sr-Latn' }, mock(), {
      segmentation: segmentationFromConfig(ctx.config),
    });
    expect(readFileSync(outputPath(ctx.config, finished.outputFile!), 'utf8')).toBe(direct.srt);

    // The recovery is visible, and progress never went backwards.
    const events = jobEvents(await eventLog(ctx.db, job.id));
    expect(
      events.some((e) => e.job.statusDetail?.includes('Recovered after the worker stopped')),
    ).toBe(true);
    const percentages = events.map((e) => e.job.percentage);
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
  });

  it('puts a job that keeps losing its worker into an explicit, retryable failure state', async () => {
    const limited = await createContext({ JOB_MAX_ATTEMPTS: '2' });
    try {
      const { job } = await submit(limited);
      for (let run = 1; run <= 2; run++) {
        const worker = await createWorker(limited, mock({ delayMs: 80 }), {
          id: `crashing-${run}`,
        });
        worker.start();
        await waitForJob(
          limited.db,
          job.id,
          until((j) => j.lockedBy === `crashing-${run}` && j.completedSegments >= run),
        );
        await worker.kill();
        await sleep(550); // lease expires
        await recoverExpiredJobs(limited.db, limited.config.jobs.maxAttempts);
      }
      const failed = (await getJob(limited.db, job.id))!;
      expect(failed).toMatchObject({
        state: 'failed',
        errorCode: 'interrupted_by_restart',
        errorStage: 'translating',
        lockedBy: null,
        activeKey: null,
      });
      expect(failed.errorMessage).toContain('retry the job to continue');
      expect(failed.percentage).toBeGreaterThan(25);
      expect(failed.percentage).toBeLessThan(100);

      // The owner retries: the kept segments are reused and the job completes.
      const kept = failed.completedSegments;
      await retryJob(limited.db, job.id);
      const resumed = mock();
      (await createWorker(limited, resumed)).start();
      const finished = await waitForJob(limited.db, job.id);
      expect(finished).toMatchObject({ state: 'completed', attempt: 3, errorCode: null });
      expect(resumed.calls).toHaveLength(finished.totalSegments - kept);
    } finally {
      await limited.cleanup();
    }
  });

  it('hands a job back immediately on a graceful shutdown', async () => {
    const { job } = await submit(ctx);
    const worker1 = await createWorker(ctx, mock({ delayMs: 60 }));
    worker1.start();
    await waitForJob(
      ctx.db,
      job.id,
      until((j) => j.completedSegments >= 1),
    );
    await worker1.stop();

    const released = (await getJob(ctx.db, job.id))!;
    expect(released).toMatchObject({ state: 'queued', lockedBy: null, attempt: 1 });
    expect(released.completedSegments).toBeGreaterThanOrEqual(1);
    expect(released.percentage).toBeGreaterThan(25);

    const second = mock();
    (await createWorker(ctx, second)).start();
    const finished = await waitForJob(ctx.db, job.id);
    expect(finished.state).toBe('completed');
    expect(second.calls).toHaveLength(finished.totalSegments - released.completedSegments);
  });

  it('a worker that lost its claim cannot write anything', async () => {
    const { job } = await submit(ctx);
    const claimed = (await claimNextJob(ctx.db, 'old-worker', 500))!;
    const started = await transitionJob(ctx.db, claimed, 'old-worker', 'locating_source');

    await recoverExpiredJobs(ctx.db, 3, new Date(Date.now() + 10_000)); // lease expired
    const taken = (await claimNextJob(ctx.db, 'new-worker', 500))!;
    expect(taken).toMatchObject({ id: job.id, lockedBy: 'new-worker', attempt: 2 });

    await expect(
      transitionJob(ctx.db, started, 'old-worker', 'downloading_source'),
    ).rejects.toThrow(LostLockError);
    expect((await getJob(ctx.db, job.id))!).toMatchObject({
      state: 'queued',
      lockedBy: 'new-worker',
    });
  });

  it('rejects an illegal state transition without touching the job', async () => {
    await submit(ctx);
    const claimed = (await claimNextJob(ctx.db, 'w', 500))!;
    const before = await ctx.db.jobEvent.count();
    await expect(transitionJob(ctx.db, claimed, 'w', 'translating')).rejects.toThrow(
      InvalidTransitionError,
    );
    await expect(transitionJob(ctx.db, claimed, 'w', 'completed')).rejects.toThrow(
      /queued → completed/,
    );
    expect((await getJob(ctx.db, claimed.id))!.state).toBe('queued');
    expect(await ctx.db.jobEvent.count()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('TEST E — duplicate requests', () => {
  it('creates exactly one job for simultaneous identical requests', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(ctx)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
    expect(results.filter((r) => !r.created).every((r) => r.reason === 'active')).toBe(true);
    expect(await ctx.db.translationJob.count()).toBe(1);
    // Losers of the race left no stray files behind.
    const events = await eventLog(ctx.db);
    expect(events.filter((e) => e.type === 'job.created')).toHaveLength(1);
  });

  it('treats the same subtitle in another encoding or line ending as the same request', async () => {
    const first = await submit(ctx);
    const crlf = await submit(ctx, {
      srt: '﻿' + srt.replace(/\n/g, '\r\n'),
      sourceName: 'copy.srt',
    });
    expect(crlf).toMatchObject({ created: false, reason: 'active' });
    expect(crlf.job.id).toBe(first.job.id);
  });

  it('creates separate jobs for requests that really differ', async () => {
    const latin = await submit(ctx);
    const cyrillic = await submit(ctx, { targetLanguage: 'sr-Cyrl' });
    const literal = await submit(ctx, { profile: 'literal' });
    const other = await submit(ctx, { srt: fixtureText('basic-movie.srt') });
    expect([latin, cyrillic, literal, other].every((r) => r.created)).toBe(true);
    expect(new Set([latin, cyrillic, literal, other].map((r) => r.job.id)).size).toBe(4);
  });

  it('returns the finished translation instead of translating the same subtitle again', async () => {
    const { job } = await submit(ctx);
    const translator = mock();
    (await createWorker(ctx, translator)).start();
    await waitForJob(ctx.db, job.id);
    const calls = translator.calls.length;

    const again = await submit(ctx);
    expect(again).toMatchObject({ created: false, reason: 'completed' });
    expect(again.job.id).toBe(job.id);
    await sleep(150);
    expect(translator.calls).toHaveLength(calls);

    // …unless the owner explicitly asks for a new translation,
    const forced = await submit(ctx, { force: true });
    expect(forced.created).toBe(true);
    expect(forced.job.id).not.toBe(job.id);
    // …or the stored file is gone.
    await waitForJob(ctx.db, forced.job.id);
    // The forced translation replaced the cached file; the older job now points at the new one.
    const files = new Set((await ctx.db.translationJob.findMany()).map((j) => j.outputFile!));
    expect(files.size).toBe(1);
    for (const file of files) rmSync(outputPath(ctx.config, file));
    expect((await submit(ctx)).created).toBe(true);
  });

  it('never lets two workers process the same job', async () => {
    const jobs = await Promise.all(
      ['sr-Latn', 'sr-Cyrl', 'hr', 'de'].map((targetLanguage) => submit(ctx, { targetLanguage })),
    );
    const translators = [mock({ delayMs: 10 }), mock({ delayMs: 10 })];
    for (const translator of translators) {
      (await createWorker(ctx, translator, { separateConnection: true })).start();
    }
    const finished = await Promise.all(jobs.map((j) => waitForJob(ctx.db, j.job.id)));
    expect(finished.every((j) => j.state === 'completed')).toBe(true);

    const calls = translators.flatMap((t) => t.calls);
    for (const job of finished) {
      const mine = calls
        .filter((c) => c.targetLanguage.id === job.targetLanguage)
        .map((c) => c.segmentIndex);
      // Each segment of each job was requested exactly once, by one worker.
      expect(mine.sort((a, b) => a - b)).toEqual(
        Array.from({ length: job.totalSegments }, (_, i) => i),
      );
    }
    // Both workers actually took part.
    expect(translators.every((t) => t.calls.length > 0)).toBe(true);
  });

  it('rejects invalid requests before a job exists', async () => {
    await expect(submit(ctx, { srt: 'not a subtitle' })).rejects.toThrow(JobRequestError);
    await expect(submit(ctx, { targetLanguage: 'bs' })).rejects.toMatchObject({
      code: 'unsupported_language',
    });
    await expect(submit(ctx, { targetLanguage: 'sr' })).rejects.toThrow(/explicit script/);
    await expect(submit(ctx, { profile: 'custom' })).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect(await ctx.db.translationJob.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('TEST F — cancellation', () => {
  it('processes no further segment after the cancellation is acknowledged', async () => {
    const total = segmentCount();
    const { job } = await submit(ctx);
    const translator = mock({ delayMs: 70 });
    (await createWorker(ctx, translator)).start();
    await waitForJob(
      ctx.db,
      job.id,
      until((j) => j.completedSegments >= 1),
    );

    const requested = await requestCancel(ctx.db, job.id);
    expect(requested).toMatchObject({ cancelRequested: true, statusDetail: 'Cancelling…' });
    expect(requested.state).not.toBe('cancelled'); // not acknowledged yet

    const cancelled = await waitForJob(ctx.db, job.id);
    expect(cancelled).toMatchObject({
      state: 'cancelled',
      lockedBy: null,
      activeKey: null,
      outputFile: null,
    });
    const callsAtAcknowledgement = translator.calls.length;
    expect(callsAtAcknowledgement).toBeLessThan(total);

    await sleep(400);
    expect(translator.calls).toHaveLength(callsAtAcknowledgement);
    const after = (await getJob(ctx.db, job.id))!;
    expect(after.state).toBe('cancelled');
    expect(after.updatedAt).toEqual(cancelled.updatedAt);

    // Partial work is dropped, nothing was published, nobody is notified.
    expect(await ctx.db.jobSegment.count({ where: { jobId: job.id } })).toBe(0);
    expect(existsSync(outputPath(ctx.config, `${job.id}.sr-Latn.srt`))).toBe(false);
    expect(await listNotifications(ctx.db)).toHaveLength(0);
    const events = jobEvents(await eventLog(ctx.db, job.id));
    expect(events[events.length - 1]).toMatchObject({ type: 'job.cancelled' });
    expect(events.some((e) => e.job.state === 'completed' || e.job.percentage === 100)).toBe(false);
    expect(cancelled.percentage).toBeLessThan(100);
  });

  it('aborts a request that is in flight instead of waiting for it', async () => {
    const { job } = await submit(ctx);
    (await createWorker(ctx, mock({ delayMs: 30_000 }))).start();
    await waitForJob(
      ctx.db,
      job.id,
      until((j) => j.currentSegment === 1),
    );
    const started = Date.now();
    await requestCancel(ctx.db, job.id);
    const cancelled = await waitForJob(ctx.db, job.id, { timeoutMs: 5000 });
    expect(cancelled.state).toBe('cancelled');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('cancels a queued job on the spot and frees its translation key', async () => {
    const { job } = await submit(ctx);
    const cancelled = await requestCancel(ctx.db, job.id);
    expect(cancelled).toMatchObject({ state: 'cancelled', activeKey: null });
    // A worker that starts later does not touch it.
    const translator = mock();
    (await createWorker(ctx, translator)).start();
    await sleep(200);
    expect(translator.calls).toHaveLength(0);
    // The same request can be submitted again.
    expect((await submit(ctx)).created).toBe(true);
  });

  it('refuses to cancel a finished job', async () => {
    const { job } = await submit(ctx);
    (await createWorker(ctx, mock())).start();
    await waitForJob(ctx.db, job.id);
    await expect(requestCancel(ctx.db, job.id)).rejects.toThrow(JobConflictError);
    expect((await getJob(ctx.db, job.id))!.state).toBe('completed');
    await expect(requestCancel(ctx.db, 'missing')).rejects.toThrow(/does not exist/);
  });
});

// ---------------------------------------------------------------------------
describe('TEST G — provider failure', () => {
  /** Provider double: hangs until aborted, fails with a kind, or answers correctly. */
  function provider(
    id: AiProviderId,
    behaviour: (call: number) => 'ok' | 'hang' | 'server' | 'auth',
  ) {
    let calls = 0;
    const target = resolveTargetLanguage('sr-Latn');
    const instance: AiProvider = {
      id,
      async complete(request) {
        const outcome = behaviour(++calls);
        if (outcome === 'hang') {
          await new Promise((_resolve, reject) =>
            request.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
          );
        }
        if (outcome !== 'ok') {
          // A hung request ends when the manager's timeout aborts it; the manager reports the timeout.
          throw new ProviderError(
            id,
            outcome === 'hang' ? 'unknown' : outcome,
            `simulated ${outcome}`,
          );
        }
        const start = request.user.lastIndexOf('{"translate":');
        const payload = JSON.parse(request.user.slice(start)) as {
          translate: { id: number; text: string }[];
        };
        return {
          text: JSON.stringify({
            translations: payload.translate.map((i) => ({
              id: i.id,
              text: mockTranslateText(i.text, target),
            })),
          }),
          provider: id,
          model: request.model,
          usage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    };
    return { instance, calls: () => calls };
  }

  function factory(
    primary: ReturnType<typeof provider>,
    fallback?: ReturnType<typeof provider>,
    maxRetries = 2,
  ): TranslatorFactory {
    return (_job, hooks) =>
      createProviderManager({
        providers: {
          anthropic: primary.instance,
          ...(fallback ? { openai: fallback.instance } : {}),
        },
        primary: { provider: 'anthropic', model: 'claude-opus-5-5' },
        fallback: fallback ? { provider: 'openai', model: 'gpt-6.1-sol' } : undefined,
        effort: 'medium',
        maxOutputTokens: 32_000,
        requestTimeoutMs: 40,
        retry: { maxRetries, baseDelayMs: 5, maxDelayMs: 10 },
        onEvent: hooks.onProviderEvent,
      }).translator;
  }

  it('retries a provider timeout and continues when the provider answers again', async () => {
    const flaky = provider('anthropic', (call) => (call === 1 ? 'hang' : 'ok'));
    const { job } = await submit(ctx);
    (await createWorker(ctx, factory(flaky))).start();
    const finished = await waitForJob(ctx.db, job.id);

    expect(finished.state).toBe('completed');
    expect(finished.retryCount).toBe(1);
    expect(flaky.calls()).toBe(finished.totalSegments + 1);
    expect(JSON.parse(finished.usedModels!)).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5-5' },
    ]);
    const notes = jobEvents(await eventLog(ctx.db, job.id)).map((e) => e.job.statusDetail);
    expect(notes).toContain('anthropic: timeout — retrying in 1s');
  });

  it('falls back to the second provider when the first keeps timing out', async () => {
    const dead = provider('anthropic', () => 'hang');
    const backup = provider('openai', () => 'ok');
    const { job } = await submit(ctx);
    (await createWorker(ctx, factory(dead, backup, 1))).start();
    const finished = await waitForJob(ctx.db, job.id);

    expect(finished.state).toBe('completed');
    expect(backup.calls()).toBe(finished.totalSegments);
    expect(JSON.parse(finished.usedModels!)).toEqual([
      { provider: 'openai', model: 'gpt-6.1-sol' },
    ]);
    // Each segment: 1 try + 1 retry on the dead provider, then the fallback.
    expect(dead.calls()).toBe(finished.totalSegments * 2);
    expect(finished.retryCount).toBe(finished.totalSegments);
    const notes = jobEvents(await eventLog(ctx.db, job.id)).map((e) => e.job.statusDetail);
    expect(notes).toContain('anthropic failed (timeout) — using openai / gpt-6.1-sol');
    // The failure and the job that survived it are both visible; no failure notification.
    expect((await listNotifications(ctx.db)).map((n) => n.kind)).toEqual(['completed']);
  });

  it('fails the job visibly when every provider fails', async () => {
    const dead = provider('anthropic', () => 'server');
    const alsoDead = provider('openai', () => 'auth');
    const { job } = await submit(ctx);
    (await createWorker(ctx, factory(dead, alsoDead, 1))).start();
    const failed = await waitForJob(ctx.db, job.id);

    expect(failed).toMatchObject({
      state: 'failed',
      errorCode: 'provider_auth',
      errorStage: 'translating',
      lockedBy: null,
      completedSegments: 0,
      outputFile: null,
    });
    expect(failed.errorMessage).toContain('anthropic: server');
    expect(failed.errorMessage).toContain('openai: auth');
    expect(failed.percentage).toBe(25);
    expect(dead.calls()).toBe(2);
    expect(alsoDead.calls()).toBe(1);
  });

  it('retries a segment whose answer is invalid, and fails after the limit without publishing anything', async () => {
    const recovering = mock({
      fault: (r) => (r.segmentIndex === 1 && r.attempt === 1 ? 'missing_entry' : undefined),
    });
    const first = await submit(ctx);
    const worker = await createWorker(ctx, recovering);
    worker.start();
    const finished = await waitForJob(ctx.db, first.job.id);
    expect(finished).toMatchObject({ state: 'completed', retryCount: 1 });
    expect(
      jobEvents(await eventLog(ctx.db, first.job.id)).some((e) =>
        e.job.statusDetail?.includes('answer rejected'),
      ),
    ).toBe(true);
    await worker.stop();

    const broken = mock({ fault: (r) => (r.segmentIndex === 1 ? 'drop_tags' : undefined) });
    const second = await submit(ctx, { targetLanguage: 'hr' });
    (await createWorker(ctx, broken)).start();
    const failed = await waitForJob(ctx.db, second.job.id);
    expect(failed).toMatchObject({
      state: 'failed',
      errorCode: 'segment_failed',
      errorStage: 'translating',
    });
    expect(failed.errorMessage).toContain(
      'Segment 2 could not be translated correctly after 3 attempt',
    );
    // The segment that succeeded is kept for a retry; the broken one was tried exactly 3 times.
    expect(failed.completedSegments).toBe(1);
    expect(broken.calls.filter((c) => c.segmentIndex === 1)).toHaveLength(3);
    expect(broken.calls.some((c) => c.segmentIndex > 1)).toBe(false);
    expect(failed.outputFile).toBeNull();
  });

  it('works with a real prompt/parse round trip through the LLM translator', async () => {
    const good = provider('anthropic', () => 'ok');
    const { job } = await submit(ctx, { srt: fixtureText('formatting.srt') });
    (
      await createWorker(ctx, () =>
        createLlmTranslator({
          complete: (r) =>
            good.instance.complete({ ...r, model: 'm', effort: 'low', maxOutputTokens: 1000 }),
        }),
      )
    ).start();
    expect((await waitForJob(ctx.db, job.id)).state).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
describe('TEST H — completion', () => {
  it('reaches 100% only after the translated file has been saved', async () => {
    const { job } = await submit(ctx);
    const file = outputPath(ctx.config, `${job.id}.sr-Latn.srt`);

    // Observe the job continuously while it runs: 100% and the file must appear together.
    const observations: { percentage: number; state: string; fileExists: boolean }[] = [];
    let observing = true;
    const observer = (async () => {
      while (observing) {
        const row = await getJob(ctx.db, job.id);
        if (row)
          observations.push({
            percentage: row.percentage,
            state: row.state,
            fileExists: existsSync(file),
          });
        await sleep(2);
      }
    })();
    (await createWorker(ctx, mock({ delayMs: 10 }))).start();
    const finished = await waitForJob(ctx.db, job.id);
    observing = false;
    await observer;

    expect(finished).toMatchObject({ state: 'completed', percentage: 100 });
    expect(finished.completedAt).not.toBeNull();
    expect(existsSync(file)).toBe(true);
    for (const o of observations) {
      if (o.percentage === 100 || o.state === 'completed') expect(o.fileExists).toBe(true);
      if (o.state !== 'completed') expect(o.percentage).toBeLessThan(100);
    }

    const events = jobEvents(await eventLog(ctx.db, job.id));
    const hundred = events.filter((e) => e.job.percentage === 100);
    expect(hundred).toHaveLength(1);
    expect(hundred[0]).toMatchObject({ type: 'job.completed' });
    expect(hundred[0]?.job).toMatchObject({ state: 'completed', hasOutput: true });
    // Validation and saving were distinct, earlier steps.
    expect(events.find((e) => e.job.state === 'validating')?.job.percentage).toBe(90);
    expect(events.find((e) => e.job.state === 'saving')?.job.percentage).toBe(97);
  });

  it('does not complete when the file cannot be saved', async () => {
    // Make the output location unusable: the subtitles "directory" is a file.
    rmSync(ctx.config.paths.subtitlesDir, { recursive: true });
    writeFileSync(ctx.config.paths.subtitlesDir, 'not a directory');

    const { job } = await submit(ctx);
    (await createWorker(ctx, mock())).start();
    const failed = await waitForJob(ctx.db, job.id);

    expect(failed).toMatchObject({
      state: 'failed',
      errorCode: 'save_failed',
      errorStage: 'saving',
      percentage: 97,
      outputFile: null,
    });
    const events = jobEvents(await eventLog(ctx.db, job.id));
    expect(events.some((e) => e.job.percentage === 100 || e.job.state === 'completed')).toBe(false);
    // Every segment is kept, so a retry after fixing the disk only has to save.
    expect(failed.completedSegments).toBe(failed.totalSegments);
  });

  it('does not complete when the final validation fails', async () => {
    // The translator answers with text that corrupts the SRT structure only once assembled.
    const translator = mock({
      translate: (text, request) =>
        request.items[0]?.id === 1 && text === request.items[0]?.text
          ? 'Prvi red\n00:00:01,000 --> 00:00:02,000\nubačeno'
          : mockTranslateText(text, request.targetLanguage),
    });
    const { job } = await submit(ctx, { targetLanguage: 'hr' });
    (await createWorker(ctx, translator)).start();
    const failed = await waitForJob(ctx.db, job.id);
    expect(failed).toMatchObject({
      state: 'failed',
      errorCode: 'validation_failed',
      errorStage: 'validating',
      percentage: 90,
    });
    expect(existsSync(outputPath(ctx.config, `${job.id}.hr.srt`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('TEST I — notifications', () => {
  it('creates exactly one notification for a completed job', async () => {
    const { job } = await submit(ctx, { mediaTitle: 'Harbor Lights' });
    (await createWorker(ctx, mock())).start();
    await waitForJob(ctx.db, job.id);
    await sleep(150);

    const notifications = await listNotifications(ctx.db);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      jobId: job.id,
      kind: 'completed',
      title: 'Translation completed',
      message: 'Harbor Lights → Serbian (Latin)',
      readAt: null,
    });
    const created = (await eventLog(ctx.db)).filter((e) => e.type === 'notification.created');
    expect(created).toHaveLength(1);
    expect(created[0]?.notification.id).toBe(notifications[0]?.id);
  });

  it('creates exactly one notification for a failed job, and one more only for a new failed run', async () => {
    const { job } = await submit(ctx, { mediaTitle: 'Harbor Lights' });
    (await createWorker(ctx, mock({ fault: () => 'error' }))).start();
    await waitForJob(ctx.db, job.id);
    await sleep(150);

    let notifications = await listNotifications(ctx.db);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      kind: 'failed',
      title: 'Translation failed',
      attempt: 1,
    });
    expect(notifications[0]?.message).toContain('Harbor Lights: Mock provider failure');

    // The owner retries; it fails again: that is a new event, with its own single notification.
    await retryJob(ctx.db, job.id);
    await waitForJob(
      ctx.db,
      job.id,
      until((j) => j.state === 'failed' && j.attempt === 2),
    );
    await sleep(150);
    notifications = await listNotifications(ctx.db);
    expect(notifications.map((n) => [n.kind, n.attempt]).sort()).toEqual([
      ['failed', 1],
      ['failed', 2],
    ]);
    expect((await eventLog(ctx.db)).filter((e) => e.type === 'notification.created')).toHaveLength(
      2,
    );
  });

  it('does not notify twice when a job is recovered after a crash', async () => {
    const { job } = await submit(ctx);
    const worker1 = await createWorker(ctx, mock({ delayMs: 60 }));
    worker1.start();
    await waitForJob(
      ctx.db,
      job.id,
      until((j) => j.completedSegments >= 1),
    );
    await worker1.kill();
    (await createWorker(ctx, mock())).start();
    await waitForJob(ctx.db, job.id);
    expect((await listNotifications(ctx.db)).map((n) => n.kind)).toEqual(['completed']);
  });

  it('keeps notifications until they are read, and reports reading once', async () => {
    const { job } = await submit(ctx);
    (await createWorker(ctx, mock())).start();
    await waitForJob(ctx.db, job.id);
    const [notification] = await listNotifications(ctx.db, { unreadOnly: true });

    expect((await readSnapshot(ctx.db)).notifications).toHaveLength(1);
    const read = await markNotificationRead(ctx.db, notification!.id);
    expect(read?.readAt).not.toBeNull();
    await markNotificationRead(ctx.db, notification!.id);
    expect((await eventLog(ctx.db)).filter((e) => e.type === 'notification.read')).toHaveLength(1);
    expect(await listNotifications(ctx.db, { unreadOnly: true })).toHaveLength(0);
    expect(await listNotifications(ctx.db)).toHaveLength(1);
    expect((await readSnapshot(ctx.db)).notifications).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('TEST J — event log for real-time updates (store level)', () => {
  it('lets a client that was away catch up from the last event it saw', async () => {
    const { job } = await submit(ctx);
    (await createWorker(ctx, mock({ delayMs: 20 }))).start();
    await waitForJob(
      ctx.db,
      job.id,
      until((j) => j.completedSegments >= 1),
    );

    // The client disconnects here, having seen everything up to this id.
    const seen = (await readSnapshot(ctx.db)).lastEventId;
    await waitForJob(ctx.db, job.id);

    const missed = await readEventsAfter(ctx.db, seen);
    expect(missed.length).toBeGreaterThan(0);
    expect(missed.map((e) => e.id)).toEqual([...missed.map((e) => e.id)].sort((a, b) => a - b));
    expect(missed.every((e) => e.id > seen)).toBe(true);
    expect(missed.some((e) => e.type === 'job.completed')).toBe(true);
    expect(missed.some((e) => e.type === 'notification.created')).toBe(true);

    // And a fresh snapshot alone is enough to show the current state.
    const snapshot = await readSnapshot(ctx.db);
    expect(snapshot.lastEventId).toBe(missed[missed.length - 1]?.id);
    expect(snapshot.jobs.find((j) => j.id === job.id)).toMatchObject({
      state: 'completed',
      percentage: 100,
    });
  });

  it('includes active and recently finished jobs in the snapshot', async () => {
    const done = await submit(ctx, { targetLanguage: 'hr' });
    const worker = await createWorker(ctx, mock());
    worker.start();
    await waitForJob(ctx.db, done.job.id);
    await worker.stop();
    const waiting = await submit(ctx);

    const snapshot = await readSnapshot(ctx.db);
    expect(snapshot.jobs.map((j) => [j.id, j.state])).toEqual([
      [waiting.job.id, 'queued'],
      [done.job.id, 'completed'],
    ]);
    // Internal fields never leave the server.
    const json = JSON.stringify(snapshot);
    for (const secret of [
      'lockedBy',
      'leaseExpiresAt',
      'sourceFile',
      'outputFile',
      'translationKey',
      'activeKey',
    ]) {
      expect(json).not.toContain(secret);
    }
  });
});
