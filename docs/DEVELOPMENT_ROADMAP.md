# Development Roadmap

Rules: one phase at a time; each phase is implemented, tested and documented, then work
**stops until the owner explicitly approves** the next phase. A phase is done only when the
implementation is finished, automated and relevant integration tests pass, documentation is
updated, no known critical error remains and a summary has been reported.

| Phase | Name                                                                   | Status                       |
| ----- | ---------------------------------------------------------------------- | ---------------------------- |
| 0     | Project foundation                                                     | Done (approved)              |
| 1     | SRT engine                                                             | Done (approved)              |
| 2     | AI providers                                                           | Done (approved)              |
| 3     | Persistent async job engine and progress system (**highest priority**) | **Done — awaiting approval** |
| 4     | Subtitle sources and cache                                             | Not started                  |
| 5     | Stremio add-on                                                         | Not started                  |
| 6     | Dashboard and notifications                                            | Not started                  |
| 7     | Full integration and reliability                                       | Not started                  |
| 8     | Deployment and portability                                             | Not started                  |

## Phase 0 — Project foundation ✅

- [x] Inspect repository and environment (empty repo; Node 22, pnpm 10, Docker 29).
- [x] pnpm monorepo with `apps/*` and `packages/*`.
- [x] TypeScript strict mode, project references.
- [x] ESLint (type-aware) and Prettier.
- [x] SQLite + Prisma with first migration.
- [x] Environment configuration with validation and `.env.example`.
- [x] Docker Compose and Dockerfile.
- [x] Documentation set.
- [x] Health checks for api, worker and add-on; dashboard status page.

## Phase 1 — SRT engine ✅

- [x] SRT parser (tolerant of real-world irregularities, reports them as warnings).
- [x] SRT serializer (byte-exact round trip for clean files; restores BOM and line endings).
- [x] Structural validation of source and translated subtitles.
- [x] Segmentation: 30–60 entries, scene-aware cuts, character budget, provider-limit adaptation.
- [x] Contextual translation interface (`SegmentTranslator`, `LlmClient`), prompt builder,
      response parser.
- [x] Language and script configuration (Serbian Latin and Cyrillic separate; Bosnian and
      Montenegrin source-only).
- [x] Translation profiles: natural, literal, cinematic, concise, custom.
- [x] Fixtures in `fixtures/subtitles/` and unit tests (182 new tests).

**Deliverable met:** the engine translates SRT through a mock translator and preserves all
structural information. Details: [TRANSLATION_ENGINE.md](TRANSLATION_ENGINE.md).

## Phase 2 — AI providers ✅

- [x] Anthropic Claude, OpenAI and Google Gemini providers on the official SDKs.
- [x] Provider manager: selection, per-request override, timeout, retry with backoff,
      fallback, provider disabling on configuration errors.
- [x] Token usage tracking and cost estimates from a configurable price table.
- [x] Unified error classification.
- [x] Settings through the environment (`AI_*`), safe provider overview for the dashboard.
- [x] `pnpm translate` command-line translator.
- [x] Manually triggered live test (`pnpm test:live`), separate from the ordinary suite.
- [x] 95 new tests driving the real SDKs through a fake HTTP transport.
- [x] Successful live translation by a real provider (OpenAI). Anthropic and Gemini are not
      yet verified live.

Details: [AI_PROVIDERS.md](AI_PROVIDERS.md).

## Phase 3 — Persistent async job engine and progress system ✅

- [x] Persistent translation jobs (`translation_jobs`, `job_segments`).
- [x] Job lifecycle with legal transitions; illegal ones are rejected.
- [x] Background worker (`JobWorker`) in the worker process.
- [x] Job locking with leases; a worker that lost its claim cannot write.
- [x] Duplicate job prevention (unique active translation key).
- [x] Safe cancellation with acknowledgement.
- [x] Recovery after restart, resuming from the last accepted segment; explicit
      `interrupted_by_restart` failure state.
- [x] Segment-level progress and weighted overall progress.
- [x] Remaining-time estimate from measured segments.
- [x] SSE with snapshot on every connection and automatic reconnection.
- [x] Persistent notifications (one per outcome), browser notifications, optional sound.
- [x] Failure and retry handling on three levels, plus owner retry.
- [x] Minimal progress monitoring interface in the dashboard.
- [x] API authentication with `AUTH_TOKEN`, rate limiting.

**Mandatory acceptance tests A–J: all pass** — at engine level (`packages/jobs`), over HTTP
(`apps/api`) and in a real browser against real processes (`e2e`). See the table in
[PROGRESS_SYSTEM.md](PROGRESS_SYSTEM.md).

## Phase 4 — Subtitle sources and cache

Local SRT source, OpenSubtitles official API adapter (if configured), matching, source
validation, cache, connection of source discovery to the job engine.
**Deliverable:** find or receive a subtitle, reuse completed translations, start background
jobs for new ones.

## Phase 5 — Stremio add-on

Official SDK integration, manifest, movie and series handlers, language selection,
translated subtitle delivery, async job handling, cache and status integration, companion
progress page, test with real Stremio Desktop. Research and verify the actual protocol
behaviour for subtitle list refresh — invent nothing.
**Deliverable:** working private add-on on top of the async engine.

## Phase 6 — Dashboard and notifications

Dashboard, manual translation page, job details, live progress, browser notifications,
settings, history, downloads. Tests: SSE reconnection, browser refresh, multiple active jobs.
**Deliverable:** complete private control panel.

## Phase 7 — Full integration and reliability

End-to-end tests: movie, episode, Serbian Latin, Serbian Cyrillic, Croatian, provider
failure, rate limits, cache reuse, restart, cancellation, concurrent jobs, Stremio client
compatibility. Fix every critical issue found.
**Deliverable:** stable integrated application.

## Phase 8 — Deployment and portability

Final Docker configuration; Windows and Linux installation; local startup; moving to another
computer; backup and restore; private server deployment; GitHub workflow; persistent storage
and no-committed-secrets verification.
**Deliverable:** portable private application.
