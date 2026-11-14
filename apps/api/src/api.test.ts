import { mkdtempSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureStorageDirs, loadConfig, type AppConfig } from '@asc/config';
import { createTestDatabase, type TestDatabase } from '@asc/database';
import {
  JobWorker,
  sourcePath,
  waitForJob,
  type JobView,
  type NotificationView,
  type Snapshot,
} from '@asc/jobs';
import { createLogger } from '@asc/shared';
import { createMockTranslator, type MockTranslatorOptions } from '@asc/translation-engine';
import { buildApp } from './app.js';

const FIXTURES = new URL('../../../fixtures/subtitles/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, FIXTURES));
const LONG = fixture('long-episode.srt').toString('base64');

let t: TestDatabase;
let config: AppConfig;
let app: FastifyInstance;
let worker: JobWorker | undefined;

async function start(env: Record<string, string> = {}): Promise<void> {
  t = await createTestDatabase();
  config = loadConfig({
    env: {
      NODE_ENV: 'test',
      MOCK_AI: 'true',
      WORKER_POLL_INTERVAL_MS: '50',
      WORKER_LEASE_MS: '500',
      ...env,
    },
    rootDir: mkdtempSync(join(tmpdir(), 'asc-api-')),
    useEnvFile: false,
  });
  ensureStorageDirs(config);
  app = await buildApp({
    config,
    db: t.db,
    dashboardDir: null,
    events: { pollIntervalMs: 20, heartbeatIntervalMs: 100, retryMs: 50 },
  });
}

function startWorker(options: MockTranslatorOptions = {}): JobWorker {
  worker = new JobWorker({
    db: t.db,
    config,
    workerId: `api-test-worker-${Math.random().toString(36).slice(2)}`,
    createTranslator: () => createMockTranslator(options),
    logger: createLogger('worker', 'silent'),
  });
  worker.start();
  return worker;
}

beforeEach(() => start());
afterEach(async () => {
  await worker?.kill();
  worker = undefined;
  await app.close();
  await t.cleanup();
});

const post = (
  url: string,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {},
) =>
  app.inject(
    payload === undefined
      ? { method: 'POST', url, headers }
      : { method: 'POST', url, headers, payload },
  );
const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });
const submit = (overrides: Record<string, unknown> = {}) =>
  post('/api/v1/jobs', {
    contentBase64: LONG,
    fileName: 'long-episode.srt',
    targetLanguage: 'sr-Latn',
    ...overrides,
  });

describe('POST /api/v1/jobs', () => {
  it('creates a job and returns at once, without translating in the request', async () => {
    const started = Date.now();
    const res = await submit({ title: 'Harbor Lights' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.statusCode).toBe(201);
    const body = res.json<{ job: JobView; created: boolean; reason: string }>();
    expect(body).toMatchObject({ created: true, reason: 'created' });
    expect(body.job).toMatchObject({
      state: 'queued',
      percentage: 0,
      mediaTitle: 'Harbor Lights',
      sourceName: 'long-episode.srt',
      targetLanguage: 'sr-Latn',
      targetScript: 'Latn',
      profile: 'natural',
      provider: 'mock',
      totalEntries: 130,
      completedSegments: 0,
      hasOutput: false,
      error: null,
    });
  });

  it('returns the existing job for a duplicate request', async () => {
    const first = (await submit()).json<{ job: JobView }>();
    const second = await submit();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({
      created: false,
      reason: 'active',
      job: { id: first.job.id },
    });
    const list = (await get('/api/v1/jobs?scope=active')).json<{ jobs: JobView[] }>();
    expect(list.jobs).toHaveLength(1);
  });

  it('decodes legacy-encoded uploads using the source language', async () => {
    const res = await submit({
      contentBase64: fixture('legacy-cp1250.srt').toString('base64'),
      fileName: 'film.srt',
      sourceLanguage: 'hr',
      targetLanguage: 'en',
    });
    expect(res.statusCode).toBe(201);
    const { job } = res.json<{ job: JobView }>();
    expect(job).toMatchObject({ mediaTitle: 'film', sourceLanguage: 'hr', totalEntries: 2 });
    const row = await t.db.translationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(readFileSync(sourcePath(config, row.sourceFile ?? ''), 'utf8')).toContain(
      'Što se događa, Željko?',
    );
  });

  it('accepts already-decoded text as well', async () => {
    const res = await post('/api/v1/jobs', {
      srt: '1\n00:00:01,000 --> 00:00:02,000\nHello\n',
      targetLanguage: 'hr',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ job: JobView }>().job.mediaTitle).toBe('Untitled subtitle');
  });

  it.each([
    [
      'not a subtitle',
      { contentBase64: Buffer.from('<html>status</html>').toString('base64') },
      'source_invalid',
    ],
    ['no content', { contentBase64: undefined }, 'source_invalid'],
    ['Bosnian target', { targetLanguage: 'bs' }, 'unsupported_language'],
    ['bare Serbian', { targetLanguage: 'sr' }, 'unsupported_language'],
    ['unknown profile', { profile: 'poetic' }, 'invalid_request'],
    ['custom profile without instructions', { profile: 'custom' }, 'invalid_request'],
    ['missing target', { targetLanguage: undefined }, 'invalid_request'],
    ['unknown provider', { provider: 'skynet' }, 'invalid_request'],
  ])('rejects %s with HTTP 400', async (_name, overrides, code) => {
    const res = await submit(overrides);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string; message: string }>().error).toBe(code);
    expect(await t.db.translationJob.count()).toBe(0);
  });

  it('rejects an upload above the size limit', async () => {
    await app.close();
    await t.cleanup();
    await start({ MAX_UPLOAD_BYTES: '2048' });
    const res = await submit();
    expect([400, 413]).toContain(res.statusCode);
    expect(res.json<{ error: string }>().error).toBe('too_large');
  });

  it('refuses a real provider that has no API key', async () => {
    await app.close();
    await t.cleanup();
    await start({ MOCK_AI: 'false' });
    const res = await submit();
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'provider_not_configured' });
  });
});

describe('job endpoints', () => {
  it('lists and returns jobs', async () => {
    const { job } = (await submit()).json<{ job: JobView }>();
    expect((await get(`/api/v1/jobs/${job.id}`)).json<{ job: JobView }>().job.id).toBe(job.id);
    expect((await get('/api/v1/jobs')).json<{ jobs: JobView[] }>().jobs.map((j) => j.id)).toEqual([
      job.id,
    ]);
    expect((await get('/api/v1/jobs?scope=finished')).json<{ jobs: JobView[] }>().jobs).toEqual([]);
    expect((await get('/api/v1/jobs/unknown')).statusCode).toBe(404);
    expect((await get('/api/v1/jobs?scope=nope')).statusCode).toBe(400);
  });

  it('never exposes internal fields', async () => {
    await submit();
    const text = (await get('/api/v1/jobs')).body;
    for (const field of [
      'lockedBy',
      'leaseExpiresAt',
      'sourceFile',
      'translationKey',
      'activeKey',
      'sourceHash',
    ]) {
      expect(text).not.toContain(field);
    }
  });

  it('runs a job to completion and serves the translated subtitle', async () => {
    const { job } = (await submit({ title: 'Harbor Lights' })).json<{ job: JobView }>();
    const early = await get(`/api/v1/jobs/${job.id}/download`);
    expect(early.statusCode).toBe(409);

    startWorker();
    await waitForJob(t.db, job.id);
    const done = (await get(`/api/v1/jobs/${job.id}`)).json<{ job: JobView }>().job;
    expect(done).toMatchObject({
      state: 'completed',
      percentage: 100,
      hasOutput: true,
      completedEntries: 130,
    });
    expect(done.elapsedSeconds).toBeGreaterThanOrEqual(0);

    const file = await get(`/api/v1/jobs/${job.id}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/x-subrip; charset=utf-8');
    expect(file.headers['content-disposition']).toContain(
      "filename*=UTF-8''Harbor%20Lights.sr-Latn.srt",
    );
    expect(file.body.startsWith('1\n00:00:20,000 --> ')).toBe(true);
    expect(file.body.match(/-->/g)).toHaveLength(130);
  });

  it('cancels a job and refuses to cancel it twice', async () => {
    const { job } = (await submit()).json<{ job: JobView }>();
    const res = await post(`/api/v1/jobs/${job.id}/cancel`);
    expect(res.statusCode).toBe(200);
    expect(res.json<{ job: JobView }>().job.state).toBe('cancelled');
    expect((await post(`/api/v1/jobs/${job.id}/cancel`)).statusCode).toBe(409);
    expect((await post('/api/v1/jobs/unknown/cancel')).statusCode).toBe(404);
  });

  it('retries only failed jobs', async () => {
    const { job } = (await submit()).json<{ job: JobView }>();
    expect((await post(`/api/v1/jobs/${job.id}/retry`)).statusCode).toBe(409);

    const failing = startWorker({ fault: () => 'error' });
    await waitForJob(t.db, job.id);
    await failing.kill();
    const failed = (await get(`/api/v1/jobs/${job.id}`)).json<{ job: JobView }>().job;
    expect(failed).toMatchObject({
      state: 'failed',
      error: { code: 'internal_error', message: 'Mock provider failure', stage: 'translating' },
    });

    const retried = await post(`/api/v1/jobs/${job.id}/retry`);
    expect(retried.statusCode).toBe(200);
    expect(retried.json<{ job: JobView }>().job).toMatchObject({
      state: 'queued',
      attempt: 2,
      error: null,
    });
    startWorker();
    expect((await waitForJob(t.db, job.id)).state).toBe('completed');
  });
});

describe('notifications and metadata', () => {
  it('lists notifications and marks them read', async () => {
    const { job } = (await submit()).json<{ job: JobView }>();
    startWorker();
    await waitForJob(t.db, job.id);

    const unread = (await get('/api/v1/notifications?unread=true')).json<{
      notifications: NotificationView[];
    }>();
    expect(unread.notifications).toHaveLength(1);
    expect(unread.notifications[0]).toMatchObject({
      kind: 'completed',
      jobId: job.id,
      read: false,
    });

    const id = unread.notifications[0]!.id;
    const read = await post(`/api/v1/notifications/${id}/read`);
    expect(read.json<{ notification: NotificationView }>().notification.read).toBe(true);
    expect(
      (await get('/api/v1/notifications?unread=true')).json<{ notifications: unknown[] }>()
        .notifications,
    ).toEqual([]);
    expect(
      (await get('/api/v1/notifications')).json<{ notifications: unknown[] }>().notifications,
    ).toHaveLength(1);
    expect((await post('/api/v1/notifications/unknown/read')).statusCode).toBe(404);
    expect((await post('/api/v1/notifications/read-all')).json()).toEqual({ marked: 0 });
  });

  it('describes languages, profiles and providers without leaking keys', async () => {
    await app.close();
    await t.cleanup();
    await start({
      ANTHROPIC_API_KEY: 'sk-ant-very-secret-value',
      OPENAI_API_KEY: 'sk-openai-very-secret',
    });
    const res = await get('/api/v1/meta');
    expect(res.body).not.toContain('very-secret');
    const meta = res.json<{
      targetLanguages: { id: string }[];
      sourceLanguages: { id: string }[];
      profiles: { id: string }[];
      providers: { id: string; configured: boolean }[];
      mockAi: boolean;
    }>();
    const targets = meta.targetLanguages.map((l) => l.id);
    expect(targets).toEqual(expect.arrayContaining(['sr-Latn', 'sr-Cyrl', 'hr', 'en']));
    expect(targets).not.toContain('bs');
    expect(targets).not.toContain('cnr');
    expect(meta.sourceLanguages.map((l) => l.id)).toContain('bs');
    expect(meta.profiles.map((p) => p.id)).toEqual([
      'natural',
      'literal',
      'cinematic',
      'concise',
      'custom',
    ]);
    expect(meta.providers.map((p) => [p.id, p.configured])).toEqual([
      ['anthropic', true],
      ['openai', true],
      ['gemini', false],
    ]);
    expect(meta.mockAi).toBe(true);
  });
});

describe('authentication', () => {
  const TOKEN = 'a-long-enough-test-token-0123456789';

  beforeEach(async () => {
    await app.close();
    await t.cleanup();
    await start({ AUTH_TOKEN: TOKEN });
  });

  it('protects every API route once a token is configured', async () => {
    for (const url of ['/api/v1/jobs', '/api/v1/meta', '/api/v1/notifications', '/api/v1/events']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthorized' });
    }
    expect((await submit()).statusCode).toBe(401);
    expect(
      (await get('/api/v1/jobs', { authorization: 'Bearer wrong-token-wrong-token-wrong' }))
        .statusCode,
    ).toBe(401);
    expect((await get('/api/v1/jobs?token=nope')).statusCode).toBe(401);
  });

  it('accepts the token as a bearer header or a query parameter', async () => {
    expect((await get('/api/v1/jobs', { authorization: `Bearer ${TOKEN}` })).statusCode).toBe(200);
    expect((await get(`/api/v1/jobs?token=${TOKEN}`)).statusCode).toBe(200);
    const created = await post(
      '/api/v1/jobs',
      { contentBase64: LONG, targetLanguage: 'hr' },
      { authorization: `Bearer ${TOKEN}` },
    );
    expect(created.statusCode).toBe(201);
  });

  it('leaves health checks open', async () => {
    expect((await get('/health')).statusCode).toBe(200);
    expect((await get('/health/ready')).statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Server-Sent Events over a real HTTP connection
// ---------------------------------------------------------------------------

interface StreamEvent {
  id: number;
  event: string;
  data: unknown;
}

interface Stream {
  events: StreamEvent[];
  comments: number;
  retry: number | undefined;
  status: number;
  contentType: string | null;
  close: () => void;
  waitFor: (predicate: (e: StreamEvent) => boolean, timeoutMs?: number) => Promise<StreamEvent>;
}

/** Minimal EventSource: connects, parses the SSE wire format, collects events. */
async function openStream(baseUrl: string, lastEventId?: number): Promise<Stream> {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/v1/events`, {
    signal: controller.signal,
    headers: lastEventId === undefined ? {} : { 'last-event-id': String(lastEventId) },
  });
  const stream: Stream = {
    events: [],
    comments: 0,
    retry: undefined,
    status: response.status,
    contentType: response.headers.get('content-type'),
    close: () => controller.abort(),
    waitFor: async (predicate, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = stream.events.find(predicate);
        if (found) return found;
        if (Date.now() > deadline) throw new Error('Timed out waiting for an SSE event.');
        await sleep(10);
      }
    },
  };
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (block.startsWith(':')) {
            stream.comments++;
            continue;
          }
          const field = (name: string) =>
            block
              .split('\n')
              .find((l) => l.startsWith(`${name}: `))
              ?.slice(name.length + 2);
          const retry = field('retry');
          if (retry !== undefined) stream.retry = Number(retry);
          const data = field('data');
          if (data !== undefined) {
            stream.events.push({
              id: Number(field('id')),
              event: field('event') ?? 'message',
              data: JSON.parse(data),
            });
          }
        }
      }
    } catch {
      // aborted by close()
    }
  })();
  return stream;
}

describe('TEST J — real-time updates over SSE', () => {
  let baseUrl: string;
  const streams: Stream[] = [];
  const open = async (lastEventId?: number) => {
    const s = await openStream(baseUrl, lastEventId);
    streams.push(s);
    return s;
  };
  const jobOf = (e: StreamEvent) => e.data as JobView;

  beforeEach(async () => {
    await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  afterEach(() => {
    for (const s of streams.splice(0)) s.close();
  });

  it('sends a snapshot first, then every change as it happens', async () => {
    const stream = await open();
    expect(stream.status).toBe(200);
    expect(stream.contentType).toContain('text/event-stream');

    const first = await stream.waitFor(() => true);
    expect(first.event).toBe('snapshot');
    expect(first.data).toMatchObject({ jobs: [], notifications: [], lastEventId: 0 });
    expect(stream.retry).toBe(50);

    const { job } = (await submit()).json<{ job: JobView }>();
    startWorker({ delayMs: 15 });
    await stream.waitFor((e) => e.event === 'job.completed');
    await stream.waitFor((e) => e.event === 'notification.created');

    const live = stream.events.slice(1);
    expect(live[0]).toMatchObject({ event: 'job.created', data: { id: job.id, state: 'queued' } });
    // Event ids are strictly increasing: nothing duplicated, nothing out of order.
    const ids = live.map((e) => e.id);
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
    // Progress arrived segment by segment, not as one jump at the end.
    const progress = live
      .filter((e) => e.event === 'job.updated')
      .map((e) => jobOf(e).completedSegments);
    const total = jobOf(live.find((e) => e.event === 'job.completed')!).totalSegments;
    expect([...new Set(progress)]).toEqual(Array.from({ length: total + 1 }, (_, i) => i));
    const percentages = live
      .filter((e) => e.event.startsWith('job.'))
      .map((e) => jobOf(e).percentage);
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    expect(percentages[percentages.length - 1]).toBe(100);
    expect(live.find((e) => e.event === 'notification.created')?.data).toMatchObject({
      kind: 'completed',
      jobId: job.id,
    });
  });

  it('restores the current state after a reconnect, without losing or repeating anything', async () => {
    const { job } = (await submit()).json<{ job: JobView }>();
    startWorker({ delayMs: 60 });

    const first = await open();
    const seen = await first.waitFor(
      (e) => e.event === 'job.updated' && jobOf(e).completedSegments >= 1,
    );
    const lastSeenId = first.events[first.events.length - 1]!.id;
    first.close(); // connection drops mid-translation

    // The job keeps running while nobody is connected.
    await waitForJob(t.db, job.id, {
      until: (j) => j.completedSegments > jobOf(seen).completedSegments,
    });

    // The browser reconnects by itself and sends the last id it saw.
    const second = await open(lastSeenId);
    const snapshot = (await second.waitFor((e) => e.event === 'snapshot')).data as Snapshot;
    const restored = snapshot.jobs.find((j) => j.id === job.id)!;
    expect(restored.id).toBe(job.id);
    expect(restored.completedSegments).toBeGreaterThan(jobOf(seen).completedSegments);
    expect(restored.percentage).toBeGreaterThan(jobOf(seen).percentage);
    expect(snapshot.lastEventId).toBeGreaterThan(lastSeenId);

    // Live updates continue from exactly where the snapshot ends.
    await second.waitFor((e) => e.event === 'job.completed');
    const live = second.events.filter((e) => e.event !== 'snapshot');
    expect(live.every((e) => e.id > snapshot.lastEventId)).toBe(true);
    const ids = live.map((e) => e.id);
    expect(ids).toEqual([...new Set(ids)].sort((a, b) => a - b));
    // Together, snapshot + live events show uninterrupted, monotonic progress to 100%.
    const percentages = [
      restored.percentage,
      ...live.filter((e) => e.event.startsWith('job.')).map((e) => jobOf(e).percentage),
    ];
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));
    expect(percentages[percentages.length - 1]).toBe(100);
  });

  it('shows a browser that connects after everything finished the result and the unread notification', async () => {
    const { job } = (await submit()).json<{ job: JobView }>();
    startWorker();
    await waitForJob(t.db, job.id); // no client was connected during the whole translation

    const late = await open();
    const snapshot = (await late.waitFor((e) => e.event === 'snapshot')).data as Snapshot;
    expect(snapshot.jobs).toHaveLength(1);
    expect(snapshot.jobs[0]).toMatchObject({
      id: job.id,
      state: 'completed',
      percentage: 100,
      hasOutput: true,
    });
    expect(snapshot.notifications).toHaveLength(1);
    expect(snapshot.notifications[0]).toMatchObject({ kind: 'completed', read: false });
  });

  it('delivers the same events to every connected client', async () => {
    const a = await open();
    const b = await open();
    await submit();
    startWorker({ delayMs: 10 });
    await a.waitFor((e) => e.event === 'notification.created');
    await b.waitFor((e) => e.event === 'notification.created');
    const key = (s: Stream) =>
      s.events.filter((e) => e.event !== 'snapshot').map((e) => `${e.id}:${e.event}`);
    expect(key(a)).toEqual(key(b));
    expect(key(a).length).toBeGreaterThan(5);
  });

  it('keeps idle connections open with heartbeats and cleans up when clients leave', async () => {
    const stream = await open();
    await stream.waitFor((e) => e.event === 'snapshot');
    await sleep(350);
    expect(stream.comments).toBeGreaterThanOrEqual(2);
    stream.close();
    await sleep(100);
    // A cancel request made afterwards still works: nothing depended on the connection.
    const { job } = (await submit()).json<{ job: JobView }>();
    expect((await post(`/api/v1/jobs/${job.id}/cancel`)).statusCode).toBe(200);
  });
});
