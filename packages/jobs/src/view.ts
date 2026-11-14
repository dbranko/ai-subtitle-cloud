import type { Notification, TranslationJob } from '@asc/database';
import type { JobState } from './states.js';

/** A job as the API, the event stream and the dashboard see it. No internal fields, no paths. */
export interface JobView {
  id: string;
  state: JobState;
  origin: string;
  attempt: number;
  mediaTitle: string;
  mediaType: string | null;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
  sourceName: string | null;
  sourceLanguage: string | null;
  targetLanguage: string;
  targetScript: string;
  profile: string;
  provider: string;
  model: string;
  usedModels: { provider: string; model: string }[];
  percentage: number;
  totalEntries: number;
  completedEntries: number;
  totalSegments: number;
  completedSegments: number;
  currentSegment: number | null;
  /** Estimated seconds remaining as of `updatedAt`; null when it cannot be estimated yet. */
  etaSeconds: number | null;
  statusDetail: string | null;
  retryCount: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost so far; null when a request had no configured price. */
  costUsd: number | null;
  error: { code: string; message: string; stage: string | null } | null;
  cancelRequested: boolean;
  /** True when a finished translation can be downloaded. */
  hasOutput: boolean;
  /** The job finished by reusing a cached translation (no AI request was made). */
  cacheHit: boolean;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  /** Seconds from start to completion, or to `updatedAt` while running. */
  elapsedSeconds: number | null;
}

export function toJobView(job: TranslationJob): JobView {
  const end = job.completedAt ?? job.updatedAt;
  let usedModels: JobView['usedModels'] = [];
  if (job.usedModels) {
    try {
      usedModels = JSON.parse(job.usedModels) as JobView['usedModels'];
    } catch {
      usedModels = [];
    }
  }
  return {
    id: job.id,
    state: job.state as JobState,
    origin: job.origin,
    attempt: job.attempt,
    mediaTitle: job.mediaTitle,
    mediaType: job.mediaType,
    imdbId: job.imdbId,
    season: job.season,
    episode: job.episode,
    sourceName: job.sourceName,
    sourceLanguage: job.sourceLanguage,
    targetLanguage: job.targetLanguage,
    targetScript: job.targetScript,
    profile: job.profile,
    provider: job.provider,
    model: job.model,
    usedModels,
    percentage: job.percentage,
    totalEntries: job.totalEntries,
    completedEntries: job.completedEntries,
    totalSegments: job.totalSegments,
    completedSegments: job.completedSegments,
    currentSegment: job.currentSegment,
    etaSeconds: job.etaSeconds,
    statusDetail: job.statusDetail,
    retryCount: job.retryCount,
    inputTokens: job.inputTokens,
    outputTokens: job.outputTokens,
    costUsd: job.costKnown ? Math.round(job.costUsd * 1e6) / 1e6 : null,
    error: job.errorCode
      ? { code: job.errorCode, message: job.errorMessage ?? '', stage: job.errorStage }
      : null,
    cancelRequested: job.cancelRequested,
    hasOutput: job.state === 'completed' && job.outputFile !== null,
    cacheHit: job.cacheHit,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
    elapsedSeconds: job.startedAt
      ? Math.max(0, Math.round((end.getTime() - job.startedAt.getTime()) / 1000))
      : null,
  };
}

export type NotificationKind = 'completed' | 'failed';

export interface NotificationView {
  id: string;
  jobId: string;
  kind: NotificationKind;
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
}

export function toNotificationView(n: Notification): NotificationView {
  return {
    id: n.id,
    jobId: n.jobId,
    kind: n.kind as NotificationKind,
    title: n.title,
    message: n.message,
    createdAt: n.createdAt.toISOString(),
    read: n.readAt !== null,
  };
}

/** Event types written to the job event log and sent over SSE. */
export type JobEventType =
  | 'job.created'
  | 'job.updated'
  | 'job.completed'
  | 'job.failed'
  | 'job.cancelled'
  | 'notification.created'
  | 'notification.read';
