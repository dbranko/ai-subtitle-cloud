# Architecture

Status legend: **[built]** exists and is tested · **[planned]** designed here, implemented in
the phase named.

## Overview

```
                 ┌────────────┐        ┌──────────────────────┐
  Stremio ─────▶ │   addon    │        │      dashboard       │ ◀── owner's browser
                 │ (port 7000)│        │ (React, served by api)│
                 └─────┬──────┘        └──────────┬───────────┘
                       │                          │ REST + SSE
                       │                 ┌────────▼────────┐
                       │                 │       api       │
                       │                 │   (port 7001)   │
                       │                 └────────┬────────┘
                       │                          │
                 ┌─────▼──────────────────────────▼─────┐
                 │   SQLite (WAL)  +  data/ filesystem   │   ◀── single source of truth
                 └─────────────────▲────────────────────┘
                                   │
                          ┌────────┴────────┐
                          │     worker      │ ──▶ AI providers / subtitle sources
                          │ (health: 7002)  │
                          └─────────────────┘
```

Three server processes plus a static web UI. They never call each other directly for job
control: **the database is the contract**. The add-on and API create or look up jobs; the
worker claims and processes them; everyone reads state from the same tables. This is what
makes jobs independent of any HTTP request, browser tab or single process.

| Process     | Responsibility                                                              | Status                                  |
| ----------- | --------------------------------------------------------------------------- | --------------------------------------- |
| `api`       | REST API, SSE progress stream, notifications, serves dashboard build        | health **[built]**, rest planned        |
| `worker`    | Claims jobs, runs the translation pipeline, writes progress                 | heartbeat **[built]**, jobs Phase 3     |
| `addon`     | Stremio manifest + subtitle handlers; returns immediately, never translates | health **[built]**, Stremio Phase 5     |
| `dashboard` | React control panel                                                         | status page **[built]**, rest Phase 3/6 |

## Why separate processes

- A crash or restart of the API or add-on must not kill a running translation.
- A long translation must not block the event loop that answers Stremio.
- For one owner, three small Node processes sharing a SQLite file are simpler and more
  robust than a queue server. Redis is deliberately not used.

## Packages

| Package                   | Purpose                                                                   | Phase         |
| ------------------------- | ------------------------------------------------------------------------- | ------------- |
| `@asc/shared`             | App version, health report builders, logger options with secret redaction | 0 **[built]** |
| `@asc/config`             | Env loading and validation, storage paths, non-loopback bind guard        | 0 **[built]** |
| `@asc/database`           | Prisma schema and migrations, SQLite client, heartbeat helpers, test DB   | 0 **[built]** |
| `@asc/subtitle-parser`    | SRT parse / serialize / validate                                          | 1             |
| `@asc/translation-engine` | Segmentation, context overlap, prompts, validation, retry                 | 1             |
| `@asc/ai-providers`       | Claude / OpenAI / Gemini behind one interface, fallback, usage, pricing   | 2             |
| `@asc/subtitle-sources`   | Local upload and OpenSubtitles adapters, matching                         | 4             |

Dependency direction: `apps → packages`; `translation-engine → subtitle-parser, ai-providers`
(by interface). Nothing in `packages/` knows about Stremio or HTTP.

## Persistence

- **SQLite** through **Prisma 7** with the `better-sqlite3` driver adapter. One file,
  default `data/db/asc.sqlite`.
- Opened with `journal_mode=WAL`, `synchronous=NORMAL` and a 5 s busy timeout, so the three
  processes can read and write concurrently without `SQLITE_BUSY` errors.
- Schema changes ship as Prisma migrations (`packages/database/prisma/migrations`), applied
  by `pnpm db:migrate` locally and by the one-shot `migrate` service in Docker Compose.
- **Filesystem** under `data/`: `subtitles/` (originals and translations), `cache/`,
  `logs/`, `jobs/` (per-job working files). All paths are configurable.

Current schema (Phase 0): `service_heartbeats` — one row per long-running service
(`service`, `instanceId`, `pid`, `version`, `startedAt`, `lastSeenAt`). The worker refreshes
it every `WORKER_HEARTBEAT_INTERVAL_MS`; the API reports the worker as alive while the row
is younger than three intervals. Phase 3 reuses `instanceId` for job locks and dead-worker
detection.

## Async job engine [planned — Phase 3]

Fully specified in [PROGRESS_SYSTEM.md](PROGRESS_SYSTEM.md). In short: persistent job rows
with a legal state machine, a unique translation key that prevents duplicates, lease-based
locking so only one worker processes a job, per-segment checkpoints for recovery after
restart, weighted real progress, an event log that feeds SSE with resumable event IDs, and
persistent notifications.

## Stremio integration [planned — Phase 5]

The add-on answers a subtitle request from the database only: a cached translation is
returned immediately; otherwise a job is created or reused and a protocol-valid response is
returned without waiting. How the Stremio client rediscovers the finished subtitle will be
**verified against the real protocol and Stremio Desktop** in Phase 5 — no capability is
assumed in advance, and the dashboard provides the full progress experience regardless.

## Configuration

`@asc/config` reads `<repo>/.env` (optional) and the process environment (which wins),
validates everything with zod and fails fast with a readable message. The repo root is found
by walking up to `pnpm-workspace.yaml` (or `ASC_ROOT`), so relative paths mean the same thing
in every process. See `.env.example` for every variable.

## Build and module layout

- pnpm workspace, ESM only, TypeScript strict (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- `tsc -b` with project references compiles packages and server apps to `dist/`.
- Workspace packages export `dist` by default and their `src` under the custom
  `asc-source` condition. `tsx --conditions=asc-source` (dev) and Vitest aliases (tests) use
  sources directly, so neither needs a prior build.
- The dashboard is built by Vite; the browser bundle imports no server package.

## Deployment

- **Local:** `pnpm dev` (watch mode) or `pnpm build` + `pnpm start:*`.
- **Docker Compose:** one image, four services (`migrate` one-shot, `api`, `worker`,
  `addon`), non-root user, health checks, ports published on `127.0.0.1` only.
- **Data volume:** bind mount `./data` by default (easy backup). SQLite WAL needs shared
  memory between the containers; this works on Linux and inside WSL2, but is not reliable on
  a Docker Desktop bind mount of a Windows/macOS host folder. There, set
  `ASC_DATA_MOUNT=asc-data` to use the named volume. To be re-verified in Phase 8.

## Testing

Vitest runs unit and integration tests against real, fully migrated temporary SQLite
databases (`createTestDatabase()` applies the committed migration files). AI providers are
mocked in ordinary tests. Playwright end-to-end tests are added with the progress UI
(Phase 3) and dashboard (Phase 6).
