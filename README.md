# AI Subtitle Cloud

Personal, self-hosted AI subtitle translator for Stremio. One owner, no accounts, no billing.

It finds a source subtitle for a movie or episode, translates it with an AI provider
(Claude, OpenAI or Gemini) in a persistent background worker, shows real progress in a
private dashboard, and serves the finished translation to Stremio.

> **Status: Phases 0–2 complete.** Foundation, SRT translation engine and AI providers
> (Claude, OpenAI, Gemini with retry, fallback and cost estimates) exist, and subtitles can be
> translated from the command line. The background job engine and progress system are next —
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

## Quick start (Docker)

```bash
docker compose up -d --build
```

Then open http://127.0.0.1:7001 (the API serves the built dashboard). Data lives in `./data`.
Ports are published on `127.0.0.1` only.

## Commands

| Command               | What it does                                            |
| --------------------- | ------------------------------------------------------- |
| `pnpm dev`            | Run everything in watch mode                            |
| `pnpm build`          | Generate Prisma client, compile TypeScript, build UI    |
| `pnpm test`           | Run the Vitest suite (no real AI calls, temp databases) |
| `pnpm lint`           | ESLint (type-aware)                                     |
| `pnpm format`         | Prettier write (`format:check` to verify)               |
| `pnpm typecheck`      | Strict type check of every package                      |
| `pnpm check`          | format check + lint + typecheck + test                  |
| `pnpm db:migrate`     | Apply pending migrations                                |
| `pnpm db:migrate:dev` | Create a new migration after editing the schema         |
| `pnpm start:api`      | Run a built service (`start:worker`, `start:addon`)     |

## Repository layout

```
apps/
  api/         Fastify REST API; serves the dashboard in production
  worker/      Persistent background worker (translation jobs from Phase 3)
  addon/       Stremio add-on server (Phase 5)
  dashboard/   React + Vite control panel
packages/
  shared/              Version, health report types, logger with secret redaction
  config/              Environment loading/validation, storage paths, bind guard
  database/            Prisma schema, migrations, SQLite client
  subtitle-parser/     SRT decode / parse / serialize / validate
  translation-engine/  Languages, segmentation, prompt, validation, translation orchestration
  ai-providers/        Claude, OpenAI, Gemini; retry, fallback, cost; `pnpm translate` CLI
  subtitle-sources/    (Phase 4) Local uploads, OpenSubtitles
config/        pricing.json — per-model prices for cost estimates
fixtures/      Representative subtitle files used by tests
data/          Runtime data: db/, subtitles/, cache/, logs/, jobs/ (git-ignored)
docs/          Product spec, architecture, roadmap, progress system, security, API, changelog
```

## Documentation

- [Product spec](docs/PRODUCT_SPEC.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Translation engine](docs/TRANSLATION_ENGINE.md)
- [AI providers](docs/AI_PROVIDERS.md)
- [Development roadmap](docs/DEVELOPMENT_ROADMAP.md)
- [Progress system](docs/PROGRESS_SYSTEM.md) — the core async job and progress design
- [Security](docs/SECURITY.md)
- [API](docs/API.md)
- [Changelog and decisions](docs/CHANGELOG.md)
