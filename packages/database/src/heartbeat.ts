import type { Database } from './client.js';
import type { ServiceHeartbeat } from './generated/prisma/client.js';

export interface HeartbeatIdentity {
  service: string;
  /** Unique per process start; distinguishes a restarted process from the old one. */
  instanceId: string;
  pid: number;
  version: string;
  startedAt: Date;
}

/** Record that a service is alive right now. */
export async function recordHeartbeat(
  db: Database,
  identity: HeartbeatIdentity,
  now = new Date(),
): Promise<void> {
  const data = { ...identity, lastSeenAt: now };
  await db.serviceHeartbeat.upsert({
    where: { service: identity.service },
    create: data,
    update: data,
  });
}

export interface HeartbeatStatus {
  alive: boolean;
  heartbeat: ServiceHeartbeat | null;
  ageMs: number | null;
}

/** A service is considered alive when its last heartbeat is younger than `maxAgeMs`. */
export async function getHeartbeatStatus(
  db: Database,
  service: string,
  maxAgeMs: number,
  now = new Date(),
): Promise<HeartbeatStatus> {
  const heartbeat = await db.serviceHeartbeat.findUnique({ where: { service } });
  if (!heartbeat) return { alive: false, heartbeat: null, ageMs: null };
  const ageMs = now.getTime() - heartbeat.lastSeenAt.getTime();
  return { alive: ageMs <= maxAgeMs, heartbeat, ageMs };
}
