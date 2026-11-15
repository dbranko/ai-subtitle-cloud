import { rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  createProviderManagerFromConfig,
  ProviderConfigError,
  segmentationFromConfig,
  type AiProviderId,
  type ManagerDeps,
  type ProviderEvent,
} from '@asc/ai-providers';
import { AI_PROVIDER_IDS, type AppConfig } from '@asc/config';
import type { Database, TranslationJob } from '@asc/database';
import type { Logger } from '@asc/shared';
import {
  rankCandidates,
  resolveContentLanguage,
  SourceError,
  validateSourceBytes,
  type RankedCandidate,
  type SourceCandidate,
  type SubtitleSource,
} from '@asc/subtitle-sources';
import {
  assembleTranslation,
  createMockTranslator,
  findLanguage,
  MOCK_PROVIDER,
  prepareTranslation,
  translateSegment,
  TranslationCancelledError,
  type SegmentResult,
  type SegmentTranslator,
  type TranslationPlan,
  type TranslationProfileId,
} from '@asc/translation-engine';
import {
  DeferJobError,
  describeFailure,
  JobSourceError,
  JobStorageError,
  LostLockError,
} from './errors.js';
import { outputFileName, outputPath, readSource, writeFileAtomic } from './files.js';
import { computeTranslationKey, hashSource, isProvisionalKey } from './key.js';
import {
  cleanupCache,
  createLibrarySource,
  createSourcesFromConfig,
  findCachedTranslation,
  storeSource,
} from './library.js';
import { estimateRemainingSeconds, type SegmentTiming } from './progress.js';
import type { SettingsProvider } from './settings.js';
import {
  adoptTranslationKey,
  cancelOwnedJob,
  claimNextJob,
  completeJob,
  deferJob,
  failJob,
  loadSegments,
  pruneEvents,
  recordJobSource,
  recoverExpiredJobs,
  releaseJob,
  renewLeases,
  saveSegment,
  transitionJob,
  updateJob,
  type StoredMediaQuery,
} from './store.js';

/** Receives provider-level events (retries, fallback) for the job being processed. */
export interface TranslatorHooks {
  onProviderEvent: (event: ProviderEvent) => void;
}

/**
 * Builds the translator for one job. Injected so tests and mock mode need no
 * real provider. `config` is the configuration in effect when the job starts
 * (environment plus dashboard settings).
 */
export type TranslatorFactory = (
  job: TranslationJob,
  hooks: TranslatorHooks,
  config: AppConfig,
) => SegmentTranslator;

/**
 * Production factory: the mock translator in mock mode, otherwise the configured providers.
 * `deps` is a test seam (an HTTP transport for the provider SDKs, a fake clock for retries).
 */
export function createDefaultTranslatorFactory(
  deps: Pick<ManagerDeps, 'fetch' | 'sleep' | 'pricing'> = {},
): TranslatorFactory {
  return (job, hooks, config) => {
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
      { ...deps, onEvent: hooks.onProviderEvent },
    ).translator;
  };
}

export interface JobWorkerOptions {
  db: Database;
  config: AppConfig;
  /** Unique per process start; identifies this worker as the owner of a job's lock. */
  workerId: string;
  createTranslator: TranslatorFactory;
  /** Dashboard settings. When given, each job runs with the settings in effect as it starts. */
  settings?: SettingsProvider;
  /** Remote subtitle sources. Default: those configured (OpenSubtitles when it has an API key). */
  sources?: SubtitleSource[];
  logger?: Logger;
}

/** How many of the best candidates are tried before a media request gives up. */
const MAX_SOURCE_CANDIDATES = 3;
/** A downloaded file with fewer cues than this is not a real subtitle. */
const MIN_SOURCE_ENTRIES = 3;
const CACHE_CLEANUP_INTERVAL_MS = 60 * 60_000;

type StopReason = 'cancel' | 'shutdown' | 'lost' | 'crash';

interface RunningJob {
  job: TranslationJob;
  /** Configuration in effect for this run. */
  config: AppConfig;
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
  private lastCleanup = 0;

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
    const current = await this.effectiveConfig();
    const limited = current.cache.maxAgeDays > 0 || current.cache.maxSizeMb > 0;
    if (limited && Date.now() - this.lastCleanup > CACHE_CLEANUP_INTERVAL_MS) {
      this.lastCleanup = Date.now();
      const removed = await cleanupCache(db, current).catch(() => undefined);
      if (removed && removed.translationsRemoved > 0) logger?.info(removed, 'cache cleaned up');
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
      config: this.options.config,
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

  private async effectiveConfig(): Promise<AppConfig> {
    return this.options.settings ? this.options.settings.config() : this.options.config;
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
    const { db, workerId } = this.options;
    // Settings saved in the dashboard apply to the next job, not to one that is running.
    run.config = await this.effectiveConfig();
    const config = run.config;
    const to = (state: Parameters<typeof transitionJob>[3], patch = {}) =>
      this.write(run, (job) => transitionJob(db, job, workerId, state, patch));
    const signal = run.controller.signal;

    // 1. Source discovery. An uploaded source is already known; a media request searches for one.
    await this.checkpoint(run);
    await to('locating_source', { statusDetail: null });
    const candidates = run.job.sourceId ? [] : await this.locateSources(run);

    // 2. Download: fetch and validate the source (media requests), then read it from the library.
    await this.checkpoint(run);
    await to('downloading_source');
    if (!run.job.sourceId) await this.acquireSource(run, candidates);
    if (isProvisionalKey(run.job.translationKey)) {
      // From here on the job is identified by the subtitle's content, like an upload.
      const key = computeTranslationKey({
        sourceHash: run.job.sourceHash ?? '',
        targetLanguage: run.job.targetLanguage,
        targetScript: run.job.targetScript,
        profile: run.job.profile,
        customInstructions: run.job.customInstructions ?? undefined,
      });
      await this.write(run, (job) => adoptTranslationKey(db, job, workerId, key));
    }
    if (!run.job.sourceFile) {
      throw new JobStorageError('source_missing', 'The job has no source subtitle.');
    }
    const srt = await readSource(config, run.job.sourceFile);

    // Translation cache: an identical finished translation is reused; no AI request is made.
    if (!run.job.force) {
      const cached = await findCachedTranslation(db, config, run.job.translationKey);
      if (cached) {
        await to('parsing', { statusDetail: 'Reusing an existing translation' });
        await to('preparing_context', {
          totalEntries: cached.entries,
          completedEntries: cached.entries,
        });
        await to('translating');
        await to('validating');
        await to('saving');
        await this.write(run, async (job) => {
          const done = await completeJob(db, config, job, workerId, {
            outputFile: cached.file,
            usedModels: JSON.parse(cached.models) as { provider: string; model: string }[],
            cacheHit: true,
          });
          return done.job;
        });
        this.options.logger?.info({ jobId: run.job.id }, 'job completed from cache');
        return;
      }
    }

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
    const translator = this.options.createTranslator(
      run.job,
      { onProviderEvent: (event) => this.onProviderEvent(run, event) },
      config,
    );
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
    let replaced: string | null = null;
    await this.write(run, async (job) => {
      const done = await completeJob(db, config, job, workerId, {
        outputFile,
        usedModels: translation.metadata.models,
        entries: translation.entries.length,
        validation: translation.validation,
        stats: translation.stats,
      });
      replaced = done.replacedFile;
      return done.job;
    });
    // A forced re-translation replaced an older cached file: remove the old one.
    if (replaced) await rm(outputPath(config, replaced), { force: true }).catch(() => undefined);
    this.options.logger?.info({ jobId: run.job.id }, 'job completed');
  }

  /** The remote sources plus the owner's own uploads, which are always searched first. */
  private sources(config: AppConfig): SubtitleSource[] {
    const { db } = this.options;
    return [
      createLibrarySource(db, config),
      ...(this.options.sources ?? createSourcesFromConfig(config)),
    ];
  }

  /** Search every source for the job's media and rank what was found, best first. */
  private async locateSources(run: RunningJob): Promise<RankedCandidate[]> {
    const { db, workerId } = this.options;
    const stored = JSON.parse(run.job.mediaQuery ?? 'null') as StoredMediaQuery | null;
    if (!stored)
      throw new JobSourceError(
        'source_not_found',
        'The job has no source subtitle and no media to search for.',
      );
    const signal = run.controller.signal;

    let found: SourceCandidate[] = [];
    let lastError: unknown;
    if (stored.pinned) {
      found = [stored.pinned];
    } else {
      for (const source of this.sources(run.config)) {
        try {
          found.push(...(await source.search(stored.query, stored.languages, { signal })));
        } catch (err) {
          if (signal.aborted) throw err;
          // One source being down must not hide what the others have.
          lastError = err;
          this.options.logger?.warn({ err, source: source.id }, 'subtitle source search failed');
        }
      }
    }
    const ranked = stored.pinned
      ? found.map((c) => ({ ...c, score: 0, reasons: ['chosen by you'] }))
      : rankCandidates(stored.query, found, {
          languages: stored.languages,
          excludeLanguage: run.job.targetLanguage,
        });
    if (ranked.length === 0) {
      if (lastError instanceof Error) throw lastError;
      throw new JobSourceError(
        'source_not_found',
        `No source subtitle was found (languages: ${stored.languages.join(', ') || 'none'}).`,
      );
    }
    const best = ranked[0] as RankedCandidate;
    const label = best.release ?? best.fileName ?? best.id;
    await this.write(run, (job) =>
      updateJob(db, job, workerId, {
        statusDetail: `Found ${ranked.length} subtitle(s); best: ${label}${best.reasons[0] ? ` (${best.reasons[0]})` : ''}`,
      }),
    );
    return ranked;
  }

  /**
   * Download the best candidate, validate it and put it into the library. A
   * candidate that turns out to be unusable is skipped and the next one tried.
   */
  private async acquireSource(run: RunningJob, candidates: RankedCandidate[]): Promise<void> {
    const { db, workerId } = this.options;
    const config = run.config;
    const stored = JSON.parse(run.job.mediaQuery ?? 'null') as StoredMediaQuery | null;
    const sources = new Map(this.sources(run.config).map((s) => [s.id, s]));
    const problems: string[] = [];
    let lastError: unknown;

    for (const candidate of candidates.slice(0, MAX_SOURCE_CANDIDATES)) {
      await this.checkpoint(run);
      const source = sources.get(candidate.source);
      if (!source) {
        problems.push(`${candidate.source}: source is not configured`);
        continue;
      }
      try {
        const file = await source.download(candidate, { signal: run.controller.signal });
        const valid = validateSourceBytes(file.bytes, {
          maxBytes: config.sources.maxBytes,
          legacyEncoding: findLanguage(candidate.language)?.legacyEncoding,
          minEntries: MIN_SOURCE_ENTRIES,
        });
        const language = resolveContentLanguage(candidate.language, valid.srt);
        const known = findLanguage(language)?.id ?? null;
        const row = await storeSource(db, config, {
          srt: valid.srt,
          entries: valid.entries,
          provider: candidate.local ? 'upload' : candidate.source,
          externalId: candidate.local ? undefined : candidate.id,
          language: known ?? undefined,
          fileName: file.fileName ?? candidate.fileName,
          release: candidate.release,
          title: candidate.title ?? stored?.query.title,
          mediaType: stored?.query.type,
          imdbId: stored?.query.imdbId,
          season: stored?.query.season,
          episode: stored?.query.episode,
          videoHash: candidate.hashMatch ? stored?.query.videoHash : undefined,
        });
        await this.write(run, (job) =>
          recordJobSource(db, job, workerId, row, known, candidate.title),
        );
        return;
      } catch (err) {
        if (run.controller.signal.aborted || err instanceof LostLockError) throw err;
        lastError = err;
        problems.push(
          `${candidate.release ?? candidate.id}: ${err instanceof Error ? err.message : 'failed'}`,
        );
      }
    }
    // Quota, authentication and outages are reported as what they are, not as "invalid subtitle".
    if (lastError instanceof SourceError) throw lastError;
    throw new JobSourceError(
      'source_invalid',
      `No usable source subtitle could be obtained. ${problems.slice(0, 3).join('; ')}`,
      { cause: lastError },
    );
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
      if (error instanceof DeferJobError && !run.reason) {
        await deferJob(db, run.job, workerId, error.delayMs, `Waiting: ${error.message}`);
        return;
      }
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
