// Mirrors the readiness payload of @asc/shared. Kept local so the browser
// bundle never imports server-side packages.
export type CheckStatus = 'ok' | 'degraded' | 'fail';

export interface ReadinessReport {
  status: CheckStatus;
  service: string;
  version: string;
  timestamp: string;
  checks: Record<string, { status: CheckStatus; detail?: string }>;
}

export type HealthState =
  { kind: 'loading' } | { kind: 'unreachable' } | { kind: 'loaded'; report: ReadinessReport };

export async function fetchReadiness(signal?: AbortSignal): Promise<HealthState> {
  try {
    // 503 still carries a readiness report describing what failed.
    const res = await fetch('/health/ready', { signal, headers: { accept: 'application/json' } });
    const report = (await res.json()) as ReadinessReport;
    return { kind: 'loaded', report };
  } catch {
    return { kind: 'unreachable' };
  }
}
