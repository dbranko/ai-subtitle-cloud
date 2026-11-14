import { setTimeout as sleep } from 'node:timers/promises';
import {
  createProviderManagerFromConfig,
  ProviderConfigError,
  segmentationFromConfig,
  type AiProviderId,
  type ProviderEvent,
} from '@asc/ai-providers';
import { AI_PROVIDER_IDS, type AppConfig } from '@asc/config';
import type { Database, TranslationJob } from '@asc/database';
import type { Logger } from '@asc/shared';
import {
  assembleTranslation,
  createMockTranslator,
  MOCK_PROVIDER,
  prepareTranslation,
  translateSegment,
  TranslationCancelledError,
  type SegmentResult,
  type SegmentTranslator,
  type TranslationPlan,
  type TranslationProfileId,
} from '@asc/translation-engine';
import { describeFailure, JobStorageError, LostLockError } from './errors.js';
import { outputFileName, outputPath, readSource, writeFileAtomic } from './files.js';
import { hashSource } from './key.js';
import { estimateRemainingSeconds, type SegmentTiming } from './progress.js';
import {
  cancelOwnedJob,
  claimNextJob,
  completeJob,
  failJob,
  loadSegments,
  pruneEvents,
  recoverExpiredJobs,
  releaseJob,
  renewLeases,
  saveSegment,
  transitionJob,
  updateJob,
} from './store.js';

/** Receives provider-level events (retries, fallback) for the job being processed. */
export interface TranslatorHooks {
  onProviderEvent: (event: ProviderEvent) => void;
}

/** Builds the translator for one job. Injected so tests and mock mode need no real provider. */
export type TranslatorFactory = (job: TranslationJob, hooks: TranslatorHooks) => SegmentTranslator;

/** Production factory: the mock translator in mock mode, otherwise the configured providers. */
export function createDefaultTranslatorFactory(config: AppConfig): TranslatorFactory {
  return (job, hooks) => {
    if (job.provider === MOCK_PROVIDER) {
      if (!config.mockAi.enabled) {
        throw new ProviderConfigError(
          'This job was created in mock mode (MOCK_AI), which is now disabled.',
        );
      }
      return createMockTranslator({ delayMs: config.mockAi.delayMs });
    }
    if (!(AI_PROVIDER_IDS as readonly string[]).includes(job.provider)) {
      throw new ProviderConfigError(`Unknown AI provider "${job.provider}".`);
    }
    return createProviderManagerFromConfig(
      config,
      { provider: job.provider as AiProviderId, model: job.model },
      { onEvent: hooks.onProviderEvent },
    ).translator;
  };
}

export interface JobWorkerOptions {
  db: Database;
  config: AppConfig;
  /** Unique per process start; identifies this worker as the owner of a job's lock. */
  workerId: string;
  createTranslator: TranslatorFactory;
  logger?: Logger;
}

type StopReason = 'cancel' | 'shutdown' | 'lost' | 'crash';

interface RunningJob {
  job: TranslationJob;
  controller: AbortController;
  reason: StopReason | undefined;
  /** All writes for the job go through this chain, so they are applied strictly in order. */
  writes: Promise<unknown>;
  done: Promise<void>;
}

/**
 * The background worker.
 *
 * It owns nothing but a database connection: jobs, progress and locks live in
 * the database, so the worker can be stopped, killed or restarted at any time.
 *
 *  - claims queued jobs (atomic claim, one owner per job);
 *  - keeps its claims alive with a lease and notices when it lost one;
 *  - persists progress after every stage and every accepted segment;
 *  - notices cancellation requests and acknowledges them;
 *  - recovers jobs whose worker died, resuming from the last accepted segment.
 */
export class JobWorker {
  private readonly running = new Map<string, RunningJob>();
  private pollTimer: NodeJS.Timeout | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private started = false;
  private stopping = false;
  private polling: Promise<void> | undefined;
  private lastPrune = 0;

  constructor(private readonly options: JobWorkerOptions) {}

  get workerId(): string {
    return this.options.workerId;
  }

  /** Ids of the jobs this worker is processing right now. */
  get activeJobIds(): string[] {
    return [...this.running.keys()];
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    const { leaseMs } = this.options.config.worker;
    // Renew well inside the lease, and often enough that cancellation feels immediate.
    const watchMs = Math.max(50, Math.min(Math.floor(leaseMs / 3), 1000));
    this.watchTimer = setInterval(() => void this.watch(), watchMs);
    this.schedulePoll(0);
  }

  /**
   * Graceful stop: no new jobs are claimed, running jobs are interrupted and
   * handed back to the queue with their accepted segments, so another worker
   * (or this one after a restart) continues them immediately.
   */
  async stop(): Promise<void> {
    await this.halt('shutdown');
  }

  /**
   * Simulate a crash (tests only): everything stops at once and NOTHING is
   * written — locks stay in place exactly as after `kill -9`.
   */
  async kill(): Promise<void> {
    await this.halt('crash');
  }

  /** Resolves once this worker has no job in progress. */
  async idle(): Promise<void> {
    while (this.running.size > 0 || this.polling) {
      await Promise.all([...this.running.values()].map((r) => r.done));
      await this.polling;
    }
  }

  private async halt(reason: StopReason): Promise<void> {
    this.stopping = true;
    this.started = false;
    clearTimeout(this.pollTimer);
    clearInterval(this.watchTimer);
    for (const run of this.running.values()) {
      run.reason ??= reason;
      run.controller.abort();
    }
    await this.polling?.catch(() => undefined);
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  private schedulePoll(delayMs: number): void {
    if (this.stopping) return;
    clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.polling = this.poll()
        .catch((err: unknown) => this.options.logger?.error({ err }, 'job poll failed'))
        .finally(() => {
          this.polling = undefined;
          this.schedulePoll(this.options.config.worker.pollIntervalMs);
        });
    }, delayMs);
  }

  /** One scheduling pass: recover dead workers' jobs, then claim work up to the concurrency limit. */
  private async poll(): Promise<void> {
    const { db, config, workerId, logger } = this.options;
    const recovered = await recoverExpiredJobs(db, config.jobs.maxAttempts);
    if (recovered.requeued.length > 0 || recovered.failed.length > 0) {
      logger?.warn(recovered, 'recovered jobs of a stopped worker');
    }
    while (!this.stopping && this.running.size < config.worker.concurrency) {
      const job = await claimNextJob(db, workerId, config.worker.leaseMs);
      if (!job) break;
      this.startJob(job);
    }
    if (Date.now() - this.lastPrune > 10 * 60_000) {
      this.lastPrune = Date.now();
      await pruneEvents(db).catch(() => undefined);
    }
  }

  /** Keep leases alive; stop work on jobs that were cancelled or are no longer ours. */
  private async watch(): Promise<void> {
    if (this.running.size === 0) return;
    const { db, workerId, config, logger } = this.options;
    try {
      const held = new Map(
        (await renewLeases(db, workerId, config.worker.leaseMs)).map((h) => [h.id, h]),
      );
      for (const [id, run] of this.running) {
        if (run.reason) continue;
        const mine = held.get(id);
        if (!mine) {
          run.reason = 'lost';
          run.controller.abort();
        } else if (mine.cancelRequested) {
          run.reason = 'cancel';
          run.controller.abort();
        }
      }
    } catch (err) {
      logger?.error({ err }, 'lease renewal failed');
    }
  }

  private startJob(job: TranslationJob): void {
    const run: RunningJob = {
      job,
      controller: new AbortController(),
      reason: undefined,
      writes: Promise.resolve(),
      done: Promise.resolve(),
    };
    this.running.set(job.id, run);
    run.done = this.process(run)
      .catch((err: unknown) => this.settle(run, err))
      .catch((err: unknown) =>
        this.options.logger?.error({ err, jobId: job.id }, 'job settle failed'),
      )
      .finally(() => {
        this.running.delete(job.id);
        // Free capacity: look for the next job right away.
        if (!this.stopping) this.schedulePoll(0);
      });
  }

  /** Serialize a write for the job and keep the in-memory copy in sync with the stored row. */
  private write(
    run: RunningJob,
    fn: (job: TranslationJob) => Promise<TranslationJob>,
  ): Promise<TranslationJob> {
    const next = run.writes.then(async () => {
      if (run.reason === 'crash') throw new LostLockError(run.job.id);
      run.job = await fn(run.job);
      return run.job;
    });
    run.writes = next.catch(() => undefined);
    return next;
  }

  /** Stop here if the job was cancelled or taken away. Checked before every unit of work. */
  private async checkpoint(run: RunningJob): Promise<void> {
    if (!run.reason) {
      const fresh = await this.options.db.translationJob.findUnique({
        where: { id: run.job.id },
        select: { lockedBy: true, cancelRequested: true },
      });
      if (!fresh || fresh.lockedBy !== this.workerId) run.reason = 'lost';
      else if (fresh.cancelRequested) run.reason = 'cancel';
    }
    if (run.reason) {
      run.controller.abort();
      throw new TranslationCancelledError();
    }
  }

  private async process(run: RunningJob): Promise<void> {
    const { db, config, workerId } = this.options;
    const to = (state: Parameters<typeof transitionJob>[3], patch = {}) =>
      this.write(run, (job) => transitionJob(db, job, workerId, state, patch));
    const signal = run.controller.signal;

    // 1. Source discovery. An uploaded source needs no search; Phase 4 adds real discovery here.
    await this.checkpoint(run);
    await to('locating_source', { statusDetail: null });

    // 2. Download: read the stored source and make sure it is the subtitle the job was created for.
    await to('downloading_source');
    const srt = await readSource(config, run.job.sourceFile);

    // 3. Parsing.
    await to('parsing');
    const plan = prepareTranslation(
      {
        srt,
        targetLanguage: run.job.targetLanguage,
        profile: run.job.profile as TranslationProfileId,
        ...(run.job.sourceLanguage ? { sourceLanguage: run.job.sourceLanguage } : {}),
        ...(run.job.customInstructions ? { customInstructions: run.job.customInstructions } : {}),
        mediaContext: {
          title: run.job.mediaTitle,
          ...(run.job.mediaType === 'movie' || run.job.mediaType === 'series'
            ? { type: run.job.mediaType }
            : {}),
          ...(run.job.season !== null ? { season: run.job.season } : {}),
          ...(run.job.episode !== null ? { episode: run.job.episode } : {}),
        },
      },
      segmentationFromConfig(config),
    );
    if (hashSource(plan.entries) !== run.job.sourceHash) {
      throw new JobStorageError('source_changed', 'The stored source subtitle has changed.');
    }

    // 4. Context preparation: the segment plan, plus segments accepted in an earlier run.
    const results = await this.resumableSegments(run.job.id, plan);
    const accepted = new Map<number, string>();
    for (const r of results.values()) for (const t of r.translations) accepted.set(t.id, t.text);
    await to('preparing_context', {
      totalEntries: plan.entries.length,
      totalSegments: plan.segments.length,
      completedSegments: results.size,
      completedEntries: accepted.size,
      etaSeconds: null,
    });

    // 5. Translation, one segment at a time. Progress moves only when a segment is stored.
    await to('translating');
    const translator = this.options.createTranslator(run.job, {
      onProviderEvent: (event) => this.onProviderEvent(run, event),
    });
    const timings: SegmentTiming[] = [];
    for (const segment of plan.segments) {
      if (results.has(segment.index)) continue;
      await this.checkpoint(run);
      await this.write(run, (job) =>
        updateJob(db, job, workerId, { currentSegment: segment.index + 1 }),
      );

      const startedAt = Date.now();
      const result = await translateSegment(plan, segment.index, accepted, translator, {
        signal,
        maxAttempts: config.jobs.segmentMaxAttempts,
        onAttemptFailed: async (failure) => {
          if (!failure.willRetry) return;
          const why = failure.issues[0]?.message ?? 'invalid answer';
          await this.write(run, (job) =>
            updateJob(db, job, workerId, {
              retryCount: job.retryCount + 1,
              statusDetail: `Segment ${segment.index + 1}: answer rejected (${why}) — retrying`,
            }),
          );
        },
      });
      // A cancellation that arrived during the request wins: the segment is not stored.
      await this.checkpoint(run);

      const wallMs = Date.now() - startedAt;
      timings.push({ entries: result.translations.length, durationMs: wallMs });
      const remaining = plan.entries.length - accepted.size - result.translations.length;
      await this.write(run, (job) =>
        saveSegment(db, job, workerId, {
          result,
          wallMs,
          etaSeconds: estimateRemainingSeconds(timings, remaining),
        }),
      );
      results.set(segment.index, result);
      for (const t of result.translations) accepted.set(t.id, t.text);
    }

    // 6. Validation of the whole subtitle.
    await this.checkpoint(run);
    await to('validating', { currentSegment: null, etaSeconds: null, statusDetail: null });
    const translation = assembleTranslation(plan, [...results.values()]);

    // 7. Saving. The job is completed (100%) only after the file is on disk.
    await this.checkpoint(run);
    await to('saving');
    const outputFile = outputFileName(run.job.id, run.job.targetLanguage);
    try {
      await writeFileAtomic(outputPath(config, outputFile), translation.srt);
    } catch (err) {
      throw new JobStorageError('save_failed', 'The translated subtitle could not be saved.', {
        cause: err,
      });
    }
    await this.write(run, (job) =>
      completeJob(db, job, workerId, { outputFile, usedModels: translation.metadata.models }),
    );
    this.options.logger?.info({ jobId: run.job.id }, 'job completed');
  }

  /** Segments accepted earlier that still fit the current plan; anything else is discarded. */
  private async resumableSegments(
    jobId: string,
    plan: TranslationPlan,
  ): Promise<Map<number, SegmentResult>> {
    const { db } = this.options;
    const saved = await loadSegments(db, jobId);
    const fits = (r: SegmentResult) => {
      const segment = plan.segments[r.segmentIndex];
      return (
        segment !== undefined &&
        r.translations.length === segment.end - segment.start &&
        r.translations.every((t, i) => t.id === segment.start + i + 1)
      );
    };
    if (saved.every(fits)) return new Map(saved.map((r) => [r.segmentIndex, r]));
    // The plan changed (e.g. a different segment size was configured): start the segments over.
    await db.jobSegment.deleteMany({ where: { jobId } });
    return new Map();
  }

  /** Make provider retries and fallbacks visible on the job. Never blocks the translation. */
  private onProviderEvent(run: RunningJob, event: ProviderEvent): void {
    const { db, workerId } = this.options;
    let note: string | undefined;
    let retried = false;
    if (event.type === 'attempt_failed' && event.retryInMs !== undefined) {
      retried = true;
      const seconds = Math.max(1, Math.round(event.retryInMs / 1000));
      note = `${event.provider}: ${event.kind.replace('_', ' ')} — retrying in ${seconds}s`;
    } else if (event.type === 'fallback') {
      note = `${event.from.provider} failed (${event.reason.replace('_', ' ')}) — using ${event.to.provider} / ${event.to.model}`;
    }
    if (note === undefined) return;
    const statusDetail = note;
    void this.write(run, (job) =>
      updateJob(db, job, workerId, {
        statusDetail,
        ...(retried ? { retryCount: job.retryCount + 1 } : {}),
      }),
    ).catch(() => undefined);
  }

  /** Decide how a job that stopped ends: cancelled, released, lost or failed. */
  private async settle(run: RunningJob, error: unknown): Promise<void> {
    const { db, workerId, logger } = this.options;
    await run.writes;
    const jobId = run.job.id;
    if (run.reason === 'crash') return;
    if (run.reason === 'lost' || error instanceof LostLockError) {
      logger?.warn({ jobId }, 'job is no longer owned by this worker; stopping');
      return;
    }
    try {
      if (run.reason === 'cancel') {
        await cancelOwnedJob(db, run.job, workerId);
        logger?.info({ jobId }, 'job cancelled');
      } else if (run.reason === 'shutdown') {
        await releaseJob(db, run.job, workerId);
        logger?.info({ jobId }, 'job released for another worker');
      } else {
        const failure = describeFailure(error);
        await failJob(db, run.job, workerId, failure);
        logger?.error({ jobId, code: failure.code, message: failure.message }, 'job failed');
      }
    } catch (err) {
      if (err instanceof LostLockError) return;
      throw err;
    }
  }
}

/** Wait until a job reaches a terminal state (tests and scripts). */
export async function waitForJob(
  db: Database,
  jobId: string,
  options: { timeoutMs?: number; until?: (job: TranslationJob) => boolean } = {},
): Promise<TranslationJob> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const done = options.until ?? ((job) => ['completed', 'failed', 'cancelled'].includes(job.state));
  for (;;) {
    const job = await db.translationJob.findUnique({ where: { id: jobId } });
    if (job && done(job)) return job;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for job ${jobId} (state: ${job?.state ?? 'missing'}).`);
    }
    await sleep(20);
  }
}
