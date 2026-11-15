import { useState } from 'react';
import { api, isActive, withToken, type Job, type JobState } from './api';
import { errorMessage, formatCost, formatDuration, STATE_LABEL } from './format';
import { jobHref } from './router';

/** Cancel / retry with a busy flag; errors go to onError. */
export function useJobAction(onError: (m: string) => void) {
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return { busy, act };
}

export function JobCard({
  job,
  now,
  onError,
}: {
  job: Job;
  now: number;
  onError: (m: string) => void;
}) {
  const { busy, act } = useJobAction(onError);
  const active = isActive(job);

  const elapsed =
    job.startedAt === null
      ? null
      : active
        ? (now - Date.parse(job.startedAt)) / 1000
        : job.elapsedSeconds;
  // The estimate was computed at `updatedAt`; count it down until the next update arrives.
  const eta =
    active && job.etaSeconds !== null
      ? Math.max(0, job.etaSeconds - (now - Date.parse(job.updatedAt)) / 1000)
      : null;
  const models =
    job.usedModels.length > 0 ? job.usedModels : [{ provider: job.provider, model: job.model }];

  return (
    <article
      className={`job job-${job.state}`}
      data-testid="job"
      data-job-id={job.id}
      data-state={job.state}
    >
      <header className="job-head">
        <div>
          <h3>
            <a href={jobHref(job.id)} data-testid="job-link">
              {job.mediaTitle}
            </a>
          </h3>
          <p className="muted small">
            {job.sourceLanguage ?? 'auto'} → {job.targetLanguage} · {job.profile} ·{' '}
            {models.map((m) => `${m.provider} / ${m.model}`).join(', ')}
          </p>
        </div>
        <span className={`state state-${job.state}`} data-testid="job-state">
          {job.cancelRequested && active ? 'Cancelling…' : STATE_LABEL[job.state]}
        </span>
      </header>

      <div
        className="bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={job.percentage}
        aria-label={`${job.mediaTitle} progress`}
      >
        <div className="bar-fill" style={{ width: `${job.percentage}%` }} />
      </div>

      <dl className="facts">
        <div>
          <dt>Progress</dt>
          <dd data-testid="job-percentage">{job.percentage.toFixed(1)}%</dd>
        </div>
        <div>
          <dt>Segments</dt>
          <dd data-testid="job-segments">
            {job.completedSegments} / {job.totalSegments || '–'}
          </dd>
        </div>
        <div>
          <dt>Subtitles</dt>
          <dd>
            {job.completedEntries} / {job.totalEntries}
          </dd>
        </div>
        <div>
          <dt>Current segment</dt>
          <dd>{job.currentSegment ?? '–'}</dd>
        </div>
        <div>
          <dt>Elapsed</dt>
          <dd>{elapsed === null ? '–' : formatDuration(elapsed)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{eta === null ? (active ? 'estimating…' : '–') : `~${formatDuration(eta)}`}</dd>
        </div>
        <div>
          <dt>Retries</dt>
          <dd>{job.retryCount}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>{formatCost(job.costUsd)}</dd>
        </div>
      </dl>

      {job.statusDetail && <p className="detail">{job.statusDetail}</p>}
      {job.error && (
        <p className="error" data-testid="job-error">
          <strong>{job.error.code}</strong>
          {job.error.stage
            ? ` (while ${STATE_LABEL[job.error.stage as JobState] ?? job.error.stage})`
            : ''}
          : {job.error.message}
        </p>
      )}

      <footer className="actions">
        {active && (
          <button
            disabled={busy || job.cancelRequested}
            onClick={() => void act(() => api.cancelJob(job.id))}
          >
            Cancel
          </button>
        )}
        {job.state === 'failed' && (
          <button disabled={busy} onClick={() => void act(() => api.retryJob(job.id))}>
            Retry
          </button>
        )}
        {job.hasOutput && (
          <a
            className="button primary"
            href={withToken(`/api/v1/jobs/${job.id}/download`)}
            data-testid="download"
          >
            Download SRT
          </a>
        )}
        {job.attempt > 1 && <span className="muted small">run {job.attempt}</span>}
        {job.cacheHit && <span className="muted small">reused from cache</span>}
        {job.origin === 'stremio' && <span className="muted small">requested by Stremio</span>}
      </footer>
    </article>
  );
}
