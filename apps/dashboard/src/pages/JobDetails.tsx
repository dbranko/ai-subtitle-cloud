import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, isActive, withToken, type Job, type TimelineEntry } from '../api';
import { useJobAction } from '../JobCard';
import { errorMessage, formatCost, formatDuration, formatTime, stateLabel } from '../format';

const KIND_TEXT: Record<string, string> = {
  'job.created': 'Created',
  'job.state': '',
  'job.detail': '',
  'job.completed': 'Completed',
  'job.failed': 'Failed',
  'job.cancelled': 'Cancelled',
  notification: 'Notification',
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/**
 * Everything known about one job, and what happened to it. `liveJob` is the
 * live (SSE) copy when the job is in the dashboard's state; otherwise the job
 * is loaded once (older jobs from the history).
 */
export function JobDetails({
  id,
  liveJob,
  now,
  onMessage,
}: {
  id: string;
  liveJob: Job | undefined;
  now: number;
  onMessage: (m: string) => void;
}) {
  const [loaded, setLoaded] = useState<Job | null>(null);
  const [missing, setMissing] = useState(false);
  const [timeline, setTimeline] = useState<{ entries: TimelineEntry[]; truncated: boolean } | null>(
    null,
  );
  const { busy, act } = useJobAction(onMessage);
  const job = liveJob ?? loaded;

  useEffect(() => {
    let stale = false;
    setMissing(false);
    api
      .job(id)
      .then((r) => !stale && setLoaded(r.job))
      .catch((err: unknown) => {
        if (stale) return;
        if (err instanceof ApiError && err.status === 404) setMissing(true);
        else onMessage(errorMessage(err, 'Could not load the job.'));
      });
    return () => {
      stale = true;
    };
  }, [id, onMessage]);

  // The timeline changes only with the state, the attempt or the status detail.
  const timelineKey = job ? `${job.state}|${job.attempt}|${job.statusDetail ?? ''}` : '';
  useEffect(() => {
    if (!timelineKey) return;
    let stale = false;
    api
      .timeline(id)
      .then((r) => !stale && setTimeline(r))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [id, timelineKey]);

  if (missing) {
    return (
      <section className="card" data-testid="job-details">
        <h2>Job not found</h2>
        <p className="muted">
          It may have been removed. <a href="#/history">Back to history</a>
        </p>
      </section>
    );
  }
  if (!job) return <p className="muted">Loading…</p>;

  const active = isActive(job);
  const elapsed =
    job.startedAt === null
      ? null
      : active
        ? (now - Date.parse(job.startedAt)) / 1000
        : job.elapsedSeconds;
  const models =
    job.usedModels.length > 0 ? job.usedModels : [{ provider: job.provider, model: job.model }];
  const media =
    job.mediaType === 'series' && job.season !== null && job.episode !== null
      ? `Series, S${String(job.season).padStart(2, '0')}E${String(job.episode).padStart(2, '0')}`
      : (job.mediaType ?? 'uploaded file');

  return (
    <section className="card" data-testid="job-details" data-state={job.state}>
      <p className="small">
        <a href="#/">← Overview</a> · <a href="#/history">History</a>
      </p>
      <div className="card-head">
        <h2 data-testid="details-title">{job.mediaTitle}</h2>
        <span className={`state state-${job.state}`} data-testid="details-state">
          {job.cancelRequested && active ? 'Cancelling…' : stateLabel(job.state)}
        </span>
      </div>

      {active && (
        <div
          className="bar"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={job.percentage}
        >
          <div className="bar-fill" style={{ width: `${job.percentage}%` }} />
        </div>
      )}
      {job.statusDetail && <p className="detail">{job.statusDetail}</p>}
      {job.error && (
        <p className="error" data-testid="details-error">
          <strong>{job.error.code}</strong>
          {job.error.stage ? ` (while ${stateLabel(job.error.stage)})` : ''}: {job.error.message}
        </p>
      )}

      <dl className="facts">
        <Fact label="Media">{media}</Fact>
        <Fact label="IMDb">{job.imdbId ?? '–'}</Fact>
        <Fact label="Source subtitle">{job.sourceName ?? '–'}</Fact>
        <Fact label="Languages">
          {job.sourceLanguage ?? 'auto'} → {job.targetLanguage} ({job.targetScript})
        </Fact>
        <Fact label="Profile">{job.profile}</Fact>
        <Fact label="Requested by">{job.origin === 'stremio' ? 'Stremio' : 'dashboard'}</Fact>
        <Fact label="Models">{models.map((m) => `${m.provider} / ${m.model}`).join(', ')}</Fact>
        <Fact label="Progress">
          <span data-testid="details-percentage">{job.percentage.toFixed(1)}%</span>
        </Fact>
        <Fact label="Segments">
          {job.completedSegments} / {job.totalSegments || '–'}
        </Fact>
        <Fact label="Subtitles">
          {job.completedEntries} / {job.totalEntries}
        </Fact>
        <Fact label="Retries">{job.retryCount}</Fact>
        <Fact label="Run">{job.attempt}</Fact>
        <Fact label="Tokens (in / out)">
          {job.inputTokens.toLocaleString()} / {job.outputTokens.toLocaleString()}
        </Fact>
        <Fact label="Cost">{formatCost(job.costUsd)}</Fact>
        <Fact label="Created">{formatTime(job.createdAt)}</Fact>
        <Fact label="Started">{formatTime(job.startedAt)}</Fact>
        <Fact label="Finished">{formatTime(job.completedAt)}</Fact>
        <Fact label="Duration">{elapsed === null ? '–' : formatDuration(elapsed)}</Fact>
        <Fact label="Cache">
          {job.cacheHit ? 'reused an existing translation' : 'new translation'}
        </Fact>
        <Fact label="Job id">
          <code className="small">{job.id}</code>
        </Fact>
      </dl>

      <div className="actions">
        {active && (
          <button
            disabled={busy || job.cancelRequested}
            onClick={() => void act(() => api.cancelJob(job.id))}
          >
            Cancel
          </button>
        )}
        {job.state === 'failed' && (
          <button
            disabled={busy}
            data-testid="details-retry"
            onClick={() =>
              void act(async () => {
                const r = await api.retryJob(job.id);
                setLoaded(r.job);
              })
            }
          >
            Retry
          </button>
        )}
        {job.hasOutput && (
          <a
            className="button primary"
            href={withToken(`/api/v1/jobs/${job.id}/download`)}
            data-testid="details-download"
          >
            Download SRT
          </a>
        )}
      </div>

      <h3>Timeline</h3>
      {timeline?.truncated && (
        <p className="muted small">Older events of this job were removed from the event log.</p>
      )}
      <ol className="timeline" data-testid="timeline">
        {(timeline?.entries ?? []).map((e) => (
          <li key={e.id} data-kind={e.kind} className={`tl-${e.kind.replace('.', '-')}`}>
            <span className="muted small">{new Date(e.at).toLocaleTimeString()}</span>{' '}
            <strong>
              {KIND_TEXT[e.kind] || (e.state ? stateLabel(e.state) : e.kind)}
              {e.kind === 'job.state' &&
                e.attempt !== null &&
                e.attempt > 1 &&
                ` (run ${e.attempt})`}
            </strong>
            {e.detail && <span> — {e.detail}</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}
