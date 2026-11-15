import { useEffect, useState } from 'react';
import { fetchReadiness, type HealthState } from './health';

export function SystemStatus() {
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
