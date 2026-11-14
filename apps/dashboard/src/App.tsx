import { useEffect, useState } from 'react';
import { fetchReadiness, type CheckStatus, type HealthState } from './health';

const REFRESH_MS = 5000;

const LABEL: Record<CheckStatus, string> = { ok: 'OK', degraded: 'Degraded', fail: 'Failed' };

function StatusPill({ status }: { status: CheckStatus }) {
  return <span className={`pill pill-${status}`}>{LABEL[status]}</span>;
}

export function App() {
  const [health, setHealth] = useState<HealthState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    const refresh = () => {
      void fetchReadiness(controller.signal).then((state) => {
        if (!controller.signal.aborted) setHealth(state);
      });
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  return (
    <main className="page">
      <header>
        <h1>AI Subtitle Cloud</h1>
        <p className="muted">Personal edition · project foundation</p>
      </header>

      <section className="card" aria-live="polite">
        <h2>System status</h2>
        {health.kind === 'loading' && <p className="muted">Checking…</p>}
        {health.kind === 'unreachable' && (
          <p>
            <StatusPill status="fail" /> The API is not reachable. Start it with{' '}
            <code>pnpm dev</code>.
          </p>
        )}
        {health.kind === 'loaded' && (
          <>
            <p>
              <StatusPill status={health.report.status} /> API v{health.report.version}
            </p>
            <table>
              <tbody>
                {Object.entries(health.report.checks).map(([name, check]) => (
                  <tr key={name}>
                    <th scope="row">{name}</th>
                    <td>
                      <StatusPill status={check.status} />
                    </td>
                    <td className="muted">{check.detail ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>

      <p className="muted small">
        Translation jobs, live progress and settings arrive in later phases — see{' '}
        <code>docs/DEVELOPMENT_ROADMAP.md</code>.
      </p>
    </main>
  );
}
