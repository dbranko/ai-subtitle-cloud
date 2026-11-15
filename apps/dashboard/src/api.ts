// Types mirror the server's JobView / NotificationView / Snapshot (packages/jobs/src/view.ts).
// They are repeated here so the browser bundle never imports server-side packages.

export type JobState =
  | 'queued'
  | 'locating_source'
  | 'downloading_source'
  | 'parsing'
  | 'preparing_context'
  | 'translating'
  | 'validating'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Job {
  id: string;
  state: JobState;
  attempt: number;
  mediaTitle: string;
  mediaType: string | null;
  imdbId: string | null;
  season: number | null;
  episode: number | null;
  sourceName: string | null;
  sourceLanguage: string | null;
  targetLanguage: string;
  targetScript: string;
  profile: string;
  origin: string;
  provider: string;
  model: string;
  usedModels: { provider: string; model: string }[];
  percentage: number;
  totalEntries: number;
  completedEntries: number;
  totalSegments: number;
  completedSegments: number;
  currentSegment: number | null;
  etaSeconds: number | null;
  statusDetail: string | null;
  retryCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  error: { code: string; message: string; stage: string | null } | null;
  cancelRequested: boolean;
  hasOutput: boolean;
  cacheHit: boolean;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  elapsedSeconds: number | null;
}

export interface AppNotification {
  id: string;
  jobId: string;
  kind: 'completed' | 'failed';
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
}

export interface Snapshot {
  lastEventId: number;
  serverTime: string;
  jobs: Job[];
  notifications: AppNotification[];
}

export interface Meta {
  targetLanguages: { id: string; name: string; nativeName: string }[];
  sourceLanguages: { id: string; name: string; nativeName: string }[];
  profiles: { id: string; name: string; description: string }[];
  providers: {
    id: string;
    name: string;
    configured: boolean;
    defaultModel: string;
    suggestedModels: { id: string; note: string }[];
    isPreferred: boolean;
  }[];
  defaults: { provider: string; model: string | null; profile: string };
  sources: { id: string; name: string; configured: boolean }[];
  defaultSourceLanguages: string[];
  mockAi: boolean;
  maxUploadBytes: number;
}

export const ACTIVE_STATES: JobState[] = [
  'queued',
  'locating_source',
  'downloading_source',
  'parsing',
  'preparing_context',
  'translating',
  'validating',
  'saving',
];
export const isActive = (job: Job) => ACTIVE_STATES.includes(job.state);

// --- Access token -------------------------------------------------------------
// Only needed when the server has AUTH_TOKEN configured. It can be supplied once
// in the address (…/?token=…); it is then kept in this browser and removed from the URL.
const TOKEN_KEY = 'asc.token';

export function initToken(): void {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.toString());
  }
}
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (token: string) => localStorage.setItem(TOKEN_KEY, token.trim());

/** Append the token to a URL the browser requests itself (EventSource, download link). */
export function withToken(path: string): string {
  const token = getToken();
  if (!token) return path;
  return `${path}${path.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.error ?? 'error',
      data.message ?? `Request failed (${res.status}).`,
    );
  }
  return data as T;
}

export interface NewJob {
  contentBase64: string;
  fileName: string;
  title?: string;
  sourceLanguage?: string;
  targetLanguage: string;
  profile?: string;
  customInstructions?: string;
  provider?: string;
  model?: string;
  force?: boolean;
}

export interface StremioInfo {
  manifestUrl: string;
  installUrl: string;
  reachable: 'this-computer' | 'https' | 'unsupported';
  targetLanguages: string[];
  dailyJobLimit: number;
  startedLast24h: number;
  sourceConfigured: boolean;
}

export interface NewMediaJob {
  media: {
    type: 'movie' | 'series';
    imdbId: string;
    title?: string;
    season?: number;
    episode?: number;
  };
  targetLanguage: string;
  profile?: string;
}

export interface SecretStatus {
  configured: boolean;
  source: 'settings' | 'environment' | null;
  hint: string | null;
}

export type ProviderId = 'anthropic' | 'openai' | 'gemini';

export interface Settings {
  ai: {
    provider: ProviderId;
    model: string | null;
    fallbackProvider: ProviderId | null;
    fallbackModel: string | null;
    effort: string;
    temperature: number | null;
    maxSegmentEntries: number;
    translationProfile: string;
  };
  apiKeys: Record<ProviderId, SecretStatus>;
  sources: {
    languages: string[];
    openSubtitles: { apiKey: SecretStatus; username: string | null; password: SecretStatus };
  };
  cache: {
    maxAgeDays: number;
    maxSizeMb: number;
    cacheDirectory: string;
    subtitlesDirectory: string;
  };
  stremio: {
    targetLanguages: string[];
    dailyJobLimit: number;
    profile: string;
    languageLabels: Record<string, string>;
  };
  defaults: { targetLanguage: string; customInstructions: string };
  mockAi: boolean;
}

export type SecretName = ProviderId | 'opensubtitles' | 'opensubtitlesPassword';

/** A change: only the parts that are sent are changed. A secret is set (string) or removed (null). */
export interface SettingsPatch {
  ai?: Partial<Settings['ai']>;
  sources?: { languages?: string[]; openSubtitlesUsername?: string | null };
  cache?: { maxAgeDays?: number; maxSizeMb?: number };
  stremio?: Partial<Settings['stremio']>;
  defaults?: Partial<Settings['defaults']>;
  secrets?: Partial<Record<SecretName, string | null>>;
}

export interface TimelineEntry {
  id: number;
  at: string;
  kind: string;
  state: JobState | null;
  attempt: number | null;
  percentage: number | null;
  detail: string | null;
}

export interface ActivityItem {
  id: number;
  type: string;
  at: string;
  jobId: string;
  title: string;
  targetLanguage: string;
  origin: string;
}

export interface CacheInfo {
  translations: number;
  translationBytes: number;
  sources: number;
  sourceBytes: number;
  oldestUse: string | null;
  limits: { maxAgeDays: number; maxSizeMb: number };
}

export interface JobQuery {
  scope?: 'active' | 'finished' | 'all';
  status?: 'completed' | 'failed' | 'cancelled';
  limit?: number;
  offset?: number;
}

export const api = {
  job: (id: string) => request<{ job: Job }>('GET', `/api/v1/jobs/${encodeURIComponent(id)}`),
  jobs: (query: JobQuery) => {
    const params = new URLSearchParams(
      Object.entries(query)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    return request<{ jobs: Job[]; total: number }>('GET', `/api/v1/jobs?${params.toString()}`);
  },
  timeline: (id: string) =>
    request<{ entries: TimelineEntry[]; truncated: boolean }>(
      'GET',
      `/api/v1/jobs/${encodeURIComponent(id)}/events`,
    ),
  activity: (limit = 15) =>
    request<{ activity: ActivityItem[] }>('GET', `/api/v1/activity?limit=${limit}`),
  settings: () => request<Settings>('GET', '/api/v1/settings'),
  saveSettings: (patch: SettingsPatch) => request<Settings>('PUT', '/api/v1/settings', patch),
  cache: () => request<CacheInfo>('GET', '/api/v1/cache'),
  cleanupCache: () =>
    request<{ translationsRemoved: number; sourcesRemoved: number; bytesFreed: number }>(
      'POST',
      '/api/v1/cache/cleanup',
      {},
    ),
  stremio: () => request<StremioInfo>('GET', '/api/v1/stremio'),
  createMediaJob: (job: NewMediaJob) =>
    request<{ status: 'cached' | 'active' | 'created' | 'failed'; job: Job | null }>(
      'POST',
      '/api/v1/jobs/from-media',
      job,
    ),
  meta: () => request<Meta>('GET', '/api/v1/meta'),
  createJob: (job: NewJob) =>
    request<{ job: Job; created: boolean; reason: 'created' | 'active' | 'completed' }>(
      'POST',
      '/api/v1/jobs',
      job,
    ),
  cancelJob: (id: string) => request<{ job: Job }>('POST', `/api/v1/jobs/${id}/cancel`),
  retryJob: (id: string) => request<{ job: Job }>('POST', `/api/v1/jobs/${id}/retry`),
  markRead: (id: string) => request<unknown>('POST', `/api/v1/notifications/${id}/read`),
  markAllRead: () => request<unknown>('POST', '/api/v1/notifications/read-all'),
};

/** Read a file as base64 without assuming its text encoding (the server decodes it). */
export async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
