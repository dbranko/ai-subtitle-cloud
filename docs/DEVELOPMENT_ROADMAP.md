# Development Roadmap

Rules: one phase at a time; each phase is implemented, tested and documented, then work
**stops until the owner explicitly approves** the next phase. A phase is done only when the
implementation is finished, automated and relevant integration tests pass, documentation is
updated, no known critical error remains and a summary has been reported.

| Phase | Name                                                                   | Status                       |
| ----- | ---------------------------------------------------------------------- | ---------------------------- |
| 0     | Project foundation                                                     | **Done — awaiting approval** |
| 1     | SRT engine                                                             | Not started                  |
| 2     | AI providers                                                           | Not started                  |
| 3     | Persistent async job engine and progress system (**highest priority**) | Not started                  |
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

## Phase 1 — SRT engine

SRT parser and serializer, validation, segmentation with context overlap, contextual
translation interface, language/script configuration (Serbian Latin and Cyrillic separate;
no Bosnian/Montenegrin), representative fixtures, unit tests.
**Deliverable:** tested engine that translates SRT through a mock provider and preserves all
structural information.

## Phase 2 — AI providers

Claude, OpenAI, Gemini; provider manager, selection, fallback, token usage, error handling,
configurable pricing. Manually triggered real-API integration test, separate from the
ordinary suite.
**Deliverable:** translation engine working with real providers.

## Phase 3 — Persistent async job engine and progress system

Persistent jobs, lifecycle and legal transitions, background worker, locking, duplicate
prevention, safe cancellation, restart recovery, segment-level and weighted progress,
remaining-time estimates, SSE with reconnection, persistent notifications, failure/retry
handling, minimal progress UI. Mandatory acceptance tests A–J
([PROGRESS_SYSTEM.md](PROGRESS_SYSTEM.md)).
**Stremio work must not begin until every mandatory test passes.**

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
