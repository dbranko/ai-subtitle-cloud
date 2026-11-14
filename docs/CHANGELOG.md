# Changelog and Decision Log

Newest first. Each phase records what was added and the decisions made, with reasons.

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
