import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  fileToBase64,
  type ActivityItem,
  type AppNotification,
  type Job,
  type Meta,
  type Settings,
  type StremioInfo,
} from '../api';
import { JobCard } from '../JobCard';
import { formatTime } from '../format';
import {
  desktopEnabled,
  desktopSupported,
  disableDesktop,
  enableDesktop,
  setSound,
  soundEnabled,
} from '../notify';
import { jobHref } from '../router';

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

/** How to connect Stremio, and what the add-on will do when Stremio asks for subtitles. */
function StremioCard() {
  const [info, setInfo] = useState<StremioInfo | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    api
      .stremio()
      .then(setInfo)
      .catch(() => undefined);
  }, []);
  if (!info) return null;
  return (
    <section className="card" data-testid="stremio">
      <h2>Stremio</h2>
      <p>
        Languages: <strong>{info.targetLanguages.join(', ') || 'none configured'}</strong> ·
        translation starts only <strong>when you pick “AI translate” in the subtitle menu</strong>
        {info.dailyJobLimit > 0 && (
          <>
            {' '}
            · started in the last 24 h: {info.startedLast24h} / {info.dailyJobLimit}
          </>
        )}
      </p>
      {info.reachable === 'unsupported' && (
        <p className="error">
          Stremio only loads add-ons from 127.0.0.1 or over HTTPS. Set ADDON_PUBLIC_URL to an HTTPS
          address.
        </p>
      )}
      {!info.sourceConfigured && (
        <p className="detail">
          No subtitle source is configured (OPENSUBTITLES_API_KEY), so only titles you uploaded a
          subtitle for can be translated from Stremio.
        </p>
      )}
      <p className="muted small">Add-on address:</p>
      <p>
        <code data-testid="manifest-url">{info.manifestUrl}</code>
      </p>
      <div className="actions">
        <a className="button primary" href={info.installUrl}>
          Install in Stremio
        </a>
        <button
          onClick={() =>
            void navigator.clipboard.writeText(info.manifestUrl).then(
              () => setCopied(true),
              () => setCopied(false),
            )
          }
        >
          {copied ? 'Copied' : 'Copy address'}
        </button>
      </div>
      <p className="muted small">
        Stremio cannot show translation progress. Pick “AI translate” for a language in Stremio's
        subtitle menu: the translation starts in the background and appears here; once it is
        finished, reopen the video in Stremio and pick the subtitle.
      </p>
    </section>
  );
}

const ACTIVITY_TEXT: Record<string, string> = {
  'job.created': 'started',
  'job.completed': 'completed',
  'job.failed': 'failed',
  'job.cancelled': 'cancelled',
};

function Activity({ refreshKey }: { refreshKey: string }) {
  const [items, setItems] = useState<ActivityItem[] | null>(null);
  useEffect(() => {
    let stale = false;
    api
      .activity()
      .then((r) => !stale && setItems(r.activity))
      .catch(() => undefined);
    return () => {
      stale = true;
    };
  }, [refreshKey]);
  return (
    <section className="card" data-testid="activity">
      <h2>Recent activity</h2>
      {items !== null && items.length === 0 && <p className="muted">Nothing has happened yet.</p>}
      <ul className="activity">
        {(items ?? []).map((a) => (
          <li key={a.id} className={`activity-${a.type.replace('job.', '')}`}>
            <span className="muted small">{formatTime(a.at)}</span>{' '}
            <a href={jobHref(a.jobId)}>{a.title}</a> → {a.targetLanguage}{' '}
            <strong>{ACTIVITY_TEXT[a.type] ?? a.type}</strong>
            {a.origin === 'stremio' && <span className="muted small"> · from Stremio</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function AiSummary({ settings, meta }: { settings: Settings | null; meta: Meta }) {
  const ai = settings?.ai;
  const provider = ai?.provider ?? meta.defaults.provider;
  const info = meta.providers.find((p) => p.id === provider);
  const fallback = ai?.fallbackProvider
    ? `${ai.fallbackProvider} / ${ai.fallbackModel ?? 'default model'}`
    : 'none';
  return (
    <section className="card summary" data-testid="ai-summary">
      <div>
        <span className="muted small">AI provider</span>
        <strong data-testid="ai-provider">
          {meta.mockAi ? 'mock (simulated)' : (info?.name ?? provider)}
        </strong>
      </div>
      <div>
        <span className="muted small">Model</span>
        <strong data-testid="ai-model">
          {ai?.model ?? meta.defaults.model ?? info?.defaultModel ?? 'provider default'}
        </strong>
      </div>
      <div>
        <span className="muted small">Fallback</span>
        <strong>{fallback}</strong>
      </div>
      <div>
        <span className="muted small">API key</span>
        <strong>{meta.mockAi ? 'not needed' : info?.configured ? 'configured' : 'missing'}</strong>
      </div>
      <a href="#/settings" className="small">
        Change in Settings
      </a>
    </section>
  );
}

export function Overview(props: {
  meta: Meta | null;
  settings: Settings | null;
  loaded: boolean;
  active: Job[];
  finished: Job[];
  notifications: AppNotification[];
  now: number;
  onMessage: (m: string) => void;
}) {
  const { meta, settings, loaded, active, finished, notifications, now, onMessage } = props;
  const recent = finished.slice(0, 10);
  const failed = finished.filter((j) => j.state === 'failed').length;
  // Refresh the activity list whenever a job starts or finishes.
  const activityKey = `${active.map((j) => j.id).join()}|${finished.length}|${finished[0]?.id ?? ''}`;

  return (
    <>
      {meta && <AiSummary meta={meta} settings={settings} />}
      {meta && <NewJobForm meta={meta} onMessage={onMessage} />}
      {meta && <MediaJobForm meta={meta} onMessage={onMessage} />}

      <section data-testid="active-jobs">
        <h2>
          Active translations {active.length > 0 && <span className="count">{active.length}</span>}
        </h2>
        {!loaded && <p className="muted">Loading…</p>}
        {loaded && active.length === 0 && (
          <p className="muted">Nothing is being translated right now.</p>
        )}
        {active.map((job) => (
          <JobCard key={job.id} job={job} now={now} onError={onMessage} />
        ))}
      </section>

      <Notifications items={notifications} onError={onMessage} />

      <StremioCard />

      <section data-testid="finished-jobs">
        <div className="card-head">
          <h2>
            Recent{' '}
            {failed > 0 && (
              <span className="count count-failed" data-testid="failed-count">
                {failed} failed
              </span>
            )}
          </h2>
          <a href="#/history">All history →</a>
        </div>
        {loaded && recent.length === 0 && <p className="muted">No finished translations yet.</p>}
        {recent.map((job) => (
          <JobCard key={job.id} job={job} now={now} onError={onMessage} />
        ))}
      </section>

      <Activity refreshKey={activityKey} />
    </>
  );
}
