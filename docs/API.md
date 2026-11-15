# API

Base URL: the API process (`http://127.0.0.1:7001` by default). JSON everywhere.

## Authentication

Without `AUTH_TOKEN` (the default, localhost only) no credentials are needed. When
`AUTH_TOKEN` is configured, every `/api/*` route requires it, as
`Authorization: Bearer <token>` or as `?token=<token>` (for `EventSource` and download
links, which cannot send headers). Health endpoints stay open. The dashboard accepts the
token once in its address (`/?token=…`), keeps it in the browser and removes it from the URL.

API routes are rate-limited to 600 requests per minute per client address (the event stream
is exempt).

Without `AUTH_TOKEN` the API answers only to the host names in `ALLOWED_HOSTS` plus
`localhost`, `127.0.0.1`, `::1` and the hosts of the public URLs; changes (POST, PUT) sent by
a browser from another website are refused. Scripts and `curl` are unaffected. See
[SECURITY.md](SECURITY.md).

## Errors

```json
{ "error": "source_invalid", "message": "No subtitle entries found: …" }
```

| Status | `error`                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------- |
| 400    | `source_invalid`, `unsupported_language`, `invalid_request`, `provider_not_configured`, `too_large` |
| 401    | `unauthorized`                                                                                      |
| 403    | `host_not_allowed` (unknown Host without a token), `cross_site_request` (sent by another website)   |
| 404    | `not_found`                                                                                         |
| 409    | `conflict` (action not possible in the job's current state)                                         |
| 413    | `too_large`                                                                                         |
| 429    | `rate_limited`                                                                                      |
| 500    | `internal_error`                                                                                    |

## Jobs

### Create — `POST /api/v1/jobs`

Returns immediately; translation happens in the worker.

| Field                                      | Required | Meaning                                                                |
| ------------------------------------------ | -------- | ---------------------------------------------------------------------- |
| `contentBase64`                            | one of   | The subtitle file's bytes, base64. Any encoding; decoded on the server |
| `srt`                                      | one of   | The subtitle as text                                                   |
| `targetLanguage`                           | yes      | e.g. `sr-Latn`, `sr-Cyrl`, `hr`                                        |
| `sourceLanguage`                           | no       | Omit to detect. Also selects the legacy code page for non-UTF-8 files  |
| `fileName`, `title`                        | no       | Display only                                                           |
| `mediaType`, `imdbId`, `season`, `episode` | no       | Media context                                                          |
| `profile`                                  | no       | `natural` (default), `literal`, `cinematic`, `concise`, `custom`       |
| `customInstructions`                       | no       | Required for `custom`                                                  |
| `provider`, `model`                        | no       | Override the configured provider/model for this job                    |
| `force`                                    | no       | Translate again even if an identical finished translation exists       |

Response: `201` when a job was created, `200` when an existing one is returned.

```json
{ "job": { "…": "JobView" }, "created": false, "reason": "active" }
```

`reason`: `created`, `active` (identical job already queued or running), `completed`
(identical finished translation exists).

### Create from media — `POST /api/v1/jobs/from-media`

Translate a title without uploading a subtitle; the job finds a source itself. Returns
immediately. Safe to call repeatedly.

```json
{
  "media": {
    "type": "series",
    "imdbId": "tt0903747",
    "season": 2,
    "episode": 5,
    "title": "Breaking Bad",
    "videoHash": "abcdef0123456789",
    "fileName": "Breaking.Bad.S02E05.720p.BluRay.x264-GROUP.mkv"
  },
  "targetLanguage": "sr-Latn"
}
```

Optional: `profile`, `customInstructions`, `sourceLanguages`, `provider`, `model`, `force`,
and `source` (a candidate from the search endpoint, to use instead of searching).

Response (`201` when a job was created, otherwise `200`):

```json
{ "status": "created", "job": { "…": "JobView" }, "translation": null }
```

| `status`  | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `created` | A new job was queued                                                    |
| `active`  | A job for this request is already queued or running (`job`)             |
| `cached`  | A finished translation exists (`translation`, and `job` to download it) |
| `failed`  | A recent attempt failed and is not retried yet (`job.error`)            |

### Read

- `GET /api/v1/jobs?scope=active|finished|all&status=completed|failed|cancelled&limit=50&offset=0`
  → `{ "jobs": [JobView], "total": 123 }` — finished jobs newest first; `status` filters the
  history, `limit` (≤ 200) and `offset` page through it.
- `GET /api/v1/jobs/:id` → `{ "job": JobView }`
- `GET /api/v1/jobs/:id/events` → `{ "entries": [TimelineEntry], "truncated": false }` — what
  happened to the job, in order: `job.created`, every state change (`job.state`), every new
  status detail such as a rejected AI answer (`job.detail`), `job.completed` / `job.failed`
  (with the error message) / `job.cancelled`, and `notification`. Plain progress updates are
  folded away. `truncated` is true when the bounded event log no longer has the job's first
  events. Entry: `{ id, at, kind, state, attempt, percentage, detail }`.
- `GET /api/v1/activity?limit=20` → `{ "activity": [{ id, type, at, jobId, title,
targetLanguage, origin }] }` — jobs started, completed, failed or cancelled, newest first.

### Actions

- `POST /api/v1/jobs/:id/cancel` — queued jobs are cancelled at once; running jobs get
  `cancelRequested: true` and become `cancelled` when the worker acknowledges. `409` if the
  job is already finished.
- `POST /api/v1/jobs/:id/retry` — only for `failed` jobs; resumes from kept segments.
- `GET /api/v1/jobs/:id/download` — the translated SRT (`application/x-subrip`, UTF-8).
  `409` until the job is `completed`.

### JobView

```json
{
  "id": "0812fbbe-…",
  "state": "translating",
  "origin": "manual",
  "attempt": 1,
  "mediaTitle": "Harbor Lights",
  "mediaType": null,
  "imdbId": null,
  "season": null,
  "episode": null,
  "sourceName": "episode.srt",
  "sourceLanguage": "en",
  "targetLanguage": "sr-Latn",
  "targetScript": "Latn",
  "profile": "natural",
  "provider": "openai",
  "model": "gpt-6.1-sol",
  "usedModels": [],
  "percentage": 57.5,
  "totalEntries": 130,
  "completedEntries": 85,
  "totalSegments": 4,
  "completedSegments": 2,
  "currentSegment": 3,
  "etaSeconds": 21,
  "statusDetail": null,
  "retryCount": 0,
  "inputTokens": 3120,
  "outputTokens": 2890,
  "costUsd": 0.0351,
  "error": null,
  "cancelRequested": false,
  "hasOutput": false,
  "cacheHit": false,
  "createdAt": "…",
  "startedAt": "…",
  "updatedAt": "…",
  "completedAt": null,
  "elapsedSeconds": 34
}
```

`etaSeconds` is `null` until it can be estimated. `costUsd` is `null` when a model has no
configured price. `error` is `{ code, message, stage }` for failed jobs.

## Sources — `POST /api/v1/sources/search`

Manual mode: list source subtitles for a title, best match first.

```json
{
  "media": { "type": "movie", "imdbId": "tt0111161" },
  "languages": ["en"],
  "targetLanguage": "sr-Latn"
}
```

Returns `{ candidates: [...], failures: [...] }`. Each candidate has `source`, `id`,
`language`, `release`, `fileName`, `hashMatch`, quality flags, `score` and `reasons`. A
source that failed is listed in `failures` (`source_quota`, `source_auth`, …) without
failing the search. Pass a candidate as `source` to `POST /api/v1/jobs/from-media` to use it.

## Cache

- `GET /api/v1/cache` — counts and sizes of cached translations and stored sources, and the
  configured limits.
- `POST /api/v1/cache/cleanup` — run cleanup now; optional `{ "maxAgeDays": 30, "maxSizeMb": 500 }`
  overrides the configured limits for this run. Returns what was removed.

## Settings

- `GET /api/v1/settings` — the effective settings: `ai` (provider, model, fallback, effort,
  temperature, subtitles per request, profile), `apiKeys` and `sources.openSubtitles`
  (`{ configured, source: "settings"|"environment"|null, hint: "…abcd"|null }` — **never the
  key**), `sources.languages`, `cache` limits and directories, `stremio` (languages, daily
  limit, profile, language labels), `defaults` (target language, style instructions), `mockAi`.
- `PUT /api/v1/settings` — any subset of `ai`, `sources` (`languages`,
  `openSubtitlesUsername`), `cache`, `stremio`, `defaults`, plus `secrets`
  (`anthropic`, `openai`, `gemini`, `opensubtitles`, `opensubtitlesPassword`: a string sets
  the key, `null` removes the saved one). Returns the new view. Invalid values → `400
invalid_settings` with a readable reason, and nothing is saved. Saved values override the
  environment and apply to the worker, the API and the add-on without a restart.

## Notifications

- `GET /api/v1/notifications?unread=true|false&limit=50`
- `POST /api/v1/notifications/:id/read`
- `POST /api/v1/notifications/read-all`

```json
{
  "id": "…",
  "jobId": "…",
  "kind": "completed",
  "title": "Translation completed",
  "message": "Harbor Lights → Serbian (Latin)",
  "createdAt": "…",
  "read": false
}
```

## Real-time events — `GET /api/v1/events`

Server-Sent Events. Every connection starts with a snapshot, then live events.

| Event                                                                        | Data                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot`                                                                   | `{ lastEventId, serverTime, jobs: [JobView], notifications: [...] }` — all active jobs, the 20 most recently finished, unread notifications |
| `job.created`, `job.updated`, `job.completed`, `job.failed`, `job.cancelled` | the complete `JobView`                                                                                                                      |
| `notification.created`, `notification.read`                                  | the notification                                                                                                                            |

Each event has an increasing `id`. Events carry complete objects, so a client just replaces
what it has. `EventSource` reconnects automatically (`retry: 2000`) and receives a new
snapshot; nothing needs to be replayed by the client. See
[PROGRESS_SYSTEM.md](PROGRESS_SYSTEM.md).

## Metadata — `GET /api/v1/meta`

Target and source languages, profiles, providers (`configured: true/false`, never keys),
defaults, `mockAi`, `maxUploadBytes`.

## Health

`GET /health` (liveness) and `GET /health/ready` (readiness) on api `:7001`, add-on `:7000`
and worker `:7002`. Readiness is `ok`, `degraded` (HTTP 200) or `fail` (HTTP 503).

| Service | Checks                                                                                              |
| ------- | --------------------------------------------------------------------------------------------------- |
| api     | `database`, `storage` (data directories writable), `worker` (heartbeat fresh; otherwise `degraded`) |
| worker  | `database`, `heartbeat`                                                                             |
| addon   | `database`                                                                                          |

## Dashboard

In production the API serves the built dashboard at `/` with an SPA fallback. Unknown
`/api/*` paths return `404 {"error":"not_found"}`.

## Stremio — `GET /api/v1/stremio`

What the dashboard shows about the add-on: `manifestUrl`, `installUrl` (`stremio://…`),
`reachable` (`this-computer`, `https` or `unsupported`), `targetLanguages`,
`profile`, `dailyJobLimit`, `startedLast24h`, `sourceConfigured`.

The add-on's own routes (port 7000) are described in [STREMIO.md](STREMIO.md).

## Dashboard routes

The dashboard is a single page with hash routes: `#/` overview, `#/history`, `#/settings`,
`#/jobs/<id>` job details. Direct links and reloads work.
