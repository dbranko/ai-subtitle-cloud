# Changelog and Decision Log

Newest first. Each phase records what was added and the decisions made, with reasons.

## Phase 3 — Persistent async job engine and progress system (2026-11-14)

### Added

- `@asc/jobs`: job store, state machine, progress and estimate calculation, translation key,
  leases and recovery, cancellation, event log, notifications, `JobWorker`.
- Database migration `job_engine`: `translation_jobs`, `job_segments`, `job_events`,
  `notifications`.
- Worker process runs the job loop; graceful shutdown returns jobs to the queue.
- API: jobs (create, list, get, cancel, retry, download), notifications, metadata, SSE event
  stream, `AUTH_TOKEN` enforcement, rate limiting.
- Dashboard: upload form, live job cards (stage, percentage, segments, current segment,
  elapsed, remaining, retries, cost, errors), cancel/retry/download, notifications with
  opt-in desktop notifications and optional sound, connection indicator.
- Mock mode (`MOCK_AI`) to run the whole system without an AI provider.
- Playwright suite (`e2e/`, `pnpm test:e2e`) with a harness that starts, kills and restarts
  real api and worker processes.

### Decisions

1. **One active job per translation key through a nullable unique column (`activeKey`)**
   instead of a partial index: plain SQL that Prisma migrations manage without drift.
2. **Leases, not heartbeats, decide ownership.** A job is recovered when its lease expires
   (default 30 s); every write is compare-and-set on the owner, so a worker that was only
   slow — not dead — cannot corrupt a job that was taken over.
3. **Recovery resumes; it does not restart.** Each accepted segment is a checkpoint written
   in the same transaction as the progress counters.
4. **Bounded automatic recovery.** After `JOB_MAX_ATTEMPTS` runs the job fails explicitly
   with `interrupted_by_restart` and can be retried by the owner.
5. **Graceful shutdown releases jobs immediately**, so a normal restart costs no lease wait.
6. **Cancellation is a request plus an acknowledgement.** The job is `cancelled` only when
   the worker has stopped; partial work is deleted and nothing is published.
7. **SSE always starts with a snapshot.** Simpler and stricter than replaying missed events:
   state after a reconnect is correct even if the API restarted or events were pruned.
   Events carry complete objects, so they are idempotent.
8. **The API tails the event log** (300 ms, only while a browser is connected) because the
   worker is another process. One query serves all clients; browsers never poll.
9. **The percentage is one pure function** of stored state and segment counts; it is stored
   on every write and never computed in the browser.
10. **A resumed job keeps the credit of accepted segments** during the early stages, so the
    displayed percentage never decreases.
11. **No estimate before two measured segments**; `null` instead of a guess.
12. **Notifications are unique per (job, kind, run)** and created in the terminal
    transaction. Cancelled jobs do not notify.
13. **Uploads are sent as base64 bytes** and decoded on the server, so legacy code pages are
    handled correctly instead of being mangled by the browser.
14. **Finished identical translations are reused** already now (`reason: "completed"`); the
    full cache with cleanup follows in Phase 4.
15. **`locating_source` and `downloading_source` are passed through** for uploads; real
    source discovery plugs in there in Phase 4.
16. **Write-first transactions with a busy retry** keep three processes on one SQLite file
    free of lock errors.

### Verified

- 395 automated tests (`pnpm test`), 9 browser tests (`pnpm test:e2e`); all mandatory tests
  A–J pass.
- One real translation through the full path (API → worker → OpenAI → stored file →
  notification).

### Known limitations / open items

- Recovery after a hard crash waits for the lease (30 s by default).
- Elapsed time includes any time the application was down.
- The remaining-time estimate covers the translation stage only and needs at least three
  segments in a job to appear.
- A job's provider and model are fixed when it is created; changing the configuration does
  not affect queued jobs.
- Cancelling discards the segments already translated.
- The dashboard is the minimal progress interface; job details page, history and settings
  are Phase 6.
- Browser desktop notifications were tested with a stubbed `Notification` API, not against
  a real operating-system notification centre.

## Phase 2 — AI providers (2026-11-14)

### Added

- `@asc/ai-providers`: Anthropic, OpenAI and Gemini providers on the official SDKs; provider
  manager (timeout, retry with backoff, fallback, disabling of misconfigured providers, usage
  and cost totals, events); unified `ProviderError`; pricing loader; settings wiring;
  `pnpm translate` CLI; `pnpm test:live`.
- `config/pricing.json`: editable price table.
- `AI_*` settings and provider keys in `@asc/config` and `.env.example`.
- Engine: optional `costUsd` on responses, segment results and statistics.
- `docs/AI_PROVIDERS.md`.

### Decisions

1. **Official SDKs, not hand-written HTTP.** They track API changes; request and response
   shapes were taken from the installed SDK type definitions.
2. **One retry policy, in the manager.** SDK-level retries are disabled so behaviour is the
   same for every provider and is covered by tests (required for Phase 3 test G).
3. **Two retry layers with different jobs:** the manager retries provider failures, the
   engine retries invalid output.
4. **`AI_EFFORT` is the portable generation setting.** Current Claude models reject
   `temperature`; effort exists on all three providers. `AI_TEMPERATURE` is sent only to
   OpenAI and Gemini, and only when set.
5. **Default models:** `claude-opus-5-5`, `gpt-6.1-sol`, `gemini-3.8-flash`. The Claude
   default is the best-quality model; `claude-sonnet-5-5` (about half the price) and
   `claude-haiku-5-5` (a small fraction) are one setting away.
6. **Default effort `medium`.** A balance of quality and cost for dialogue; adjustable.
7. **Structured JSON output is requested from every provider**, with the same schema; the
   engine's own parser and validation still decide.
8. **Anthropic server-side refusal fallback is enabled** on models that support it, so a
   safety-classifier decline on one segment does not fail the job.
9. **Provider endpoints are fixed in code.** `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and
   similar environment variables are ignored, so a key can never be sent to another host by
   an inherited variable.
10. **Configuration failures disable a provider for the rest of the job** (bad key, no
    credit, unknown model); one-off failures do not.
11. **Cost is an estimate and may be unknown.** No price configured → `null`, never a guess.
12. **Settings are environment-based for now.** The dashboard settings page (Phase 6) will
    edit them; `ProviderSelection` already supports per-request overrides.
13. **Streaming for Anthropic, plain requests for OpenAI and Gemini.** The 180 s request
    timeout is below the HTTP idle limits; revisit if real runs show long generations.

### Known limitations / open items

- **Live verification covers OpenAI only.** After credits were added, `pnpm test:live` passed
  against the real OpenAI API (`gpt-6.1-sol`, English → Serbian Latin and Serbian Cyrillic),
  and `pnpm translate` produced correct, validated subtitles for the `basic-movie` and
  `formatting` fixtures (12 and 14 entries, one request each, no retries, about $0.006 each
  at the configured price). Tags, speaker labels, position settings and symbol-only lines
  were preserved. An earlier run against an account without credits found and fixed one bug:
  OpenAI's "no credits remaining" response (HTTP 429, type `insufficient_quota`, code
  `credit_balance_exhausted`) was classified as a retryable rate limit; it is now a
  non-retried `billing` error. **Anthropic and Gemini have not been called live.**
- The Gemini model id was taken from the SDK's type definitions and is unverified; the
  OpenAI id `gpt-6.1-sol` is confirmed by the live run. OpenAI and Gemini prices come from
  third-party trackers and are not verified against official documentation.
- Gemini's `thinkingLevel` mapping and OpenAI's acceptance of `reasoning.effort` values on
  the default models are unverified until a live run.
- Translation quality (prompt `v1`) has only been spot-checked on two short fixtures with
  OpenAI; it has not been judged on a full film or episode.

## Phase 1 — SRT engine (2026-11-14)

### Added

- `@asc/subtitle-parser`: `parseSrt`, `serializeSrt`, `validateSrt`, timestamp helpers,
  `decodeSubtitleBytes` (UTF-8, UTF-16, legacy code pages).
- `@asc/translation-engine`: language/script registry, translation profiles, markup helpers,
  segmentation, prompt builder (prompt `v1`), response parser, segment and whole-file
  validation, `translateSubtitle` orchestration with retries, cancellation and resume, and a
  deterministic mock translator.
- `fixtures/subtitles/`: six representative subtitle files.
- `docs/TRANSLATION_ENGINE.md`.

### Decisions

1. **Timestamps are stored as integer milliseconds and never sent to the model.** Only
   `{id, text}` pairs leave the engine; indexes, timing and position settings are re-attached
   from the source, so the model cannot alter them.
2. **Entries are identified by file position (`id` = 1-based position), not by the SRT index.**
   Real files contain duplicate or missing indexes; positions are always unique. Original
   index numbers are preserved in the output and never renumbered.
3. **The parser is tolerant, the validator is strict.** Irregular input (BOM, CRLF, missing
   blank lines or indexes, `.` separators) is read and reported as warnings; unusable timing
   or non-SRT input is rejected. The output is always canonical SRT in the source file's
   line-ending/BOM format.
4. **The engine owns the prompt and the response parsing; a provider only turns a prompt into
   text (`LlmClient`).** Prompt and parsing are therefore identical and identically tested
   for Claude, OpenAI and Gemini. This reverses the dependency sketched in Phase 0:
   `ai-providers` will depend on `translation-engine`.
5. **Serbian Latin is guaranteed by deterministic transliteration.** If a model answers a
   `sr-Latn` request in Cyrillic, the text is converted with the exact Serbian
   Cyrillic→Latin mapping instead of being retried. The reverse direction is ambiguous, so
   `sr-Cyrl` (and every other target) is enforced by script validation and retry.
6. **Bare `sr` is rejected.** Serbian always requires an explicit script.
7. **Bosnian and Montenegrin are source-only.** They can be translated from, never into.
8. **Serbian targets specify ekavian; Croatian specifies ijekavian** in the prompt's target
   note. This is a default in `languages.ts`, easy to change.
9. **A whole segment is retried when any entry is invalid**, with the validation problems
   fed back to the model. Simpler and more coherent than patching single entries; revisit if
   real-provider cost shows it matters.
10. **Provider errors are not handled by the engine.** Only invalid output (unparseable or
    failing validation) is retried here; timeouts, rate limits and fallback belong to the
    provider manager (Phase 2).
11. **Segments are cut at scene changes** (pauses ≥ 2.5 s) when one falls inside the allowed
    window, and the plan is deterministic so a job can resume after a restart.
12. **`segment_completed` is emitted only after validation passed**, and progress callbacks
    are awaited — the hook Phase 3 uses to persist real progress.

### Known limitations / open items

- Only SRT is supported (no ASS/VTT input).
- Long lines are not re-wrapped; line length is requested in the prompt but not enforced.
- Encoding detection without a BOM falls back to one configurable legacy code page; there is
  no statistical charset detection.
- Prompt quality can only be judged with real providers (Phase 2).

## Phase 0 — Project foundation (2026-11-14)

### Added

- pnpm workspace: `apps/{api,worker,addon,dashboard}`, `packages/{shared,config,database}`
  and placeholder packages for later phases (`subtitle-parser`, `translation-engine`,
  `ai-providers`, `subtitle-sources`).
- TypeScript strict configuration with project references; ESLint (type-aware) and Prettier.
- `@asc/config`: validated environment configuration, `.env` loading, storage paths,
  non-loopback bind guard.
- `@asc/database`: Prisma schema, initial migration (`service_heartbeats`), SQLite client in
  WAL mode, heartbeat helpers, migrated temporary databases for tests.
- `@asc/shared`: version constants, liveness/readiness report builders, logger options with
  secret redaction.
- Health checks: `GET /health` and `GET /health/ready` on api, worker and add-on. The worker
  writes a heartbeat row; the API reports the worker as degraded when it goes stale.
- Dashboard skeleton showing live system status.
- Dockerfile, `docker-compose.yml` (migrate, api, worker, addon), `.env.example`.
- GitHub Actions CI (Linux and Windows): format check, lint, build, test.
- Documentation set in `docs/`.

### Decisions

1. **Three server processes that communicate only through the database.** Required for jobs
   to survive browser closure and API restarts and for Stremio requests never to block on
   translation. No queue server: SQLite in WAL mode is sufficient for one owner. Redis is
   not used.
2. **Prisma 7 with the `better-sqlite3` driver adapter.** Current Prisma major; generated
   client is plain TypeScript compiled with the workspace. `better-sqlite3` ships prebuilt
   binaries for Windows and Linux, so no compiler toolchain is needed.
3. **SQLite opened with WAL, `synchronous=NORMAL`, 5 s busy timeout.** Lets api, worker and
   add-on share one file safely.
4. **TypeScript 6.0 rather than 7.0.** `typescript-eslint` does not yet support TypeScript 7
   (peer range `<6.1.0`). Revisit when it does.
5. **Workspace packages expose sources under a custom `asc-source` export condition.** Dev
   (`tsx`) and tests (Vitest aliases) run from source; production runs compiled `dist`.
6. **The API serves the built dashboard in production.** One origin means no CORS setup and
   SSE works without extra configuration. In development Vite proxies to the API.
7. **The add-on is its own process with health endpoints only for now.** Stremio routes are
   deliberately absent until Phase 5 so nothing invalid can be served to Stremio. How the
   official Stremio Add-on SDK is mounted (its own HTTP server vs. router inside Fastify) is
   decided in Phase 5.
8. **Worker liveness through a database heartbeat** (plus a small HTTP health endpoint for
   Docker). The same `instanceId` will identify job-lock owners in Phase 3.
9. **Bind guard instead of trusting configuration.** A service will not start on a
   non-loopback address without `AUTH_TOKEN`, unless explicitly overridden (used by Docker
   Compose, which restricts access through `127.0.0.1` port publishing).
10. **One Docker image for all services**, started with different commands; migrations run in
    a one-shot `migrate` service that the others wait for. Containers run as non-root.
11. **Tests use real migrated temporary SQLite databases**, not mocks of the database, so
    the schema and migrations are exercised by every test run.
12. **Playwright is not installed yet.** It is added in Phase 3 with the first UI that needs
    browser-level tests (refresh, closure, SSE reconnection).
13. **`packages/config` holds environment configuration code.** The spec lists a `config`
    entry; it is implemented as a workspace package so every process shares one validated
    configuration loader.

### Known limitations / open items

- `AUTH_TOKEN` is validated and required for non-loopback binding, but request
  authentication is not enforced yet (no real API routes exist). Planned with Phase 3/6.
- SQLite WAL on a Docker Desktop bind mount of a Windows/macOS host folder is not reliable;
  use `ASC_DATA_MOUNT=asc-data` there. To be verified in Phase 8.
- CI workflow is committed but has not run on GitHub yet; the Windows job is unverified.
