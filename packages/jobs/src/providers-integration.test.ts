/**
 * Phase 7 — provider failures and rate limits through the production code path.
 *
 * Everything is real except the network: the worker uses the same translator
 * factory as production (`createDefaultTranslatorFactory`), which builds the
 * real Claude / OpenAI / Gemini adapters on top of the official SDKs. Only the
 * HTTP transport is replaced, and it answers in each provider's actual wire
 * format — including 429 with `retry-after`, 529 overloaded, 500 and 401.
 */
import { readFileSync } from 'node:fs';
import { setTimeout as sleepTimer } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  anthropicError,
  anthropicStream,
  fakeHttp,
  geminiError,
  geminiResponse,
  openAiError,
  openAiResponse,
  translateFromPrompt,
  type RecordedCall,
} from '@asc/ai-providers/testing';
import { parseSrt } from '@asc/subtitle-parser';
import { containsCyrillic } from '@asc/translation-engine';
import {
  createDefaultTranslatorFactory,
  jobTimeline,
  listNotifications,
  requestCancel,
  retryJob,
  waitForJob,
} from './index.js';
import { outputPath } from './files.js';
import { fixtureText } from './test-fixtures.js';
import { createContext, createWorker, submit, type TestContext } from './test-helpers.js';

let ctx: TestContext;
afterEach(async () => {
  await ctx.cleanup();
});

const KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-test-0000000000000000',
  OPENAI_API_KEY: 'sk-test-openai-000000000000',
  GEMINI_API_KEY: 'gemini-test-key-000000000000',
};

/** A real installation configured for real providers (no mock AI). */
async function setup(env: Record<string, string> = {}) {
  ctx = await createContext({
    MOCK_AI: 'false',
    ...KEYS,
    AI_PROVIDER: 'anthropic',
    AI_FALLBACK_PROVIDER: 'openai',
    AI_MAX_RETRIES: '2',
    AI_MAX_SEGMENT_ENTRIES: '40',
    ...env,
  });
}

type Host = 'anthropic' | 'openai' | 'gemini';
const hostOf = (call: RecordedCall): Host =>
  call.url.includes('anthropic.com')
    ? 'anthropic'
    : call.url.includes('openai.com')
      ? 'openai'
      : 'gemini';

/** The prompt text each provider receives, from its wire format. */
function promptOf(call: RecordedCall): string {
  switch (hostOf(call)) {
    case 'anthropic':
      return (call.body.messages as { content: string }[])[0]?.content ?? '';
    case 'openai':
      return String(call.body.input);
    case 'gemini':
      return (call.body.contents as { parts: { text: string }[] }[])[0]?.parts[0]?.text ?? '';
  }
}

/** A correct answer in the provider's own format. */
function answer(call: RecordedCall, target: string): Response {
  const text = translateFromPrompt(promptOf(call), target);
  switch (hostOf(call)) {
    case 'anthropic':
      return anthropicStream({ text, model: String(call.body.model) });
    case 'openai':
      return openAiResponse({ text, model: String(call.body.model) });
    case 'gemini':
      return geminiResponse({ text });
  }
}

type Outcome = Response | 'ok';

/**
 * Fake provider network: `script(host, n)` decides the n-th call (1-based, per
 * provider). Records every call and every pause the retry policy asked for.
 */
function network(target: string, script: (host: Host, n: number) => Outcome) {
  const counts: Record<Host, number> = { anthropic: 0, openai: 0, gemini: 0 };
  const http = fakeHttp((call) => {
    const host = hostOf(call);
    const outcome = script(host, ++counts[host]);
    return outcome === 'ok' ? answer(call, target) : outcome;
  });
  const pauses: number[] = [];
  const sleep = async (ms: number, signal?: AbortSignal) => {
    pauses.push(ms);
    signal?.throwIfAborted();
    await Promise.resolve();
  };
  const factory = createDefaultTranslatorFactory({ fetch: http.fetch, sleep });
  return { factory, counts, pauses, calls: http.calls };
}

const notes = async (jobId: string) =>
  (await jobTimeline(ctx.db, jobId)).entries.map((e) => e.detail).filter(Boolean);

function output(job: { outputFile: string | null }): string {
  return readFileSync(outputPath(ctx.config, job.outputFile ?? ''), 'utf8');
}

describe('rate limits', () => {
  it('waits as long as the provider asks (retry-after) and then continues', async () => {
    await setup();
    const net = network('sr-Latn', (host, n) =>
      host === 'anthropic' && n === 2
        ? anthropicError(429, 'rate_limit_error', { 'retry-after': '7' })
        : 'ok',
    );
    const { job } = await submit(ctx);
    (await createWorker(ctx, net.factory)).start();
    const done = await waitForJob(ctx.db, job.id);
    expect(done.state).toBe('completed');
    expect(done.retryCount).toBe(1);
    expect(net.pauses).toEqual([7000]);
    expect(net.counts.openai).toBe(0); // no fallback for a pause the provider asked for
    expect(net.counts.anthropic).toBe(done.totalSegments + 1);
    expect(await notes(job.id)).toContain('anthropic: rate limit — retrying in 7s');
    expect(JSON.parse(done.usedModels!)).toEqual([{ provider: 'anthropic', model: done.model }]);
  });

  it('backs off on its own when a rate limit comes without retry-after (Gemini)', async () => {
    await setup({ AI_PROVIDER: 'gemini', AI_FALLBACK_PROVIDER: '' });
    const net = network('hr', (_host, n) =>
      n <= 2 ? geminiError(429, 'Resource exhausted', 'RESOURCE_EXHAUSTED') : 'ok',
    );
    const { job } = await submit(ctx, { targetLanguage: 'hr' });
    (await createWorker(ctx, net.factory)).start();
    const done = await waitForJob(ctx.db, job.id);

    expect(done.state).toBe('completed');
    expect(net.pauses).toHaveLength(2);
    // Exponential: the second pause is in a higher band than the first.
    expect(net.pauses[1]!).toBeGreaterThanOrEqual(net.pauses[0]!);
    expect(done.retryCount).toBe(2);
  });

  it('does not sit out a very long retry-after: it switches to the fallback instead', async () => {
    await setup();
    const net = network('sr-Latn', (host) =>
      host === 'anthropic'
        ? anthropicError(429, 'rate_limit_error', { 'retry-after': '3600' })
        : 'ok',
    );
    const { job } = await submit(ctx);
    (await createWorker(ctx, net.factory)).start();
    const done = await waitForJob(ctx.db, job.id);

    expect(done.state).toBe('completed');
    expect(net.pauses).toEqual([]);
    expect(net.counts.openai).toBe(done.totalSegments);
    expect(await notes(job.id)).toContain(
      `anthropic failed (rate limit) — using openai / ${(JSON.parse(done.usedModels!) as { model: string }[])[0]?.model}`,
    );
  });

  it('cancelling during a rate-limit pause stops the job at once', async () => {
    await setup();
    const http = fakeHttp((call) =>
      hostOf(call) === 'anthropic'
        ? anthropicError(429, 'rate_limit_error', { 'retry-after': '60' })
        : answer(call, 'sr-Latn'),
    );
    // Real timers this time: the job really sleeps for the provider's 60 s.
    const factory = createDefaultTranslatorFactory({ fetch: http.fetch });
    const { job } = await submit(ctx);
    (await createWorker(ctx, factory)).start();
    await waitForJob(ctx.db, job.id, {
      until: (j) => j.statusDetail?.includes('rate limit') ?? false,
    });

    const asked = Date.now();
    await requestCancel(ctx.db, job.id);
    const cancelled = await waitForJob(ctx.db, job.id);
    expect(cancelled.state).toBe('cancelled');
    expect(Date.now() - asked).toBeLessThan(3000);
    expect(http.calls.filter((c) => hostOf(c) === 'openai')).toHaveLength(0);
  });
});

describe('provider failures', () => {
  it('retries an overloaded provider, then completes on the fallback', async () => {
    await setup();
    const net = network('sr-Latn', (host) =>
      host === 'anthropic' ? anthropicError(529, 'overloaded_error') : 'ok',
    );
    const { job } = await submit(ctx);
    (await createWorker(ctx, net.factory)).start();
    const done = await waitForJob(ctx.db, job.id);

    expect(done.state).toBe('completed');
    // Each segment: 1 try + 2 retries on Claude, then OpenAI.
    expect(net.counts.anthropic).toBe(done.totalSegments * 3);
    expect(net.counts.openai).toBe(done.totalSegments);
    expect((await listNotifications(ctx.db)).map((n) => n.kind)).toEqual(['completed']);
  });

  it('stops calling a provider with a rejected key and uses the fallback for the rest', async () => {
    await setup();
    const net = network('sr-Cyrl', (host) =>
      host === 'anthropic' ? anthropicError(401, 'authentication_error') : 'ok',
    );
    const { job } = await submit(ctx, { targetLanguage: 'sr-Cyrl' });
    (await createWorker(ctx, net.factory)).start();
    const done = await waitForJob(ctx.db, job.id);

    expect(done.state).toBe('completed');
    expect(net.counts.anthropic).toBe(1); // never retried, never asked again
    expect(net.pauses).toEqual([]);
    expect(containsCyrillic(output(done))).toBe(true);
    // The key never travels anywhere but its own provider.
    for (const call of net.calls) {
      const sent = JSON.stringify(call.headers);
      if (hostOf(call) !== 'anthropic') expect(sent).not.toContain(KEYS.ANTHROPIC_API_KEY);
      if (hostOf(call) !== 'openai') expect(sent).not.toContain(KEYS.OPENAI_API_KEY);
    }
  });

  it('fails visibly when every provider is down, keeps finished segments, and resumes on retry', async () => {
    await setup({ AI_MAX_RETRIES: '1' });
    let down = true;
    const net = network('sr-Latn', (host, n) => {
      if (host === 'anthropic' && n === 1) return 'ok'; // the first segment gets through
      if (!down) return 'ok';
      return host === 'anthropic'
        ? anthropicError(500, 'api_error')
        : openAiError(503, 'server_error');
    });
    const { job } = await submit(ctx);
    (await createWorker(ctx, net.factory)).start();
    const failed = await waitForJob(ctx.db, job.id);

    expect(failed).toMatchObject({
      state: 'failed',
      errorStage: 'translating',
      completedSegments: 1,
      outputFile: null,
    });
    expect(failed.errorCode).toMatch(/^provider_(server|overloaded)$/);
    expect(failed.errorMessage).toContain('anthropic: server');
    expect(failed.errorMessage).toContain('openai:');
    expect(failed.errorMessage).not.toContain(KEYS.ANTHROPIC_API_KEY);
    expect((await listNotifications(ctx.db)).map((n) => n.kind)).toEqual(['failed']);

    // The providers recover; the owner presses Retry.
    down = false;
    const before = net.counts.anthropic;
    await retryJob(ctx.db, job.id);
    const done = await waitForJob(ctx.db, job.id, { until: (j) => j.state === 'completed' });
    expect(done.attempt).toBe(2);
    // Segment 1 was kept: only the remaining segments were asked for.
    expect(net.counts.anthropic - before).toBe(done.totalSegments - 1);
    const entries = parseSrt(output(done)).entries;
    expect(entries).toHaveLength(parseSrt(fixtureText('long-episode.srt')).entries.length);
  });

  it('asks again for a segment whose answer was cut off, instead of failing the job', async () => {
    await setup({ AI_FALLBACK_PROVIDER: '', AI_MAX_RETRIES: '0' });
    const net = network('sr-Latn', (host, n) =>
      n === 1
        ? anthropicStream({ text: '{"translations":[{"id":1,"text":"Pó', stopReason: 'max_tokens' })
        : 'ok',
    );
    const { job } = await submit(ctx);
    (await createWorker(ctx, net.factory)).start();
    const done = await waitForJob(ctx.db, job.id);
    // The truncated answer is never accepted; the segment is asked again and the job completes.
    expect(done.state).toBe('completed');
    expect(output(done)).not.toContain('{"translations"');
    expect(net.counts.anthropic).toBe(done.totalSegments + 1);
  });
});

describe('timing', () => {
  it('a slow provider never blocks other work in the worker process', async () => {
    await setup({ WORKER_CONCURRENCY: '2', AI_FALLBACK_PROVIDER: '' });
    let slow = true;
    const http = fakeHttp(async (call) => {
      const prompt = promptOf(call);
      if (slow && prompt.includes('Variant slow')) await sleepTimer(400);
      return answer(call, 'sr-Latn');
    });
    const factory = createDefaultTranslatorFactory({ fetch: http.fetch });
    const base = fixtureText('basic-movie.srt');
    const a = await submit(ctx, { srt: base.replace(/^(1\r?\n.*\r?\n)/, '$1Variant slow ') });
    const b = await submit(ctx, { srt: base, targetLanguage: 'hr' });
    (await createWorker(ctx, factory)).start();
    const fast = await waitForJob(ctx.db, b.job.id);
    const stillRunning = await waitForJob(ctx.db, a.job.id, { until: () => true });
    expect(fast.state).toBe('completed');
    expect(stillRunning.state).not.toBe('completed');
    slow = false;
    expect((await waitForJob(ctx.db, a.job.id)).state).toBe('completed');
  });
});
