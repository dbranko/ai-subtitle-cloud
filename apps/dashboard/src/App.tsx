import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  fileToBase64,
  getToken,
  isActive,
  setToken,
  withToken,
  type AppNotification,
  type Job,
  type JobState,
  type Meta,
} from './api';
import { fetchReadiness, type HealthState } from './health';
import {
  alertUser,
  desktopEnabled,
  desktopSupported,
  disableDesktop,
  enableDesktop,
  setSound,
  soundEnabled,
} from './notify';
import { useLiveState, type Connection } from './useLiveState';

const STATE_LABEL: Record<JobState, string> = {
  queued: 'Waiting in queue',
  locating_source: 'Locating source subtitle',
  downloading_source: 'Loading source subtitle',
  parsing: 'Reading subtitle',
  preparing_context: 'Preparing context',
  translating: 'Translating',
  validating: 'Validating',
  saving: 'Saving',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Re-render once a second so elapsed time and the countdown keep moving between events. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function ConnectionBadge({ connection }: { connection: Connection }) {
  const text = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' }[
    connection
  ];
  return (
    <span className={`conn conn-${connection}`} data-testid="connection" data-state={connection}>
      <span className="dot" aria-hidden="true" />
      {text}
    </span>
  );
}

function JobCard({ job, now, onError }: { job: Job; now: number; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const active = isActive(job);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

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
          <h3>{job.mediaTitle}</h3>
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
          <dd>{job.costUsd === null ? 'unknown' : `$${job.costUsd.toFixed(4)}`}</dd>
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
      </footer>
    </article>
  );
}

function NewJobForm({ meta, onMessage }: { meta: Meta; onMessage: (m: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState(() => localStorage.getItem('asc.target') ?? 'sr-Latn');
  const [source, setSource] = useState('');
  const [profile, setProfile] = useState(meta.defaults.profile);
  const [instructions, setInstructions] = useState('');
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const usable = meta.providers.filter((p) => p.configured);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    if (file.size > meta.maxUploadBytes) {
      onMessage(`The file is larger than ${Math.round(meta.maxUploadBytes / 1024)} KB.`);
      return;
    }
    setBusy(true);
    try {
      localStorage.setItem('asc.target', target);
      const result = await api.createJob({
        contentBase64: await fileToBase64(file),
        fileName: file.name,
        targetLanguage: target,
        profile,
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(source ? { sourceLanguage: source } : {}),
        ...(instructions.trim() ? { customInstructions: instructions.trim() } : {}),
        ...(provider ? { provider } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
      });
      onMessage(
        result.reason === 'created'
          ? 'Translation started.'
          : result.reason === 'active'
            ? 'This exact translation is already in progress — showing the existing job.'
            : 'This exact translation already exists — it is listed below, ready to download.',
      );
    } catch (err) {
      onMessage(err instanceof ApiError ? err.message : 'Could not start the translation.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={(e) => void submit(e)} data-testid="new-job">
      <h2>Translate a subtitle</h2>
      {meta.mockAi && (
        <p className="detail">
          Mock mode is on: translations are simulated, no AI provider is called and nothing is
          charged.
        </p>
      )}
      <label>
        Subtitle file (.srt)
        <input
          type="file"
          accept=".srt,text/plain,application/x-subrip"
          required
          data-testid="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <div className="row">
        <label>
          Translate into
          <select value={target} onChange={(e) => setTarget(e.target.value)} data-testid="target">
            {meta.targetLanguages.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Source language
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Detect automatically</option>
            {meta.sourceLanguages.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Profile
          <select value={profile} onChange={(e) => setProfile(e.target.value)}>
            {meta.profiles.map((p) => (
              <option key={p.id} value={p.id} title={p.description}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="row">
        <label>
          Title (optional)
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Movie or episode title"
          />
        </label>
        {!meta.mockAi && (
          <>
            <label>
              AI provider
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                <option value="">Default ({meta.defaults.provider})</option>
                {usable.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Model (optional)
              <input
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="provider default"
              />
            </label>
          </>
        )}
      </div>
      {(profile === 'custom' || instructions) && (
        <label>
          Style instructions{profile === 'custom' ? ' (required for the custom profile)' : ''}
          <textarea
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            rows={2}
          />
        </label>
      )}
      {profile !== 'custom' && !instructions && (
        <button type="button" className="link" onClick={() => setInstructions(' ')}>
          + add style instructions
        </button>
      )}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy || !file} data-testid="start">
          {busy ? 'Starting…' : 'Start translation'}
        </button>
      </div>
    </form>
  );
}

/** Translate a title without uploading anything: the job finds a source subtitle itself. */
function MediaJobForm({ meta, onMessage }: { meta: Meta; onMessage: (m: string) => void }) {
  const [type, setType] = useState<'movie' | 'series'>('movie');
  const [imdbId, setImdbId] = useState('');
  const [title, setTitle] = useState('');
  const [season, setSeason] = useState('1');
  const [episode, setEpisode] = useState('1');
  const [target, setTarget] = useState(() => localStorage.getItem('asc.target') ?? 'sr-Latn');
  const [busy, setBusy] = useState(false);
  const remote = meta.sources.some((s) => s.id !== 'library' && s.configured);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const result = await api.createMediaJob({
        media: {
          type,
          imdbId: imdbId.trim(),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(type === 'series' ? { season: Number(season), episode: Number(episode) } : {}),
        },
        targetLanguage: target,
      });
      onMessage(
        {
          created:
            'Looking for a source subtitle — the translation starts as soon as one is found.',
          active: 'This title is already being translated — showing the existing job.',
          cached: 'This title is already translated — it is listed below, ready to download.',
          failed: `A recent attempt for this title failed${result.job?.error ? `: ${result.job.error.message}` : '.'}`,
        }[result.status],
      );
    } catch (err) {
      onMessage(err instanceof ApiError ? err.message : 'Could not start the translation.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card form" onSubmit={(e) => void submit(e)} data-testid="media-job">
      <h2>Translate by IMDb ID</h2>
      <p className="muted small">
        Finds a source subtitle automatically
        {remote
          ? ` (your uploads first, then OpenSubtitles; source languages: ${meta.defaultSourceLanguages.join(', ')}).`
          : ' among your uploads. OpenSubtitles is not configured (OPENSUBTITLES_API_KEY).'}
      </p>
      <div className="row">
        <label>
          Type
          <select value={type} onChange={(e) => setType(e.target.value as 'movie' | 'series')}>
            <option value="movie">Movie</option>
            <option value="series">Series episode</option>
          </select>
        </label>
        <label>
          IMDb ID
          <input
            value={imdbId}
            onChange={(e) => setImdbId(e.target.value)}
            placeholder="tt0111161"
            pattern="tt\d{5,12}"
            required
            data-testid="imdb"
          />
        </label>
        {type === 'series' && (
          <>
            <label>
              Season
              <input
                type="number"
                min={0}
                value={season}
                onChange={(e) => setSeason(e.target.value)}
                required
              />
            </label>
            <label>
              Episode
              <input
                type="number"
                min={0}
                value={episode}
                onChange={(e) => setEpisode(e.target.value)}
                required
              />
            </label>
          </>
        )}
      </div>
      <div className="row">
        <label>
          Title (optional)
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Shown in the job list"
          />
        </label>
        <label>
          Translate into
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            {meta.targetLanguages.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="actions">
        <button
          type="submit"
          className="primary"
          disabled={busy || !imdbId.trim()}
          data-testid="start-media"
        >
          {busy ? 'Starting…' : 'Find subtitle and translate'}
        </button>
      </div>
    </form>
  );
}

function Notifications({
  items,
  onError,
}: {
  items: AppNotification[];
  onError: (m: string) => void;
}) {
  const [desktop, setDesktop] = useState(desktopEnabled);
  const [sound, setSoundState] = useState(soundEnabled);
  const run = (fn: () => Promise<unknown>) => void fn().catch(() => onError('Request failed.'));

  return (
    <section className="card" data-testid="notifications">
      <div className="card-head">
        <h2>
          Notifications{' '}
          {items.length > 0 && (
            <span className="count" data-testid="unread-count">
              {items.length}
            </span>
          )}
        </h2>
        {items.length > 0 && (
          <button className="link" onClick={() => run(api.markAllRead)}>
            Mark all read
          </button>
        )}
      </div>
      {items.length === 0 && <p className="muted">No unread notifications.</p>}
      <ul className="notes">
        {items.map((n) => (
          <li
            key={n.id}
            className={`note note-${n.kind}`}
            data-testid="notification"
            data-kind={n.kind}
          >
            <div>
              <strong>{n.title}</strong>
              <p>{n.message}</p>
              <p className="muted small">{new Date(n.createdAt).toLocaleString()}</p>
            </div>
            <button className="link" onClick={() => run(() => api.markRead(n.id))}>
              Dismiss
            </button>
          </li>
        ))}
      </ul>
      <div className="prefs">
        {desktopSupported() ? (
          desktop ? (
            <button
              className="link"
              onClick={() => {
                disableDesktop();
                setDesktop(false);
              }}
            >
              Desktop notifications: on (turn off)
            </button>
          ) : (
            <button
              data-testid="enable-desktop"
              onClick={() =>
                void enableDesktop().then((ok) => {
                  setDesktop(ok);
                  if (!ok) onError('The browser did not allow notifications.');
                })
              }
            >
              Enable desktop notifications
            </button>
          )
        ) : (
          <span className="muted small">This browser does not support desktop notifications.</span>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={sound}
            onChange={(e) => {
              setSound(e.target.checked);
              setSoundState(e.target.checked);
            }}
          />
          Play a sound
        </label>
      </div>
    </section>
  );
}

function SystemStatus() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    const refresh = () =>
      void fetchReadiness(controller.signal).then((s) => {
        if (!controller.signal.aborted) setHealth(s);
      });
    refresh();
    const timer = setInterval(refresh, 10_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);
  if (health.kind !== 'loaded') {
    return (
      <p className="muted small">
        {health.kind === 'loading' ? 'Checking system…' : 'API not reachable.'}
      </p>
    );
  }
  return (
    <p className="muted small" data-testid="system-status">
      System v{health.report.version}:{' '}
      {Object.entries(health.report.checks)
        .map(
          ([name, check]) => `${name} ${check.status}${check.detail ? ` (${check.detail})` : ''}`,
        )
        .join(' · ')}
    </p>
  );
}

export function App() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [message, setMessage] = useState('');
  const onNewNotification = useCallback((n: AppNotification) => alertUser(n), []);
  const live = useLiveState({ onNewNotification });

  useEffect(() => {
    api
      .meta()
      .then(setMeta)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setNeedsToken(true);
        else setMessage('The API is not reachable. Is it running?');
      });
  }, []);

  const jobs = useMemo(() => Object.values(live.jobs), [live.jobs]);
  const active = jobs.filter(isActive).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const finished = jobs
    .filter((j) => !isActive(j))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const now = useNow(active.length > 0) + live.clockOffsetMs;

  if (needsToken) {
    return (
      <main className="page">
        <h1>AI Subtitle Cloud</h1>
        <form
          className="card form"
          onSubmit={(e) => {
            e.preventDefault();
            const value = new FormData(e.currentTarget).get('token');
            setToken(typeof value === 'string' ? value : '');
            window.location.reload();
          }}
        >
          <h2>Access token required</h2>
          <label>
            Token (AUTH_TOKEN from the server configuration)
            <input name="token" type="password" defaultValue={getToken()} required autoFocus />
          </label>
          <div className="actions">
            <button className="primary" type="submit">
              Continue
            </button>
          </div>
        </form>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>AI Subtitle Cloud</h1>
          <p className="muted">Translation jobs and live progress</p>
        </div>
        <ConnectionBadge connection={live.connection} />
      </header>

      {message && (
        <p className="banner" role="status" data-testid="message">
          {message}
          <button className="link" onClick={() => setMessage('')} aria-label="Dismiss message">
            ×
          </button>
        </p>
      )}

      {meta && <NewJobForm meta={meta} onMessage={setMessage} />}
      {meta && <MediaJobForm meta={meta} onMessage={setMessage} />}

      <section data-testid="active-jobs">
        <h2>
          Active translations {active.length > 0 && <span className="count">{active.length}</span>}
        </h2>
        {!live.loaded && <p className="muted">Loading…</p>}
        {live.loaded && active.length === 0 && (
          <p className="muted">Nothing is being translated right now.</p>
        )}
        {active.map((job) => (
          <JobCard key={job.id} job={job} now={now} onError={setMessage} />
        ))}
      </section>

      <Notifications items={live.notifications} onError={setMessage} />

      <section data-testid="finished-jobs">
        <h2>Recent</h2>
        {live.loaded && finished.length === 0 && (
          <p className="muted">No finished translations yet.</p>
        )}
        {finished.map((job) => (
          <JobCard key={job.id} job={job} now={now} onError={setMessage} />
        ))}
      </section>

      <SystemStatus />
    </main>
  );
}
