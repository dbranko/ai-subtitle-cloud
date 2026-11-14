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
- **[planned — Phase 3/6]** `AUTH_TOKEN` enforcement on all API routes and the SSE stream
  when configured (the guard above only ensures a token _exists_; request authentication
  arrives with the first real API routes). Until then, do not expose the services beyond
  localhost.
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
- **[planned — Phase 2]** AI provider keys are read server-side only (environment, or
  settings stored outside the browser), never returned by any API response (only
  "configured: yes/no" and a masked suffix), never sent to Stremio.
- **[planned — Phase 8]** CI/repository check that no secret is committed.

## Input handling [planned — with the feature that accepts the input]

- Upload size limit and `.srt`/text content validation (Phase 4/6).
- Safe file paths: stored files are named by generated IDs/hashes, never by user-supplied
  names; all paths are resolved and checked to stay inside the configured data directories.
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
