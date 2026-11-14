# API

Only the health endpoints exist today (Phase 0). Everything else is listed as an outline so
the planned surface is visible; exact request/response shapes are documented here when each
endpoint is implemented.

## Implemented

### Liveness — `GET /health`

Available on api (`:7001`), add-on (`:7000`) and worker (`:7002`). Always `200` while the
process is running. No dependencies are checked.

```json
{
  "status": "ok",
  "app": "ai-subtitle-cloud",
  "service": "api",
  "version": "0.1.0",
  "uptimeSeconds": 42,
  "timestamp": "2026-11-14T16:46:04.657Z"
}
```

### Readiness — `GET /health/ready`

Reports whether the service can do its job. Overall `status` is `fail` if any check failed,
otherwise `degraded` if any check is degraded, otherwise `ok`.
HTTP `200` for `ok` and `degraded`, `503` for `fail`.

```json
{
  "status": "degraded",
  "service": "api",
  "version": "0.1.0",
  "timestamp": "2026-11-14T16:49:39.800Z",
  "checks": {
    "database": { "status": "ok" },
    "storage": { "status": "ok" },
    "worker": { "status": "degraded", "detail": "last worker heartbeat 19s ago" }
  }
}
```

| Service | Checks                                                                                                                                                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api     | `database` (query succeeds), `storage` (data directories exist and are writable), `worker` (heartbeat younger than 3 × `WORKER_HEARTBEAT_INTERVAL_MS`; otherwise `degraded`) |
| worker  | `database`, `heartbeat` (last heartbeat write succeeded)                                                                                                                     |
| addon   | `database`                                                                                                                                                                   |

### Dashboard

In production the API serves the built dashboard at `/` with an SPA fallback for unknown
non-API `GET` paths. Unknown `/api/*` paths return `404 {"error":"not_found"}`.

## Planned (not implemented)

All under `/api/v1`, JSON, authenticated with `AUTH_TOKEN` when one is configured.

| Area          | Endpoints (outline)                                                                                           | Phase |
| ------------- | ------------------------------------------------------------------------------------------------------------- | ----- |
| Jobs          | `POST /jobs` (create or reuse), `GET /jobs`, `GET /jobs/:id`, `POST /jobs/:id/cancel`, `POST /jobs/:id/retry` | 3     |
| Events        | `GET /events` — SSE: initial snapshot, live job and notification events, `Last-Event-ID` replay               | 3     |
| Notifications | `GET /notifications`, `POST /notifications/:id/read`                                                          | 3     |
| Uploads       | `POST /subtitles/upload` (SRT, size-limited)                                                                  | 4     |
| Translations  | `GET /translations` (history), `GET /translations/:id/download`                                               | 4/6   |
| Settings      | `GET /settings`, `PUT /settings` (secrets write-only)                                                         | 2/6   |
| Languages     | `GET /languages` (targets and scripts)                                                                        | 1/6   |

Add-on (`:7000`, Stremio protocol, Phase 5): `GET /manifest.json`,
`GET /subtitles/:type/:id/:extra?.json`, and a URL serving stored translated SRT files. The
add-on returns `404` for these paths until Phase 5.
