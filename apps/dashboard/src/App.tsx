import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  api,
  ApiError,
  getToken,
  isActive,
  setToken,
  type AppNotification,
  type Meta,
  type Settings,
} from './api';
import { useNow } from './format';
import { alertUser } from './notify';
import { History } from './pages/History';
import { JobDetails } from './pages/JobDetails';
import { Overview } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { useRoute, type Route } from './router';
import { SystemStatus } from './system';
import { useLiveState, type Connection } from './useLiveState';

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

const NAV: { page: Route['page']; href: string; label: string }[] = [
  { page: 'overview', href: '#/', label: 'Overview' },
  { page: 'history', href: '#/history', label: 'History' },
  { page: 'settings', href: '#/settings', label: 'Settings' },
];

function TokenForm() {
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

export function App() {
  const route = useRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [message, setMessage] = useState('');
  const onNewNotification = useCallback((n: AppNotification) => alertUser(n), []);
  const live = useLiveState({ onNewNotification });

  const loadMeta = useCallback(() => {
    api
      .meta()
      .then(setMeta)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) setNeedsToken(true);
        else setMessage('The API is not reachable. Is it running?');
      });
    api
      .settings()
      .then(setSettings)
      .catch(() => undefined);
  }, []);
  useEffect(loadMeta, [loadMeta]);

  const jobs = useMemo(() => Object.values(live.jobs), [live.jobs]);
  const active = jobs.filter(isActive).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const finished = jobs
    .filter((j) => !isActive(j))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const now = useNow(active.length > 0) + live.clockOffsetMs;
  // Changes whenever a job finishes (or a finished job changes), so lists can refresh.
  const finishedKey = finished.map((j) => `${j.id}:${j.state}:${j.attempt}`).join();

  if (needsToken) return <TokenForm />;

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>AI Subtitle Cloud</h1>
          <nav className="nav" data-testid="nav">
            {NAV.map((n) => (
              <a
                key={n.page}
                href={n.href}
                className={route.page === n.page ? 'current' : undefined}
                aria-current={route.page === n.page ? 'page' : undefined}
              >
                {n.label}
                {n.page === 'overview' && active.length > 0 && (
                  <span className="count">{active.length}</span>
                )}
              </a>
            ))}
          </nav>
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

      {route.page === 'overview' && (
        <Overview
          meta={meta}
          settings={settings}
          loaded={live.loaded}
          active={active}
          finished={finished}
          notifications={live.notifications}
          now={now}
          onMessage={setMessage}
        />
      )}
      {route.page === 'history' && <History refreshKey={finishedKey} />}
      {route.page === 'job' && (
        <JobDetails
          key={route.id}
          id={route.id}
          liveJob={live.jobs[route.id]}
          now={now}
          onMessage={setMessage}
        />
      )}
      {route.page === 'settings' && (
        <SettingsPage
          meta={meta}
          onMessage={setMessage}
          onSaved={(s) => {
            setSettings(s);
            loadMeta();
          }}
        />
      )}

      <SystemStatus />
    </main>
  );
}
