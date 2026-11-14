# Security

Private, single-owner application. The security model is: **reachable only from the owner's
machine by default; anything wider requires authentication and HTTPS.**

Status legend: **[built]** enforced and tested today · **[planned]** required, with the
phase that delivers it.

## Network exposure

- **[built]** Every service binds to `127.0.0.1` by default.
- **[built]** Bind guard: a service refuses to start on a non-loopback address unless
  `AUTH_TOKEN` (≥ 24 characters) is configured. The only bypass is the explicit
  `ALLOW_UNAUTHENTICATED_NON_LOOPBACK=true`, intended solely for setups where another layer
  restricts access.
- **[built]** Docker Compose publishes ports as `127.0.0.1:<port>` only. Containers must
  listen on `0.0.0.0` internally, so Compose sets the bypass flag; the localhost restriction
  is enforced by the port mapping.
- **[built]** `AUTH_TOKEN` is enforced on every `/api/*` route, including the event stream
  and downloads (bearer header, or `?token=` where headers are impossible), with a
  constant-time comparison. Health endpoints stay open. Covered by tests.
- **[built]** API routes are rate-limited (600 requests per minute per client address).
- **[planned — Phase 5]** The Stremio add-on URL carries its own unguessable token when the
  add-on is reachable from other devices.
- **[planned — Phase 8]** Remote access guide: HTTPS reverse proxy in front, token required.
  Never expose the application publicly without protection.

## Secrets

- **[built]** `.env` and `.env.*` are git-ignored; only `.env.example` (no values) is tracked.
- **[built]** Logger redaction for `authorization`, `cookie`, `x-api-key` headers and any
  `apiKey`, `token`, `authToken`, `password`, `secret` field. Configuration is logged through
  `describeConfig()`, which reduces secrets to booleans. Covered by tests.
- **[built]** The dashboard bundle imports no server package and receives no secret.
- **[built]** AI provider keys are read server-side from the environment only. They are sent
  to the provider as a request header and nowhere else: `describeConfig()` and
  `describeProviders()` expose only "configured: yes/no", error messages are shortened and
  key-free, and provider endpoints are fixed in code so an inherited `*_BASE_URL` variable
  cannot redirect a key. Covered by tests.
- **[built]** OpenAI requests use `store: false`, so subtitles are not retained there.
- **[planned — Phase 6]** Editing keys from the dashboard: write-only fields, stored outside
  the browser, never returned by any API response.
- **[planned — Phase 8]** CI/repository check that no secret is committed.

## Input handling [planned — with the feature that accepts the input]

- **[built]** Upload size limit (`MAX_UPLOAD_BYTES`) and content validation: an upload that
  does not parse as SRT is rejected before a job exists.
- **[built]** Stored files are named only by generated job ids and validated language ids.
- SSRF protection for remote subtitle downloads: HTTPS only, allow-listed hosts for
  configured sources, private/loopback/link-local address ranges rejected after DNS
  resolution, redirect and size limits (Phase 4).
- Rate limiting on API and add-on endpoints (Phase 3/5).
- CORS: add-on endpoints allow what the Stremio protocol requires; the API allows only its
  own origin (Phase 5/6).

## Storage

- **[built]** All runtime data lives under `data/` (git-ignored). Containers run as a
  non-root user.
- **[planned — Phase 4]** Cache cleanup never deletes files of active jobs.

## Dependencies

- pnpm blocks dependency install scripts by default; only `better-sqlite3`, `esbuild`,
  `prisma` and `@prisma/engines` are allowed (`pnpm-workspace.yaml`).
- The lockfile is committed and CI installs with `--frozen-lockfile`.
