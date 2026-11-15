# Changelog and Decision Log

Newest first. Each phase records what was added and the decisions made, with reasons.

## Phase 8 (in progress) — Home server deployment (2026-11-15)

### Added

- `docker-compose.home.yml`: publishes the dashboard/API (7001) and the add-on (7000) on the
  server's address for a reverse proxy; refuses to start without `AUTH_TOKEN` and the public
  URLs.
- `scripts/home-setup.sh`: checks Docker, prepares `.env` (generated token, public address,
  file owner; existing values kept), builds and starts, waits for readiness, and prints the
  exact Nginx Proxy Manager settings and the Stremio address. Safe to re-run.
- `scripts/home-check.sh`, `home-backup.sh`, `home-restore.sh`, `home-update.sh`.
- `docs/DEPLOY_HOME.md`: step-by-step guide (Serbian) for the owner.

### Decisions

1. **Use the owner's existing Nginx Proxy Manager** instead of adding a proxy: it already
   owns ports 80/443 and issues Let's Encrypt certificates. A dedicated Caddy proxy was
   started and dropped.
2. **Forward to the server's address, not a shared Docker network.** Works wherever NPM
   runs (container, host, other machine) with no network names to look up; the ports stay
   inside the home network because only 80/443 are forwarded on the router, and every
   route needs the token.
3. **Home network only through an NPM Access List** (with the token as second layer); the
   setup script prints the network range to allow.
4. **Backups pause the services for a few seconds** so the SQLite file is consistent without
   adding a database tool to the image; restore never deletes the current data (moved aside).

### Fixed during testing

- Restore rejected valid archives (`tar | grep -q` under `pipefail`); backup returned before
  the services were ready again.

## Phase 7 — Full integration and reliability (2026-11-15, approved)

### Added

- Integration tests through the production translator factory with the real Claude, OpenAI
  and Gemini SDK adapters over a fake HTTP transport (`providers-integration.test.ts`), and
  movie/episode × `sr-Latn` / `sr-Cyrl` / `hr` through the real OpenSubtitles adapter
  (`language-matrix.test.ts`). Test seams: `createDefaultTranslatorFactory({ fetch, sleep })`
  and the `@asc/ai-providers/testing` export.
- Seeded fuzz tests for the SRT parser, the API and the add-on.
- Playwright: `e2e/reliability.spec.ts` (Stremio request shapes, crash and restart during a
  Stremio translation, hostile addresses, dashboard under CSP) and `e2e/csrf.spec.ts`.
- `docs/TESTING.md`: how the suites work and which test covers which scenario.
- `ALLOWED_HOSTS` setting; browser protections and security headers (see SECURITY.md).

### Fixed (found by the new tests)

1. **One cut-off or empty AI answer failed the whole translation.** A reply truncated at the
   output limit (or empty) from every provider now counts as a rejected answer for that
   segment: the segment is asked again, within the usual 3 attempts.
2. **Add-on: a malformed address could leave a request unanswered.** With `AUTH_TOKEN`, a
   `%` escape such as `/%E0%A4%A/manifest.json` threw an uncaught `URIError` in the token
   check. Now refused with 400; the process is unaffected.
3. **The access token was written to the API log** for every event-stream connection
   (`?token=` in the request URL). Request URLs are now logged with secret query values
   replaced by `[redacted]`.
4. **Dashboard: a malformed job link (`#/jobs/%E0`) crashed the page.** It now shows "Job not
   found".
5. **SRT parser: a number of more than 9 digits above a timing line was taken as the index**,
   became a float (`3.3e+21`) and did not survive saving and loading. Such a line is now text.
6. **Dependency audit:** `path-to-regexp` 0.1.7 in the Stremio SDK router (ReDoS) and an old
   `tmp` overridden with fixed releases.

### Decisions

1. **Host allow-list only without a token.** DNS rebinding is harmless when every request
   needs the token, and tunnels/reverse proxies with a token keep working under any name.
   Without a token, the public URLs and `ALLOWED_HOSTS` extend the list, so an existing setup
   that already set `ADDON_PUBLIC_URL` / `DASHBOARD_PUBLIC_URL` keeps working.
2. **CSRF check by `Origin`/`Sec-Fetch-Site`, not tokens in forms.** The dashboard is a
   same-origin script; browsers always send these headers on cross-site writes. Clients that
   are not browsers (curl, scripts) send neither and are unaffected.
3. **The add-on stays open to cross-site requests**, as Stremio Web requires; the daily limit
   remains the cap on what a page could start (documented as residual risk).
4. **Truncated/empty answers retried at segment level, refusals not.** A refusal tends to
   repeat and is better shown to the owner than retried silently.

## Phase 6 — Dashboard and notifications (2026-11-15)

### Added

- `GET /api/v1/jobs/:id/events`: a job's timeline — creation, state changes, new status
  details (e.g. a rejected AI answer), the outcome and its notification; plain progress
  updates are folded away. Uses the `job_events(jobId, id)` index.
- Dashboard navigation with hash routes: Overview, History, Settings, job details.
- Overview: AI summary (provider, model, fallback, key status), active jobs, notifications,
  Stremio card, recent jobs with a failed count, recent activity.
- Job details page with all facts, live progress, cancel / retry / download and the timeline.
- History page: filter by outcome, pages of 20, download links; refreshes when a job finishes.
- Settings page: AI, write-only API keys, sources, Stremio, defaults, cache limits and
  "Clean up now".
- Tests: API timeline and settings validation (unit); Playwright `e2e/dashboard.spec.ts`
  (parallel jobs, settings without key leakage, history, details).

### Decisions

1. **Hash routes, no router library.** Four pages do not justify a dependency; hash routes
   need no server configuration and survive reloads.
2. **Timeline from the existing event log** rather than a new table. The log is bounded
   (5000 events), so very old jobs may show `truncated` — said on the page, not hidden.
3. **Saving settings stores every shown value**, so once saved they override `.env`. The page
   says so. Keys are the exception: an empty key field means "keep the current key".
4. **History lists finished jobs only**; active ones are on the overview with live progress.

## Translation engine: formatting tags repaired instead of retried (2026-11-15)

Seen in a real job: `Segment 6: answer rejected (id 209: formatting tags must be copied
exactly from the source.) — retrying`. One entry with a dropped `<i>` made the whole segment
go back to the AI, and three such answers in a row would have failed the whole job.

### Changed

- Tag comparison ignores case, attribute quotes and spacing.
- Tags that wrap a whole entry or whole lines are restored from the source before
  validation (no AI retry, no extra cost); `stats.repairedMarkupEntries` counts them.
- Last attempt with only inline-tag problems left: those entries are kept without inline
  tags (positioning `{\an8}` kept) and reported as `markup_simplified` warnings, instead of
  failing the job.

### Decisions

- Inline tags (`respond to <i>Pier 14</i>.`) are never placed by guessing — that case is still
  retried; dropping an italic is preferred over failing a two-hour translation, and it is
  reported, not hidden.

## Stremio: translation only from the subtitle menu (owner request, 2026-11-15)

### Changed

- Opening a video in Stremio **never** starts a translation. Stremio's subtitle menu offers
  `<language> · AI translate` for every language not translated yet; picking it loads
  `/translate/<lang>/<type>/<id>.srt`, which starts the job (subject to the daily limit) and
  returns a status message. While the job runs the entry shows `· AI <n>%`; when it is
  finished the real subtitle replaces it.
- **Automatic mode is removed** (`STREMIO_AUTO_TRANSLATE` and the `autoTranslate` setting no
  longer exist; a leftover value in `.env` or in saved settings is ignored). The old manual
  mode is replaced by the menu entry as well.

### Decisions

1. **Phase 5 decision 2 is revised at the owner's request.** The only thing the Stremio
   protocol lets a viewer "choose" is a subtitle entry, and Stremio loads an entry's URL only
   when it is selected — so the start action has to be an entry. Its content is an honest
   status message ("AI prevod je pokrenut…", "AI prevod u toku: 42%"), worded as a status
   and never as a translation, and the entry's label is not a language code, so Stremio's
   automatic subtitle choice can never select it.
2. **Only GET starts a translation; HEAD is not routed**, so a probe cannot start a paid job.
3. **The entry carries the video hash, size and file name** in its query string, so the job
   ranks source subtitles as precisely as before.

## Phase 5 — Stremio add-on (2026-11-15)

### Added

- `apps/addon`: Stremio add-on on the official SDK — manifest, movie and series subtitle
  handlers, translated file delivery, landing page, Configure redirect, token-protected
  address.
- `@asc/jobs`: look-only media requests (`create: false`), job counter for the daily limit,
  titles taken from the source for jobs that only have an IMDb id.
- Source library stores titles (migration `source_title`).
- API: `GET /api/v1/stremio`. Dashboard: Stremio card (install link, address, mode, limit),
  "requested by Stremio" marker on jobs.
- Settings: `STREMIO_*`, `ADDON_PUBLIC_URL`, `DASHBOARD_PUBLIC_URL`.
- End-to-end test with the add-on as a real process (`e2e/stremio.spec.ts`).
- `docs/STREMIO.md`, including the Stremio Desktop test checklist.

### Decisions

1. **No in-player progress is claimed.** The SDK's documentation and router source show no
   progress, notification or refresh mechanism for subtitles. The add-on lists finished
   translations only; progress lives in the dashboard.
2. **Never a placeholder subtitle.** An unfinished translation is simply absent from the
   list. A "translating…" cue would be a status page pretending to be a subtitle.
3. **Unfinished answers are not cacheable (`max-age=0`); complete answers for 5 minutes.**
   Short, so that a forced re-translation or cache cleanup is reflected quickly.
4. **The SDK router is mounted inside the existing Fastify server**, so health checks,
   logging, the token check and file delivery share one process and port.
5. **The access token is a path prefix** (`/<token>/manifest.json`), not SDK "user data":
   Stremio then carries it automatically in every request, including subtitle file URLs.
6. **Configuration is server-side.** One owner, one installation: the manifest declares no
   user settings, and the Configure button opens the dashboard.
7. **A daily cap on automatic translations** (default 20) protects against browsing in
   Stremio turning into many paid translations.
8. **ISO 639-2 codes** for `lang`; both Serbian scripts are `srp`, with an override for
   labels. Bibliographic codes where the two variants differ.
9. **Failures never break playback:** a configuration problem or an unknown id is answered
   with an empty subtitle list, not an error.
10. **The SDK is loaded with `require`.** It is a CommonJS package; a named ESM import
    worked under the test runner but failed in a plain Node process. The end-to-end test now
    starts the built add-on, so this class of error is caught.

### Verified

- 529 automated tests and 11 browser/process tests; the add-on in Docker Compose.

### Known limitations / open items

- **First Stremio Desktop test (6.0.7, Windows): the local address did not work.** Stremio
  reported "failed to get addon manifest" for `http://127.0.0.1:7000`, and the add-on
  received no request at all. An HTTPS address is needed with this version; see the field
  report in STREMIO.md. The add-on now also sends `Access-Control-Allow-Private-Network`.
- **Everything after installation is still untested in Stremio Desktop or Stremio Web.** In particular, unverified: when the
  client asks for subtitles again after a translation finishes (the refresh behaviour),
  whether it honours `max-age=0`, how the language is displayed, and which ISO 639-2 variant
  it expects for languages other than Serbian, Croatian and English.
- Stremio on another device needs HTTPS and `ADDON_PUBLIC_URL`; that deployment is Phase 8.
- Only IMDb ids are supported (`tt…`); other catalogs get no subtitles.
- With several target languages, each is a separate translation (and cost).

## Phase 4 — Subtitle sources and cache (2026-11-14)

### Added

- `@asc/subtitle-sources`: `SubtitleSource` adapter interface, OpenSubtitles adapter (official
  API), candidate ranking, SSRF-safe downloader, source validation, language-code mapping.
- `@asc/jobs`: source library (`source_subtitles`), translation cache (`translations`),
  media links (`media_links`), `requestMediaTranslation`, cache statistics and cleanup, source
  discovery and cache reuse inside the worker pipeline.
- Database migration `sources_cache`.
- API: `POST /api/v1/jobs/from-media`, `POST /api/v1/sources/search`, `GET /api/v1/cache`,
  `POST /api/v1/cache/cleanup`; sources in `/api/v1/meta`; `cacheHit` on jobs.
- Dashboard: "Translate by IMDb ID" form; "reused from cache" marker.
- Settings: `OPENSUBTITLES_*`, `SOURCE_*`, `CACHE_*`.
- `docs/SOURCES_AND_CACHE.md`.

### Decisions

1. **Source discovery runs in the worker, never in a request.** A media request only creates
   or finds a job; searching and downloading are the job's first two stages.
2. **Sources are stored once per content.** Uploads and downloads share one library, which
   is also the "local source" and the store of original subtitles the cache must keep.
3. **Two keys.** The _media key_ identifies what was asked for (title, video file, target);
   the _translation key_ identifies what is translated (subtitle content, target, prompt
   and engine version). The cache is keyed by content, so different video files that lead to
   the same subtitle share one translation.
4. **An owner upload always wins the ranking**, even over a hash-matched download: it was
   put there on purpose.
5. **A subtitle in the target language is never used as a source**, and machine-translated
   subtitles are strongly avoided.
6. **A job that would duplicate a running translation waits and then reuses the result**
   instead of failing or translating twice.
7. **Failed searches are remembered for `SOURCE_RETRY_MINUTES`**, so repeated plays of a
   title without subtitles cause one search and one notification, not one per play.
8. **A cache hit still passes every job state** (instantly) and completes normally, with
   `cacheHit: true`; no special terminal path.
9. **Cleanup protects by source:** nothing connected to an active job's source is removed.
   Uploads are never removed. Limits default to "keep everything".
10. **Cache files stay where job outputs already were** (subtitles directory); sources live
    under the cache directory. `data/jobs/` is no longer used.
11. **Only SRT sources are accepted** (`sub_format: "srt"` is requested; anything else is
    rejected by validation).
12. **A concurrency bug was fixed:** temporary file names for atomic writes were not unique
    within one process and millisecond; simultaneous identical uploads could fail.

### Verified

- 500 automated tests, 9 browser tests.
- Sources, matching, validation, SSRF protection and the OpenSubtitles adapter are tested
  against simulated responses; the library, cache, duplicate handling and cleanup against
  the real worker and database.

### Known limitations / open items

- **OpenSubtitles is verified live only in part.** With the owner's key, a movie search by
  IMDb id, the download endpoint and the file download worked, and one title went through a
  full job and the cache (AI simulated, to verify the source side without cost). That run
  added one improvement: subtitles flagged `foreign_parts_only` are now strongly avoided.
  Episode search, video-hash matching, account login and the quota error are still tested
  only against simulated responses.
- Without an OpenSubtitles account the daily download quota is very small (a handful of
  files); configure the account for regular use.
- The download safety check resolves host names itself; in an environment where DNS is only
  available through a proxy (as in the development sandbox) remote downloads are refused.
  A normal machine or Docker host is not affected.
- The source search is limited to the configured source languages (`SOURCE_LANGUAGES`,
  default English).
- No video hash is computed here; it must come from the player (Stremio provides it).
- Existing databases created before this phase keep working, but jobs created earlier refer
  to source files in the old location and cannot be retried.
- The dashboard has only a minimal form for media requests; source selection UI is Phase 6.

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
