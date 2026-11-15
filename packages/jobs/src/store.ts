import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveTargets, type AiProviderId } from '@asc/ai-providers';
import type { AppConfig } from '@asc/config';
import {
  Prisma,
  type Database,
  type JobEvent,
  type Notification,
  type SourceSubtitle,
  type Translation,
  type TranslationJob,
} from '@asc/database';
import type { MediaQuery, SourceCandidate } from '@asc/subtitle-sources';
import {
  ENGINE_VERSION,
  findLanguage,
  MOCK_MODEL,
  MOCK_PROVIDER,
  isTranslationProfileId,
  prepareTranslation,
  PROMPT_VERSION,
  resolveTargetLanguage,
  SourceSubtitleError,
  TranslationRequestError,
  UnsupportedLanguageError,
  type SegmentResult,
  type TranslationProfileId,
} from '@asc/translation-engine';
import {
  JobConflictError,
  DeferJobError,
  JobNotFoundError,
  JobRequestError,
  LostLockError,
  type JobFailure,
} from './errors.js';
import { outputPath } from './files.js';
import { computeMediaKey, computeTranslationKey, isProvisionalKey, provisionalKey } from './key.js';
import {
  fileSize,
  findCachedMediaTranslation,
  findCachedTranslation,
  storeSource,
} from './library.js';
import { computePercentage } from './progress.js';
import { ACTIVE_STATES, assertTransition, isTerminal, type JobState } from './states.js';
import {
  toJobView,
  toNotificationView,
  type JobEventType,
  type JobView,
  type NotificationKind,
  type NotificationView,
} from './view.js';

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return true;
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

function isBusy(err: unknown): boolean {
  return err instanceof Error && /SQLITE_BUSY|database is locked/i.test(err.message);
}

/**
 * Run a write, retrying briefly when another process holds the database.
 * The API, the worker and the add-on share one SQLite file; the busy timeout
 * covers almost every collision and this covers the rest.
 */
async function write<T>(db: Database, fn: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(fn);
    } catch (err) {
      if (!isBusy(err) || attempt >= 5) throw err;
      await sleep(40 * attempt);
    }
  }
}

async function appendEvent(
  tx: Tx,
  type: JobEventType,
  jobId: string | null,
  payload: unknown,
  now: Date,
): Promise<void> {
  await tx.jobEvent.create({
    data: { type, jobId, payload: JSON.stringify(payload), createdAt: now },
  });
}

const stateOf = (job: TranslationJob) => job.state as JobState;

function percentageFor(
  job: Pick<TranslationJob, 'percentage' | 'completedSegments' | 'totalSegments'>,
  state: JobState,
): number {
  return computePercentage(
    { state, completedSegments: job.completedSegments, totalSegments: job.totalSegments },
    job.percentage,
  );
}

// ---------------------------------------------------------------------------
// Creating jobs (duplicate prevention)
// ---------------------------------------------------------------------------

export interface CreateJobInput {
  /** Source subtitle as decoded SRT text. */
  srt: string;
  /** Original file name, for display only. */
  sourceName?: string | undefined;
  mediaTitle?: string | undefined;
  mediaType?: 'movie' | 'series' | undefined;
  imdbId?: string | undefined;
  season?: number | undefined;
  episode?: number | undefined;
  sourceLanguage?: string | undefined;
  targetLanguage: string;
  profile?: TranslationProfileId | undefined;
  customInstructions?: string | undefined;
  provider?: AiProviderId | undefined;
  model?: string | undefined;
  origin?: 'manual' | 'stremio' | undefined;
  /** Translate again even when an identical completed translation exists. */
  force?: boolean | undefined;
}

export interface CreateJobResult {
  job: TranslationJob;
  /** False when an existing job was returned instead of creating a new one. */
  created: boolean;
  /**
   * `created`: a new job was queued. `active`: an identical job is already
   * queued or running. `completed`: an identical finished translation exists.
   */
  reason: 'created' | 'active' | 'completed';
}

/**
 * Create a translation job, or return the existing one for the same request.
 *
 * Equivalent requests share a translation key. The database allows only one
 * ACTIVE job per key (unique `activeKey`), so two simultaneous requests can
 * never both create a job: the loser of the race gets the winner's job back.
 *
 * @throws JobRequestError when the request itself is invalid.
 */
export async function createJob(
  db: Database,
  config: AppConfig,
  input: CreateJobInput,
  now = new Date(),
): Promise<CreateJobResult> {
  let plan;
  try {
    plan = prepareTranslation({
      srt: input.srt,
      targetLanguage: input.targetLanguage,
      ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
      ...(input.profile ? { profile: input.profile } : {}),
      ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
    });
  } catch (err) {
    if (err instanceof SourceSubtitleError)
      throw new JobRequestError('source_invalid', err.message);
    if (err instanceof UnsupportedLanguageError) {
      throw new JobRequestError('unsupported_language', err.message);
    }
    if (err instanceof TranslationRequestError) {
      throw new JobRequestError('invalid_request', err.message);
    }
    throw err;
  }

  const { provider, model } = resolveProvider(config, input);

  const source = await storeSource(
    db,
    config,
    {
      srt: input.srt,
      entries: plan.entries,
      provider: 'upload',
      language: plan.sourceLanguage?.id,
      fileName: input.sourceName,
      // Only a title the owner typed; a title derived from the file name is not one.
      title: input.mediaTitle,
      mediaType: input.mediaType,
      imdbId: input.imdbId,
      season: input.season,
      episode: input.episode,
    },
    now,
  );
  const translationKey = computeTranslationKey({
    sourceHash: source.hash,
    targetLanguage: plan.targetLanguage.id,
    targetScript: plan.targetLanguage.script,
    profile: plan.profile,
    customInstructions: plan.customInstructions,
  });

  const active = await db.translationJob.findUnique({ where: { activeKey: translationKey } });
  if (active) return { job: active, created: false, reason: 'active' };

  if (!input.force) {
    // Translation cache: an identical finished translation is handed back, not redone.
    const cached = await findCachedTranslation(db, config, translationKey, now);
    const producer = cached
      ? await db.translationJob.findUnique({ where: { id: cached.jobId } })
      : null;
    if (producer?.state === 'completed')
      return { job: producer, created: false, reason: 'completed' };
  }

  const id = randomUUID();
  const title =
    input.mediaTitle?.trim() ||
    input.sourceName?.replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() ||
    'Untitled subtitle';

  try {
    const job = await write(db, async (tx) => {
      const created = await tx.translationJob.create({
        data: {
          id,
          translationKey,
          activeKey: translationKey,
          state: 'queued',
          origin: input.origin ?? 'manual',
          force: input.force ?? false,
          mediaTitle: title.slice(0, 300),
          mediaType: input.mediaType ?? null,
          imdbId: input.imdbId ?? null,
          season: input.season ?? null,
          episode: input.episode ?? null,
          sourceName: input.sourceName?.slice(0, 300) ?? null,
          sourceLanguage: plan.sourceLanguage?.id ?? null,
          targetLanguage: plan.targetLanguage.id,
          targetScript: plan.targetLanguage.script,
          profile: plan.profile,
          customInstructions: plan.customInstructions ?? null,
          provider,
          model,
          sourceId: source.id,
          sourceFile: source.file,
          sourceHash: source.hash,
          totalEntries: plan.entries.length,
          createdAt: now,
          updatedAt: now,
        },
      });
      await appendEvent(tx, 'job.created', id, toJobView(created), now);
      return created;
    });
    return { job, created: true, reason: 'created' };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost the race against an identical request: hand back the job that won.
    const winner = await db.translationJob.findUnique({ where: { activeKey: translationKey } });
    if (!winner) throw err;
    return { job: winner, created: false, reason: 'active' };
  }
}

function resolveProvider(
  config: AppConfig,
  input: { provider?: AiProviderId | undefined; model?: string | undefined },
): { provider: string; model: string } {
  if (config.mockAi.enabled) return { provider: MOCK_PROVIDER, model: MOCK_MODEL };
  const target = resolveTargets(config, { provider: input.provider, model: input.model }).primary;
  if (!config.ai.apiKeys[target.provider]) {
    throw new JobRequestError(
      'provider_not_configured',
      `No API key is configured for the AI provider "${target.provider}".`,
    );
  }
  return target;
}

// ---------------------------------------------------------------------------
// Media requests: the job finds its own source subtitle
// ---------------------------------------------------------------------------

/** Stored on a discovery job: what to look for and how. */
export interface StoredMediaQuery {
  query: MediaQuery;
  /** Acceptable source languages, most preferred first. */
  languages: string[];
  /** A source the owner picked by hand: used instead of searching. */
  pinned?: SourceCandidate | undefined;
}

export interface MediaTranslationInput {
  query: MediaQuery;
  targetLanguage: string;
  profile?: TranslationProfileId | undefined;
  customInstructions?: string | undefined;
  /** Source languages to accept; defaults to the configured SOURCE_LANGUAGES. */
  sourceLanguages?: string[] | undefined;
  pinned?: SourceCandidate | undefined;
  provider?: AiProviderId | undefined;
  model?: string | undefined;
  origin?: 'manual' | 'stremio' | undefined;
  force?: boolean | undefined;
  /** False = only look: report what exists, never start a translation. Default true. */
  create?: boolean | undefined;
}

export interface MediaTranslationResult {
  /**
   * `cached`: a finished translation exists (see `translation`).
   * `active`: a job for this request is already queued or running.
   * `created`: a new job was queued.
   * `failed`: a recent attempt failed; it is not retried yet (see `job.error`).
   * `missing`: nothing exists and the caller asked not to create a job.
   */
  status: 'cached' | 'active' | 'created' | 'failed' | 'missing';
  job: TranslationJob | null;
  translation: Translation | null;
}

/**
 * Ask for the translation of a title (movie or episode) without supplying a
 * subtitle: answered from the cache when possible, otherwise by a background
 * job that finds a source subtitle itself. Never waits for a translation.
 *
 * This is what the Stremio add-on calls. It is safe to call on every play:
 * repeated requests share one job, a finished translation is served from the
 * cache, and a title for which nothing was found is not searched again for
 * `SOURCE_RETRY_MINUTES`.
 */
export async function requestMediaTranslation(
  db: Database,
  config: AppConfig,
  input: MediaTranslationInput,
  now = new Date(),
): Promise<MediaTranslationResult> {
  let target;
  try {
    target = resolveTargetLanguage(input.targetLanguage);
  } catch (err) {
    throw new JobRequestError(
      'unsupported_language',
      err instanceof Error ? err.message : 'Unsupported language.',
    );
  }
  const profile = input.profile ?? 'natural';
  if (!isTranslationProfileId(profile)) {
    throw new JobRequestError(
      'invalid_request',
      `Unknown translation profile: "${String(profile)}".`,
    );
  }
  const customInstructions = input.customInstructions?.trim() || undefined;
  if (profile === 'custom' && !customInstructions) {
    throw new JobRequestError(
      'invalid_request',
      'The custom profile requires custom instructions.',
    );
  }
  const { query } = input;
  if (!query.imdbId && !query.title && !input.pinned) {
    throw new JobRequestError(
      'invalid_request',
      'An IMDb id, a title or a chosen source is required.',
    );
  }
  if (
    query.type === 'series' &&
    (query.season === undefined || query.episode === undefined) &&
    !input.pinned
  ) {
    throw new JobRequestError(
      'invalid_request',
      'A series request needs a season and an episode number.',
    );
  }

  const mediaKey = computeMediaKey({
    type: query.type,
    imdbId: query.imdbId,
    title: query.title,
    year: query.year,
    season: query.season,
    episode: query.episode,
    videoHash: query.videoHash,
    pinned: input.pinned ? `${input.pinned.source}:${input.pinned.id}` : undefined,
    targetLanguage: target.id,
    targetScript: target.script,
    profile,
    customInstructions,
  });

  if (!input.force) {
    const translation = await findCachedMediaTranslation(db, config, mediaKey, now);
    if (translation) {
      const job = await db.translationJob.findUnique({ where: { id: translation.jobId } });
      return { status: 'cached', job, translation };
    }
  }
  const active = await db.translationJob.findFirst({
    where: { mediaKey, state: { in: [...ACTIVE_STATES] } },
    orderBy: { createdAt: 'desc' },
  });
  if (active) return { status: 'active', job: active, translation: null };

  if (!input.force && config.sources.retryMinutes > 0) {
    const since = new Date(now.getTime() - config.sources.retryMinutes * 60_000);
    const failed = await db.translationJob.findFirst({
      where: { mediaKey, state: 'failed', completedAt: { gt: since } },
      orderBy: { completedAt: 'desc' },
    });
    if (failed) return { status: 'failed', job: failed, translation: null };
  }
  if (input.create === false) return { status: 'missing', job: null, translation: null };

  const { provider, model } = resolveProvider(config, input);
  const episode =
    query.season !== undefined && query.episode !== undefined
      ? ` S${String(query.season).padStart(2, '0')}E${String(query.episode).padStart(2, '0')}`
      : '';
  const title = `${query.title?.trim() || query.imdbId || input.pinned?.release || 'Untitled'}${episode}`;
  const stored: StoredMediaQuery = {
    query,
    languages: input.sourceLanguages?.length ? input.sourceLanguages : config.sources.languages,
    ...(input.pinned ? { pinned: input.pinned } : {}),
  };
  const id = randomUUID();
  try {
    const job = await write(db, async (tx) => {
      const created = await tx.translationJob.create({
        data: {
          id,
          translationKey: provisionalKey(mediaKey),
          activeKey: provisionalKey(mediaKey),
          mediaKey,
          mediaQuery: JSON.stringify(stored),
          state: 'queued',
          origin: input.origin ?? 'manual',
          force: input.force ?? false,
          mediaTitle: title.slice(0, 300),
          mediaType: query.type,
          imdbId: query.imdbId ?? null,
          season: query.season ?? null,
          episode: query.episode ?? null,
          targetLanguage: target.id,
          targetScript: target.script,
          profile,
          customInstructions: customInstructions ?? null,
          provider,
          model,
          createdAt: now,
          updatedAt: now,
        },
      });
      await appendEvent(tx, 'job.created', id, toJobView(created), now);
      return created;
    });
    return { status: 'created', job, translation: null };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const winner = await db.translationJob.findUnique({
      where: { activeKey: provisionalKey(mediaKey) },
    });
    if (!winner) throw err;
    return { status: 'active', job: winner, translation: null };
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getJob(db: Database, id: string): Promise<TranslationJob | null> {
  return db.translationJob.findUnique({ where: { id } });
}

export async function requireJob(db: Database, id: string): Promise<TranslationJob> {
  const job = await getJob(db, id);
  if (!job) throw new JobNotFoundError(id);
  return job;
}

export type JobScope = 'active' | 'finished' | 'all';

export async function listJobs(
  db: Database,
  options: { scope?: JobScope; limit?: number } = {},
): Promise<TranslationJob[]> {
  const scope = options.scope ?? 'all';
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const active = [...ACTIVE_STATES];
  if (scope === 'active') {
    return db.translationJob.findMany({
      where: { state: { in: active } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
  }
  return db.translationJob.findMany({
    where: scope === 'finished' ? { state: { notIn: active } } : {},
    orderBy: { updatedAt: 'desc' },
    take: limit,
  });
}

export interface JobPageQuery {
  scope?: JobScope | undefined;
  /** Only jobs in this final state. */
  status?: 'completed' | 'failed' | 'cancelled' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/** One page of jobs plus the total number that match (for the history table). */
export async function listJobsPage(
  db: Database,
  query: JobPageQuery = {},
): Promise<{ jobs: TranslationJob[]; total: number }> {
  const active = [...ACTIVE_STATES];
  const scope = query.scope ?? 'all';
  const where = query.status
    ? { state: query.status }
    : scope === 'active'
      ? { state: { in: active } }
      : scope === 'finished'
        ? { state: { notIn: active } }
        : {};
  const [jobs, total] = await Promise.all([
    db.translationJob.findMany({
      where,
      orderBy: scope === 'active' && !query.status ? { createdAt: 'asc' } : { updatedAt: 'desc' },
      take: Math.min(Math.max(query.limit ?? 50, 1), 200),
      skip: Math.max(query.offset ?? 0, 0),
    }),
    db.translationJob.count({ where }),
  ]);
  return { jobs, total };
}

// ---------------------------------------------------------------------------
// Worker side: claiming, leases, recovery
// ---------------------------------------------------------------------------

/**
 * Claim the oldest queued job for a worker. Atomic: the claim is one UPDATE
 * that only succeeds while the job is still queued and unlocked, so two
 * workers can never claim the same job.
 */
export async function claimNextJob(
  db: Database,
  workerId: string,
  leaseMs: number,
  now = new Date(),
): Promise<TranslationJob | null> {
  for (let tries = 0; tries < 5; tries++) {
    const candidate = await db.translationJob.findFirst({
      where: {
        state: 'queued',
        lockedBy: null,
        OR: [{ runAfter: null }, { runAfter: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
    });
    if (!candidate) return null;
    const claimed = await write(db, async (tx) => {
      const { count } = await tx.translationJob.updateMany({
        where: { id: candidate.id, state: 'queued', lockedBy: null },
        data: {
          lockedBy: workerId,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          startedAt: candidate.startedAt ?? now,
          updatedAt: now,
        },
      });
      return count === 1 ? tx.translationJob.findUnique({ where: { id: candidate.id } }) : null;
    });
    if (claimed) return claimed;
  }
  return null;
}

export interface HeldJob {
  id: string;
  cancelRequested: boolean;
}

/**
 * Extend the lease of every job this worker holds and report which jobs it
 * still owns (and whether cancellation was requested for them). A job missing
 * from the result is no longer this worker's: it must stop working on it.
 */
export async function renewLeases(
  db: Database,
  workerId: string,
  leaseMs: number,
  now = new Date(),
): Promise<HeldJob[]> {
  await write(db, (tx) =>
    tx.translationJob.updateMany({
      where: { lockedBy: workerId },
      data: { leaseExpiresAt: new Date(now.getTime() + leaseMs) },
    }),
  );
  return db.translationJob.findMany({
    where: { lockedBy: workerId },
    select: { id: true, cancelRequested: true },
  });
}

export interface RecoveryResult {
  requeued: string[];
  failed: string[];
}

/**
 * Recover jobs whose worker died (their lease expired).
 *
 * The job goes back to `queued` with its accepted segments intact, so the next
 * run resumes instead of starting over. A job that keeps killing its worker is
 * not retried forever: after `maxAttempts` runs it is moved to `failed` with
 * the explicit, owner-retryable error `interrupted_by_restart`.
 */
export async function recoverExpiredJobs(
  db: Database,
  maxAttempts: number,
  now = new Date(),
): Promise<RecoveryResult> {
  const expired = await db.translationJob.findMany({
    where: { lockedBy: { not: null }, leaseExpiresAt: { lt: now } },
  });
  const result: RecoveryResult = { requeued: [], failed: [] };
  for (const job of expired) {
    if (isTerminal(stateOf(job))) continue;
    const stillExpired = { id: job.id, lockedBy: job.lockedBy, leaseExpiresAt: { lt: now } };
    if (job.attempt >= maxAttempts) {
      const failed = await failWhere(
        db,
        job,
        stillExpired,
        {
          code: 'interrupted_by_restart',
          message:
            `The worker stopped ${job.attempt} time(s) while processing this job. ` +
            'Completed segments are kept: retry the job to continue.',
        },
        now,
      );
      if (failed) result.failed.push(job.id);
      continue;
    }
    const requeued = await write(db, async (tx) => {
      const { count } = await tx.translationJob.updateMany({
        where: stillExpired,
        data: {
          state: 'queued',
          lockedBy: null,
          leaseExpiresAt: null,
          attempt: job.attempt + 1,
          currentSegment: null,
          etaSeconds: null,
          statusDetail: 'Recovered after the worker stopped; resuming',
          percentage: percentageFor(job, 'queued'),
          updatedAt: now,
        },
      });
      if (count !== 1) return false;
      const row = await tx.translationJob.findUniqueOrThrow({ where: { id: job.id } });
      await appendEvent(tx, 'job.updated', job.id, toJobView(row), now);
      return true;
    });
    if (requeued) result.requeued.push(job.id);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Worker side: progress
// ---------------------------------------------------------------------------

type JobPatch = Partial<
  Pick<
    TranslationJob,
    | 'totalEntries'
    | 'completedEntries'
    | 'totalSegments'
    | 'completedSegments'
    | 'currentSegment'
    | 'etaSeconds'
    | 'statusDetail'
    | 'retryCount'
    | 'inputTokens'
    | 'outputTokens'
    | 'costUsd'
    | 'costKnown'
  >
>;

/**
 * Apply a change to a job this worker owns. Compare-and-set: the UPDATE only
 * matches while the job is still in the expected state AND still locked by
 * this worker — a worker that lost its lease cannot write anything.
 * The write and its event are one transaction.
 */
async function writeOwned(
  db: Database,
  job: TranslationJob,
  workerId: string,
  data: Prisma.TranslationJobUpdateManyMutationInput,
  eventType: JobEventType,
  now: Date,
  extra?: (tx: Tx, row: TranslationJob) => Promise<void>,
): Promise<TranslationJob> {
  return write(db, async (tx) => {
    const { count } = await tx.translationJob.updateMany({
      where: { id: job.id, lockedBy: workerId, state: job.state },
      data: { ...data, updatedAt: now },
    });
    if (count !== 1) throw new LostLockError(job.id);
    const row = await tx.translationJob.findUniqueOrThrow({ where: { id: job.id } });
    await extra?.(tx, row);
    await appendEvent(tx, eventType, job.id, toJobView(row), now);
    return row;
  });
}

/** Move an owned job to the next state. Illegal transitions are rejected before any write. */
export async function transitionJob(
  db: Database,
  job: TranslationJob,
  workerId: string,
  to: JobState,
  patch: JobPatch = {},
  now = new Date(),
): Promise<TranslationJob> {
  assertTransition(stateOf(job), to);
  const next = { ...job, ...patch };
  return writeOwned(
    db,
    job,
    workerId,
    { ...patch, state: to, percentage: percentageFor(next, to) },
    'job.updated',
    now,
  );
}

/** Update fields of an owned job without changing its state. */
export async function updateJob(
  db: Database,
  job: TranslationJob,
  workerId: string,
  patch: JobPatch,
  now = new Date(),
): Promise<TranslationJob> {
  const next = { ...job, ...patch };
  return writeOwned(
    db,
    job,
    workerId,
    { ...patch, percentage: percentageFor(next, stateOf(job)) },
    'job.updated',
    now,
  );
}

export interface SegmentCheckpoint {
  result: SegmentResult;
  /** Wall-clock time the segment took in this worker, retries included. */
  wallMs: number;
  etaSeconds: number | null;
}

/**
 * Record an accepted segment: the checkpoint row and the job's counters,
 * percentage and estimate change together, in one transaction. Progress
 * therefore only ever reflects segments that are safely stored.
 */
export async function saveSegment(
  db: Database,
  job: TranslationJob,
  workerId: string,
  checkpoint: SegmentCheckpoint,
  now = new Date(),
): Promise<TranslationJob> {
  const { result } = checkpoint;
  const entries = result.translations.length;
  const next = {
    completedSegments: job.completedSegments + 1,
    completedEntries: job.completedEntries + entries,
    totalSegments: job.totalSegments,
    percentage: job.percentage,
  };
  return writeOwned(
    db,
    job,
    workerId,
    {
      completedSegments: next.completedSegments,
      completedEntries: next.completedEntries,
      currentSegment: null,
      etaSeconds: checkpoint.etaSeconds,
      statusDetail: null,
      inputTokens: job.inputTokens + result.usage.inputTokens,
      outputTokens: job.outputTokens + result.usage.outputTokens,
      costUsd: job.costUsd + (result.costUsd ?? 0),
      costKnown: job.costKnown && result.costUsd !== undefined,
      percentage: percentageFor(next, stateOf(job)),
    },
    'job.updated',
    now,
    async (tx) => {
      await tx.jobSegment.upsert({
        where: { jobId_segmentIndex: { jobId: job.id, segmentIndex: result.segmentIndex } },
        create: {
          jobId: job.id,
          segmentIndex: result.segmentIndex,
          entries,
          attempts: result.attempts,
          durationMs: Math.round(checkpoint.wallMs),
          result: JSON.stringify(result),
          createdAt: now,
        },
        update: {},
      });
    },
  );
}

/** Accepted segments of a job, in order. */
export async function loadSegments(db: Database, jobId: string): Promise<SegmentResult[]> {
  const rows = await db.jobSegment.findMany({
    where: { jobId },
    orderBy: { segmentIndex: 'asc' },
  });
  return rows.map((r) => JSON.parse(r.result) as SegmentResult);
}

// ---------------------------------------------------------------------------
// Terminal outcomes
// ---------------------------------------------------------------------------

async function createNotification(
  tx: Tx,
  job: TranslationJob,
  kind: NotificationKind,
  title: string,
  message: string,
  now: Date,
): Promise<void> {
  // The unique (job, kind, attempt) key makes this idempotent: one notification per outcome.
  const key = { jobId: job.id, kind, attempt: job.attempt };
  const existing = await tx.notification.findUnique({ where: { jobId_kind_attempt: key } });
  if (existing) return;
  const created = await tx.notification.create({
    data: { id: randomUUID(), ...key, title, message: message.slice(0, 600), createdAt: now },
  });
  await appendEvent(tx, 'notification.created', job.id, toNotificationView(created), now);
}

function describeTarget(job: TranslationJob): string {
  return findLanguage(job.targetLanguage)?.name ?? job.targetLanguage;
}

export interface JobOutcome {
  /** File name of the translation, relative to the subtitles directory. */
  outputFile: string;
  usedModels: { provider: string; model: string }[];
  /** True when the file is an existing cached translation that was reused. */
  cacheHit?: boolean;
  entries?: number;
  /** Validation result and statistics of the run, stored with the cache entry. */
  validation?: unknown;
  stats?: unknown;
}

/**
 * Mark an owned job completed. Called only after the translated file is on
 * disk; this is the single place where a job reaches 100%.
 *
 * In the same transaction the translation enters the cache (keyed by the
 * translation key) and, for media requests, the media → translation link is
 * recorded. Returns the file a replaced cache entry used, for the caller to delete.
 */
export async function completeJob(
  db: Database,
  config: AppConfig,
  job: TranslationJob,
  workerId: string,
  outcome: JobOutcome,
  now = new Date(),
): Promise<{ job: TranslationJob; replacedFile: string | null }> {
  assertTransition(stateOf(job), 'completed');
  if (!job.sourceId || isProvisionalKey(job.translationKey)) {
    throw new Error('A job cannot complete before its source subtitle is known.');
  }
  const sourceId = job.sourceId;
  let replacedFile: string | null = null;
  const row = await writeOwned(
    db,
    job,
    workerId,
    {
      state: 'completed',
      percentage: 100,
      outputFile: outcome.outputFile,
      usedModels: JSON.stringify(outcome.usedModels),
      cacheHit: outcome.cacheHit ?? false,
      activeKey: null,
      lockedBy: null,
      leaseExpiresAt: null,
      currentSegment: null,
      etaSeconds: null,
      statusDetail: null,
      cancelRequested: false,
      runAfter: null,
      completedAt: now,
    },
    'job.completed',
    now,
    async (tx, updated) => {
      if (outcome.cacheHit) {
        await tx.translation.updateMany({
          where: { translationKey: job.translationKey },
          data: { lastUsedAt: now },
        });
      } else {
        const entry = {
          sourceId,
          targetLanguage: job.targetLanguage,
          targetScript: job.targetScript,
          profile: job.profile,
          customInstructions: job.customInstructions,
          promptVersion: PROMPT_VERSION,
          engineVersion: ENGINE_VERSION,
          models: JSON.stringify(outcome.usedModels),
          file: outcome.outputFile,
          entries: outcome.entries ?? job.totalEntries,
          sizeBytes: fileSize(outputPath(config, outcome.outputFile)),
          validation: JSON.stringify(outcome.validation ?? null),
          stats: JSON.stringify(outcome.stats ?? null),
          jobId: job.id,
          lastUsedAt: now,
        };
        const previous = await tx.translation.findUnique({
          where: { translationKey: job.translationKey },
        });
        if (previous) {
          // A forced re-translation replaces the cached one; older jobs now point at the new file.
          if (previous.file !== outcome.outputFile) {
            replacedFile = previous.file;
            await tx.translationJob.updateMany({
              where: { outputFile: previous.file, id: { not: job.id } },
              data: { outputFile: outcome.outputFile },
            });
          }
          await tx.translation.update({
            where: { id: previous.id },
            data: { ...entry, createdAt: now },
          });
        } else {
          await tx.translation.create({
            data: {
              id: randomUUID(),
              translationKey: job.translationKey,
              ...entry,
              createdAt: now,
            },
          });
        }
      }
      await tx.sourceSubtitle.updateMany({ where: { id: sourceId }, data: { lastUsedAt: now } });
      if (job.mediaKey) {
        await tx.mediaLink.upsert({
          where: { mediaKey: job.mediaKey },
          create: {
            mediaKey: job.mediaKey,
            translationKey: job.translationKey,
            createdAt: now,
            updatedAt: now,
          },
          update: { translationKey: job.translationKey, updatedAt: now },
        });
      }
      await createNotification(
        tx,
        updated,
        'completed',
        'Translation completed',
        `${updated.mediaTitle} → ${describeTarget(updated)}`,
        now,
      );
    },
  );
  return { job: row, replacedFile };
}

/**
 * Record the source subtitle a discovery job found. The job keeps its
 * provisional key for now, so a re-run does not have to search again.
 */
export async function recordJobSource(
  db: Database,
  job: TranslationJob,
  workerId: string,
  source: SourceSubtitle,
  language: string | null,
  /** Title of the media as the source knows it; replaces a bare IMDb id as the job's title. */
  title?: string,
  now = new Date(),
): Promise<TranslationJob> {
  // Stremio only sends an IMDb id; show the real title once a source has told us what it is.
  const untitled = job.imdbId !== null && job.mediaTitle.startsWith(job.imdbId);
  const named =
    title?.trim() && untitled ? job.mediaTitle.replace(job.imdbId ?? '', title.trim()) : undefined;
  return writeOwned(
    db,
    job,
    workerId,
    {
      sourceId: source.id,
      sourceFile: source.file,
      sourceHash: source.hash,
      sourceLanguage: language,
      sourceName: source.fileName ?? source.release ?? job.sourceName,
      totalEntries: source.entries,
      ...(named ? { mediaTitle: named.slice(0, 300) } : {}),
    },
    'job.updated',
    now,
  );
}

/**
 * Switch a discovery job from its provisional (media) key to the real,
 * content-based translation key. From here on it is deduplicated against
 * every other job translating the same subtitle.
 *
 * @throws DeferJobError when another active job already holds that key: this
 *         job then waits and later picks the result up from the cache.
 */
export async function adoptTranslationKey(
  db: Database,
  job: TranslationJob,
  workerId: string,
  translationKey: string,
  now = new Date(),
): Promise<TranslationJob> {
  try {
    return await writeOwned(
      db,
      job,
      workerId,
      { translationKey, activeKey: translationKey },
      'job.updated',
      now,
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new DeferJobError('The same subtitle is already being translated by another job.');
  }
}

/** Send an owned job back to the queue to be looked at again after `delayMs`. Not a failure. */
export async function deferJob(
  db: Database,
  job: TranslationJob,
  workerId: string,
  delayMs: number,
  note: string,
  now = new Date(),
): Promise<TranslationJob> {
  assertTransition(stateOf(job), 'queued');
  return writeOwned(
    db,
    job,
    workerId,
    {
      state: 'queued',
      lockedBy: null,
      leaseExpiresAt: null,
      currentSegment: null,
      etaSeconds: null,
      statusDetail: note,
      runAfter: new Date(now.getTime() + delayMs),
      percentage: percentageFor(job, 'queued'),
    },
    'job.updated',
    now,
  );
}

async function failWhere(
  db: Database,
  job: TranslationJob,
  where: Prisma.TranslationJobWhereInput,
  failure: JobFailure,
  now: Date,
): Promise<TranslationJob | null> {
  assertTransition(stateOf(job), 'failed');
  return write(db, async (tx) => {
    const { count } = await tx.translationJob.updateMany({
      where,
      data: {
        state: 'failed',
        errorCode: failure.code,
        errorMessage: failure.message,
        errorStage: job.state,
        activeKey: null,
        lockedBy: null,
        leaseExpiresAt: null,
        currentSegment: null,
        etaSeconds: null,
        statusDetail: null,
        cancelRequested: false,
        completedAt: now,
        updatedAt: now,
      },
    });
    if (count !== 1) return null;
    const row = await tx.translationJob.findUniqueOrThrow({ where: { id: job.id } });
    await createNotification(
      tx,
      row,
      'failed',
      'Translation failed',
      `${row.mediaTitle}: ${failure.message}`,
      now,
    );
    await appendEvent(tx, 'job.failed', job.id, toJobView(row), now);
    return row;
  });
}

/** Mark an owned job failed, recording what went wrong and at which stage. */
export async function failJob(
  db: Database,
  job: TranslationJob,
  workerId: string,
  failure: JobFailure,
  now = new Date(),
): Promise<TranslationJob> {
  const row = await failWhere(
    db,
    job,
    { id: job.id, lockedBy: workerId, state: job.state },
    failure,
    now,
  );
  if (!row) throw new LostLockError(job.id);
  return row;
}

/** Acknowledge a cancellation: the owned job becomes `cancelled` and its partial work is dropped. */
export async function cancelOwnedJob(
  db: Database,
  job: TranslationJob,
  workerId: string,
  now = new Date(),
): Promise<TranslationJob> {
  assertTransition(stateOf(job), 'cancelled');
  return writeOwned(
    db,
    job,
    workerId,
    {
      state: 'cancelled',
      activeKey: null,
      lockedBy: null,
      leaseExpiresAt: null,
      currentSegment: null,
      etaSeconds: null,
      statusDetail: null,
      completedAt: now,
    },
    'job.cancelled',
    now,
    async (tx) => {
      await tx.jobSegment.deleteMany({ where: { jobId: job.id } });
    },
  );
}

/** Give an owned job back to the queue (graceful worker shutdown). Accepted segments are kept. */
export async function releaseJob(
  db: Database,
  job: TranslationJob,
  workerId: string,
  now = new Date(),
): Promise<TranslationJob> {
  if (stateOf(job) === 'queued') {
    return write(db, async (tx) => {
      await tx.translationJob.updateMany({
        where: { id: job.id, lockedBy: workerId },
        data: { lockedBy: null, leaseExpiresAt: null, updatedAt: now },
      });
      return tx.translationJob.findUniqueOrThrow({ where: { id: job.id } });
    });
  }
  assertTransition(stateOf(job), 'queued');
  return writeOwned(
    db,
    job,
    workerId,
    {
      state: 'queued',
      lockedBy: null,
      leaseExpiresAt: null,
      currentSegment: null,
      etaSeconds: null,
      statusDetail: 'Paused: the worker is restarting',
      percentage: percentageFor(job, 'queued'),
    },
    'job.updated',
    now,
  );
}

// ---------------------------------------------------------------------------
// Owner actions (API side)
// ---------------------------------------------------------------------------

/**
 * Request cancellation.
 *
 * A queued job nobody has claimed is cancelled on the spot. A job that a
 * worker is processing only gets `cancelRequested`: the worker notices,
 * stops, and acknowledges by moving it to `cancelled` — only then is the
 * cancellation complete.
 */
export async function requestCancel(
  db: Database,
  jobId: string,
  now = new Date(),
): Promise<TranslationJob> {
  const job = await requireJob(db, jobId);
  if (isTerminal(stateOf(job))) {
    throw new JobConflictError(`The job is already ${job.state}.`);
  }
  return write(db, async (tx) => {
    const direct = await tx.translationJob.updateMany({
      where: { id: jobId, state: 'queued', lockedBy: null },
      data: {
        state: 'cancelled',
        activeKey: null,
        cancelRequested: false,
        statusDetail: null,
        completedAt: now,
        updatedAt: now,
      },
    });
    if (direct.count === 1) {
      await tx.jobSegment.deleteMany({ where: { jobId } });
      const row = await tx.translationJob.findUniqueOrThrow({ where: { id: jobId } });
      await appendEvent(tx, 'job.cancelled', jobId, toJobView(row), now);
      return row;
    }
    const flagged = await tx.translationJob.updateMany({
      where: { id: jobId, state: { in: [...ACTIVE_STATES] } },
      data: { cancelRequested: true, statusDetail: 'Cancelling…', updatedAt: now },
    });
    const row = await tx.translationJob.findUniqueOrThrow({ where: { id: jobId } });
    if (flagged.count === 1) await appendEvent(tx, 'job.updated', jobId, toJobView(row), now);
    return row;
  });
}

/** Owner retry of a failed job. Accepted segments are kept, so it resumes where it stopped. */
export async function retryJob(
  db: Database,
  jobId: string,
  now = new Date(),
): Promise<TranslationJob> {
  const job = await requireJob(db, jobId);
  if (stateOf(job) !== 'failed') {
    throw new JobConflictError(`Only a failed job can be retried (this job is ${job.state}).`);
  }
  try {
    return await write(db, async (tx) => {
      const { count } = await tx.translationJob.updateMany({
        where: { id: jobId, state: 'failed' },
        data: {
          state: 'queued',
          attempt: job.attempt + 1,
          activeKey: job.translationKey,
          errorCode: null,
          errorMessage: null,
          errorStage: null,
          cancelRequested: false,
          statusDetail: null,
          completedAt: null,
          percentage: percentageFor(job, 'queued'),
          updatedAt: now,
        },
      });
      if (count !== 1) throw new JobConflictError('The job is no longer failed.');
      const row = await tx.translationJob.findUniqueOrThrow({ where: { id: jobId } });
      await appendEvent(tx, 'job.updated', jobId, toJobView(row), now);
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new JobConflictError('An identical translation is already in progress.');
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Events and notifications
// ---------------------------------------------------------------------------

export async function latestEventId(db: Database): Promise<number> {
  const last = await db.jobEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true } });
  return last?.id ?? 0;
}

export async function readEventsAfter(
  db: Database,
  afterId: number,
  limit = 500,
): Promise<JobEvent[]> {
  return db.jobEvent.findMany({
    where: { id: { gt: afterId } },
    orderBy: { id: 'asc' },
    take: limit,
  });
}

/** Keep the event log bounded: drop everything but the newest `keep` events. */
export async function pruneEvents(db: Database, keep = 5000): Promise<number> {
  const newest = await latestEventId(db);
  const { count } = await db.jobEvent.deleteMany({ where: { id: { lte: newest - keep } } });
  return count;
}

export async function listNotifications(
  db: Database,
  options: { unreadOnly?: boolean; limit?: number } = {},
): Promise<Notification[]> {
  return db.notification.findMany({
    where: options.unreadOnly ? { readAt: null } : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(options.limit ?? 50, 1), 200),
  });
}

export async function markNotificationRead(
  db: Database,
  id: string,
  now = new Date(),
): Promise<Notification | null> {
  return write(db, async (tx) => {
    const { count } = await tx.notification.updateMany({
      where: { id, readAt: null },
      data: { readAt: now },
    });
    const row = await tx.notification.findUnique({ where: { id } });
    if (row && count === 1) {
      await appendEvent(tx, 'notification.read', row.jobId, toNotificationView(row), now);
    }
    return row;
  });
}

export async function markAllNotificationsRead(db: Database, now = new Date()): Promise<number> {
  return write(db, async (tx) => {
    const unread = await tx.notification.findMany({ where: { readAt: null } });
    if (unread.length === 0) return 0;
    await tx.notification.updateMany({ where: { readAt: null }, data: { readAt: now } });
    for (const n of unread) {
      await appendEvent(
        tx,
        'notification.read',
        n.jobId,
        toNotificationView({ ...n, readAt: now }),
        now,
      );
    }
    return unread.length;
  });
}

export interface Snapshot {
  /** Id of the newest event reflected in this snapshot; live events continue after it. */
  lastEventId: number;
  serverTime: string;
  /** All active jobs plus the most recently finished ones. */
  jobs: JobView[];
  /** Unread notifications. */
  notifications: NotificationView[];
}

/**
 * Current state for a (re)connecting client. The event id is read FIRST: any
 * change that lands while the snapshot is being read is delivered again as a
 * live event, and applying a job view twice is harmless.
 */
export async function readSnapshot(db: Database, now = new Date()): Promise<Snapshot> {
  const lastEventId = await latestEventId(db);
  const [active, finished, notifications] = await Promise.all([
    listJobs(db, { scope: 'active', limit: 200 }),
    listJobs(db, { scope: 'finished', limit: 20 }),
    listNotifications(db, { unreadOnly: true, limit: 50 }),
  ]);
  return {
    lastEventId,
    serverTime: now.toISOString(),
    jobs: [...active, ...finished].map(toJobView),
    notifications: notifications.map(toNotificationView),
  };
}

/** Jobs that a given origin started since `since` (used to cap automatic translations). */
export async function countJobsSince(db: Database, origin: string, since: Date): Promise<number> {
  return db.translationJob.count({ where: { origin, createdAt: { gt: since } } });
}
