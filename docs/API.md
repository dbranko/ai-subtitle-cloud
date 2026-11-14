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

## Errors

```json
{ "error": "source_invalid", "message": "No subtitle entries found: …" }
```

| Status | `error`                                                                                             |
| ------ | --------------------------------------------------------------------------------------------------- |
| 400    | `source_invalid`, `unsupported_language`, `invalid_request`, `provider_not_configured`, `too_large` |
| 401    | `unauthorized`                                                                                      |
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

### Read

- `GET /api/v1/jobs?scope=active|finished|all&limit=50` → `{ "jobs": [JobView] }`
- `GET /api/v1/jobs/:id` → `{ "job": JobView }`

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
  "createdAt": "…",
  "startedAt": "…",
  "updatedAt": "…",
  "completedAt": null,
  "elapsedSeconds": 34
}
```

`etaSeconds` is `null` until it can be estimated. `costUsd` is `null` when a model has no
configured price. `error` is `{ code, message, stage }` for failed jobs.

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

## Planned

| Area         | Endpoints (outline)                                   | Phase |
| ------------ | ----------------------------------------------------- | ----- |
| Sources      | search and select source subtitles (OpenSubtitles)    | 4     |
| Translations | cache listing and cleanup                             | 4     |
| Settings     | `GET /settings`, `PUT /settings` (secrets write-only) | 6     |

Add-on (`:7000`, Stremio protocol, Phase 5): `GET /manifest.json`,
`GET /subtitles/:type/:id/:extra?.json`, and a URL serving stored translated SRT files. The
add-on returns `404` for these paths until Phase 5.
