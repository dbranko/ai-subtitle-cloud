# AI Subtitle Cloud

Personal, self-hosted AI subtitle translator for Stremio. One owner, no accounts, no billing.

It finds a source subtitle for a movie or episode, translates it with an AI provider
(Claude, OpenAI or Gemini) in a persistent background worker, shows real progress in a
private dashboard, and serves the finished translation to Stremio.

> **Status: Phases 0–7 complete** (Phase 7 awaiting approval). The Stremio add-on works in
> Stremio 6.0.7 over HTTPS and translates only when "AI translate" is picked in the subtitle
> menu (see [docs/STREMIO.md](docs/STREMIO.md)). The dashboard has an overview with live
> progress, history, job details with a timeline, and a settings page. Phase 7 added
> integration tests through the production code path, fuzzing, and browser-facing security
> (see [docs/TESTING.md](docs/TESTING.md)). Next: Phase 8, deployment —
> see [docs/DEVELOPMENT_ROADMAP.md](docs/DEVELOPMENT_ROADMAP.md).

## Requirements

| Tool           | Version                      | Notes                                         |
| -------------- | ---------------------------- | --------------------------------------------- |
| Node.js        | 22.18 or newer (22 LTS)      | `.nvmrc` pins 22                              |
| pnpm           | 10.x                         | `corepack enable` installs the pinned version |
| Docker Compose | v2 or newer (optional)       | only for the container deployment             |
| OS             | Windows 10/11, Linux (macOS) | no native build tools needed                  |

## Quick start (local)

```bash
corepack enable
```

```bash
pnpm install
```

```bash
cp .env.example .env
```

```bash
pnpm dev
```

`pnpm dev` generates the database client, applies migrations and starts all four processes:

| Process   | URL                   | Purpose                                          |
| --------- | --------------------- | ------------------------------------------------ |
| dashboard | http://127.0.0.1:5173 | Web UI (Vite dev server, proxies to the API)     |
| api       | http://127.0.0.1:7001 | REST API, later SSE progress stream              |
| addon     | http://127.0.0.1:7000 | Stremio add-on endpoint (Phase 5)                |
| worker    | http://127.0.0.1:7002 | Background worker (health endpoint only on HTTP) |

On Windows PowerShell use `Copy-Item .env.example .env` instead of `cp`.

### Try it without an AI key

Put `MOCK_AI=true` in `.env`, run `pnpm dev`, open http://127.0.0.1:5173 and upload any
`.srt` file. Everything runs for real except the AI provider, which is simulated at no cost.

## Quick start (Docker)

```bash
docker compose up -d --build
```

Then open http://127.0.0.1:7001 (the API serves the built dashboard). Data lives in `./data`.
Ports are published on `127.0.0.1` only.

## Commands

| Command               | What it does                                                 |
| --------------------- | ------------------------------------------------------------ |
| `pnpm dev`            | Run everything in watch mode                                 |
| `pnpm build`          | Generate Prisma client, compile TypeScript, build UI         |
| `pnpm test`           | Run the Vitest suite (no real AI calls, temp databases)      |
| `pnpm test:e2e`       | Playwright: real processes and browser (see docs/TESTING.md) |
| `pnpm lint`           | ESLint (type-aware)                                          |
| `pnpm format`         | Prettier write (`format:check` to verify)                    |
| `pnpm typecheck`      | Strict type check of every package                           |
| `pnpm check`          | format check + lint + typecheck + test                       |
| `pnpm db:migrate`     | Apply pending migrations                                     |
| `pnpm db:migrate:dev` | Create a new migration after editing the schema              |
| `pnpm start:api`      | Run a built service (`start:worker`, `start:addon`)          |

## Repository layout

```
apps/
  api/         Fastify REST API; serves the dashboard in production
  worker/      Persistent background worker (translation jobs from Phase 3)
  addon/       Stremio add-on (official SDK): manifest, subtitles, translated files
  dashboard/   React + Vite control panel
packages/
  shared/              Version, health report types, logger with secret redaction
  config/              Environment loading/validation, storage paths, bind guard
  database/            Prisma schema, migrations, SQLite client
  subtitle-parser/     SRT decode / parse / serialize / validate
  translation-engine/  Languages, segmentation, prompt, validation, translation orchestration
  jobs/                Persistent jobs: states, progress, locking, recovery, events, worker
  ai-providers/        Claude, OpenAI, Gemini; retry, fallback, cost; `pnpm translate` CLI
  subtitle-sources/    Source adapters (OpenSubtitles), ranking, safe download, validation
config/        pricing.json — per-model prices for cost estimates
fixtures/      Representative subtitle files used by tests
e2e/           Playwright browser tests
data/          Runtime data: db/, subtitles/, cache/, logs/, jobs/ (git-ignored)
docs/          Product spec, architecture, roadmap, progress system, security, API, changelog
```

## Documentation

- [Product spec](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Translation engine](docs/TRANSLATION_ENGINE.md)
- [AI providers](docs/AI_PROVIDERS.md)
- [Subtitle sources and cache](docs/SOURCES_AND_CACHE.md)
- [Stremio add-on](docs/STREMIO.md)
- [Development roadmap](docs/DEVELOPMENT_ROADMAP.md)
- [Progress system](docs/PROGRESS_SYSTEM.md) — the core async job and progress design
- [Security](docs/SECURITY.md)
- [API](docs/API.md)
- [Changelog and decisions](docs/CHANGELOG.md)
