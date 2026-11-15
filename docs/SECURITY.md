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
- **[built]** With `AUTH_TOKEN` set, the Stremio add-on exists only under `/<token>/...`:
  manifest, subtitles and translated files are refused without it (constant-time
  comparison), and the token is part of every subtitle URL the add-on hands out. The address
  installed in Stremio is therefore the secret; treat it like a password.
- **[built]** The add-on serves only files that are known finished translations; the file
  name from the request is matched against the cache and never used as a path.
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
- **[built]** Editing keys from the dashboard: write-only password fields that are empty
  after saving; keys are stored in the database encrypted with AES-256-GCM, with the key in
  `<data>/secret.key` (created with mode 0600, never committed, keep it with backups). No API
  response contains a key — only "set / where from / last 4 characters" (for keys of 12+
  characters). A Playwright test records every response the browser receives and checks the
  key never appears.
- **[planned — Phase 8]** CI/repository check that no secret is committed.

## Input handling [planned — with the feature that accepts the input]

- **[built]** Upload size limit (`MAX_UPLOAD_BYTES`) and content validation: an upload that
  does not parse as SRT is rejected before a job exists.
- **[built]** Stored files are named only by generated job ids and validated language ids.
- **[built]** SSRF protection for remote subtitle downloads: HTTPS only, allow-listed
  domains, no bare IPs, private/loopback/link-local/carrier-NAT/multicast addresses rejected
  after DNS resolution (IPv4 and IPv6), manual redirects re-checked per hop, size limit.
  Covered by tests. (A DNS answer could still change between the check and the connection;
  the domain allow-list is the primary control.)
- **[built]** Downloaded files are validated as SRT before they are stored or sent to a
  translator; HTML, archives and other formats are rejected.
- **[built]** The OpenSubtitles API key and password are sent only to the API host, never to
  the download host, the browser or logs.
- Rate limiting: **[built]** on the API; not on the add-on (its handlers only read the
  database; a translation starts only when an "AI translate" entry is picked, capped by
  `STREMIO_DAILY_JOB_LIMIT`; HEAD requests cannot start one).
- CORS: **[built]** the add-on allows any origin, as the Stremio protocol requires; the API
  sends no CORS headers, so only its own origin (the dashboard) can call it.

## Storage

- **[built]** All runtime data lives under `data/` (git-ignored). Containers run as a
  non-root user.
- **[planned — Phase 4]** Cache cleanup never deletes files of active jobs.

## Dependencies

- pnpm blocks dependency install scripts by default; only `better-sqlite3`, `esbuild`,
  `prisma` and `@prisma/engines` are allowed (`pnpm-workspace.yaml`).
- The lockfile is committed and CI installs with `--frozen-lockfile`.
