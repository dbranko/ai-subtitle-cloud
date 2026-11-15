# Development Roadmap

Rules: one phase at a time; each phase is implemented, tested and documented, then work
**stops until the owner explicitly approves** the next phase. A phase is done only when the
implementation is finished, automated and relevant integration tests pass, documentation is
updated, no known critical error remains and a summary has been reported.

| Phase | Name                                                                   | Status                                                   |
| ----- | ---------------------------------------------------------------------- | -------------------------------------------------------- |
| 0     | Project foundation                                                     | Done (approved)                                          |
| 1     | SRT engine                                                             | Done (approved)                                          |
| 2     | AI providers                                                           | Done (approved)                                          |
| 3     | Persistent async job engine and progress system (**highest priority**) | Done (approved)                                          |
| 4     | Subtitle sources and cache                                             | Done (approved)                                          |
| 5     | Stremio add-on                                                         | Done (approved; verified in Stremio 6.0.7 through HTTPS) |
| 6     | Dashboard and notifications                                            | Not started                                              |
| 7     | Full integration and reliability                                       | Not started                                              |
| 8     | Deployment and portability                                             | Not started                                              |

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

## Phase 4 — Subtitle sources and cache ✅

- [x] Local source: uploads are stored in a content-addressed library and found by IMDb id.
- [x] OpenSubtitles adapter on the official API (enabled by `OPENSUBTITLES_API_KEY`).
- [x] Matching: IMDb id, title, year, season, episode, video hash, release information.
- [x] Source validation and safe downloads (SSRF protection).
- [x] Translation cache keyed by source hash, target, script, profile, prompt and engine
      version; configurable cleanup that never touches files of active jobs.
- [x] Duplicate prevention for media requests, before and after the source is known.
- [x] Source discovery runs inside the background job (`locating_source`,
      `downloading_source`).
- [x] Live run against the real OpenSubtitles service (movie search, download, full job,
      cache). Episode search, hash matching and account login are not yet verified live.

**Deliverable met:** the system can find or receive a subtitle, reuse completed
translations and start background jobs for new ones. Details:
[SOURCES_AND_CACHE.md](SOURCES_AND_CACHE.md).

## Phase 5 — Stremio add-on

- [x] Official SDK integration (manifest linted by the SDK, SDK router).
- [x] Manifest.
- [x] Movie subtitle handler.
- [x] Series subtitle handler.
- [x] Language selection (configured target languages, ISO 639-2 codes, label overrides).
- [x] Translated subtitle delivery (real SRT files, CORS, cache headers).
- [x] Asynchronous job handling: requests never wait for a translation.
- [x] Cache integration: finished translations are returned immediately.
- [x] Status integration: jobs started by Stremio appear live in the dashboard; Stremio card
      with the install address; the add-on's Configure button opens the dashboard.
- [x] Automatic and manual mode; daily limit for automatic translations.
- [x] Access token in the add-on address when exposed beyond this computer.
- [x] Test with actual Stremio Desktop: done by the owner on Stremio 6.0.7 (Windows). The
      add-on works through an HTTPS address; `http://127.0.0.1` is not accepted by that
      version. See the field report in [STREMIO.md](STREMIO.md).

No native progress capability was invented: the protocol has none, so the dashboard is the
progress page. How the Stremio client picks up a subtitle that finishes later is the main
point the Desktop test has to confirm.

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
