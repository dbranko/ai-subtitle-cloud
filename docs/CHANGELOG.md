# Changelog and Decision Log

Newest first. Each phase records what was added and the decisions made, with reasons.

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
