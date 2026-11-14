import { APP_NAME, APP_VERSION, type ServiceName } from './version.js';

/** Liveness payload: the process is up and able to answer HTTP. */
export interface LivenessReport {
  status: 'ok';
  app: typeof APP_NAME;
  service: ServiceName;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export type CheckStatus = 'ok' | 'degraded' | 'fail';

export interface ReadinessCheck {
  status: CheckStatus;
  detail?: string;
}

/** Readiness payload: the process can actually do its job (database, storage, ...). */
export interface ReadinessReport {
  status: CheckStatus;
  service: ServiceName;
  version: string;
  timestamp: string;
  checks: Record<string, ReadinessCheck>;
}

export function buildLiveness(
  service: ServiceName,
  startedAt: Date,
  now = new Date(),
): LivenessReport {
  return {
    status: 'ok',
    app: APP_NAME,
    service,
    version: APP_VERSION,
    uptimeSeconds: Math.max(0, Math.round((now.getTime() - startedAt.getTime()) / 1000)),
    timestamp: now.toISOString(),
  };
}

/**
 * Combine individual checks into one readiness report.
 * Any `fail` makes the report `fail`; otherwise any `degraded` makes it `degraded`.
 */
export function buildReadiness(
  service: ServiceName,
  checks: Record<string, ReadinessCheck>,
  now = new Date(),
): ReadinessReport {
  const statuses = Object.values(checks).map((c) => c.status);
  const status: CheckStatus = statuses.includes('fail')
    ? 'fail'
    : statuses.includes('degraded')
      ? 'degraded'
      : 'ok';
  return { status, service, version: APP_VERSION, timestamp: now.toISOString(), checks };
}
