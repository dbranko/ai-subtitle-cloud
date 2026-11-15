import { useEffect, useState } from 'react';
import type { JobState } from './api';

export const STATE_LABEL: Record<JobState, string> = {
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

export const stateLabel = (state: string): string => STATE_LABEL[state as JobState] ?? state;

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export const formatTime = (iso: string | null): string =>
  iso === null ? '–' : new Date(iso).toLocaleString();

export const formatCost = (usd: number | null): string =>
  usd === null ? 'unknown' : `$${usd.toFixed(4)}`;

/** Re-render once a second so elapsed time and the countdown keep moving between events. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export const errorMessage = (err: unknown, fallback = 'Request failed.'): string =>
  err instanceof Error && err.message ? err.message : fallback;
