# Progress System — Async Jobs, Real Progress, Notifications

**This is the core of the application.** Implemented and accepted in Phase 3, before any
Stremio work. Code: `packages/jobs` (engine), `apps/worker` (process), `apps/api` (REST and
SSE), `apps/dashboard` (progress screen).

## Principles

1. A translation never runs inside an HTTP request. Requests only create or look up jobs.
2. The database is the single source of truth. SSE, the dashboard and Stremio are views.
3. Progress is derived from persisted, completed work. No timers, no invented percentages.
4. A job is complete only when the translated file is validated **and** saved.
5. Nothing is discarded silently: every failure is recorded and visible.

## Processing flow

1. A client (dashboard now, Stremio in Phase 5) submits a translation request.
2. An identical finished translation is returned immediately; an identical active job is
   reused; otherwise a job row is inserted and the source subtitle is stored.
3. The request returns at once with the job.
4. The worker claims the job and runs the pipeline, writing progress after every stage and
   every accepted segment.
5. Every write appends an event to `job_events` in the same transaction.
6. The API tails the event log and streams it to browsers over SSE.
7. Completion or failure creates one persistent notification.
8. The finished subtitle is stored under `data/subtitles/` and can be downloaded.

## Job states

`queued → locating_source → downloading_source → parsing → preparing_context → translating →
validating → saving → completed`

Terminal states: `completed`, `failed`, `cancelled`.

| From                     | To                                                       |
| ------------------------ | -------------------------------------------------------- |
| `queued`                 | `locating_source`, `cancelled`, `failed`                 |
| `locating_source`        | `downloading_source`, `queued`, `cancelled`, `failed`    |
| `downloading_source`     | `parsing`, `queued`, `cancelled`, `failed`               |
| `parsing`                | `preparing_context`, `queued`, `cancelled`, `failed`     |
| `preparing_context`      | `translating`, `queued`, `cancelled`, `failed`           |
| `translating`            | `validating`, `queued`, `cancelled`, `failed`            |
| `validating`             | `saving`, `translating`, `queued`, `cancelled`, `failed` |
| `saving`                 | `completed`, `queued`, `cancelled`, `failed`             |
| `failed`                 | `queued` (owner retry only)                              |
| `completed`, `cancelled` | — (final)                                                |

- `… → queued` from a processing state is recovery (dead worker) or a graceful worker
  shutdown; accepted segments are kept.
- Any transition not in the table throws `InvalidTransitionError` before anything is written.
- Every transition is a compare-and-set update (`WHERE id = ? AND state = ? AND lockedBy = ?`),
  so a stale or foreign writer changes nothing.
- For an uploaded subtitle there is nothing to locate or download; those states are passed
  through immediately (Phase 4 adds real discovery), so the state history always has the
  same shape.

## Job record

Table `translation_jobs`: id; translation key; state; origin; run number (`attempt`); media
title, type, IMDb id, season, episode; source language, target language, target script,
profile; provider and model (requested) and the models actually used; percentage; total and
completed entries; total and completed segments; current segment; estimated remaining
seconds; status detail; retry count; input/output tokens and estimated cost; error code,
message and stage; cancel-requested flag; lock owner and lease expiry; created, started,
updated and completed times. Elapsed time is derived from start and completion times.

The API exposes a `JobView` without internal fields (no paths, keys, locks).

## Duplicate prevention

The **translation key** is a hash of: source content hash, target language, target script,
profile, custom instructions, prompt version, engine version. The source hash is taken from
the parsed subtitle, so the same subtitle in another encoding or with other line endings is
the same source. Provider and model are not part of the key.

- `activeKey` equals the translation key while the job is active and is `NULL` once it is
  terminal. A plain unique index on `activeKey` therefore allows **at most one active job
  per key**. Simultaneous identical requests race on the insert; the loser gets the winner's
  job back.
- A completed job with the same key whose file still exists is returned instead of
  translating again (`reason: "completed"`). `force: true` overrides this.

## Worker, locking and recovery

- **Claim:** one `UPDATE … WHERE state = 'queued' AND lockedBy IS NULL` sets `lockedBy` (the
  worker's instance id) and `leaseExpiresAt`. Only one worker can win it.
- **Lease:** the worker renews its leases at least once a second (also the cancellation
  check). Every progress write requires `lockedBy = me`; a worker that lost its lease gets
  `LostLockError` and stops without writing.
- **Recovery:** each poll, jobs whose lease expired are re-queued with `attempt + 1`. Accepted
  segments are checkpoints (`job_segments`), so the next run resumes after the last accepted
  segment and reuses those translations as context. Default lease: 30 s.
- **Explicit failure state:** a job that has already used `JOB_MAX_ATTEMPTS` runs (default 3)
  is not re-queued; it becomes `failed` with `interrupted_by_restart`. Its segments are kept,
  and the owner can retry it.
- **Graceful shutdown:** on SIGTERM/SIGINT the worker aborts its jobs and returns them to
  `queued` immediately (no lease wait, no attempt increment).
- **Plan changes:** if the stored segments no longer match the segment plan (the configured
  segment size changed), they are discarded and translation restarts from the first segment.
- **Concurrency:** `WORKER_CONCURRENCY` jobs per worker; several workers may run.

SQLite in WAL mode plus write-first transactions make these claims safe across processes
without an external lock service.

## Cancellation

- A queued, unclaimed job is cancelled on the spot.
- For a job being processed the API sets `cancelRequested`. The worker sees it within about
  a second (and before every segment), aborts the in-flight AI request, stores nothing
  further, and **acknowledges** by moving the job to `cancelled`. Only then is the
  cancellation complete; no segment is processed afterwards.
- Partial segments are deleted, no file is published, no notification is created, and the
  translation key is free again.

## Real progress

| Stage                                | Weight | Percentage when the state is entered |
| ------------------------------------ | ------ | ------------------------------------ |
| Source discovery (`locating_source`) | 5%     | 0                                    |
| Download (`downloading_source`)      | 5%     | 5                                    |
| Parsing (`parsing`)                  | 5%     | 10                                   |
| Context (`preparing_context`)        | 10%    | 15                                   |
| Translation (`translating`)          | 65%    | 25 + 65 × accepted / total segments  |
| Validation (`validating`)            | 7%     | 90                                   |
| Saving (`saving`)                    | 3%     | 97                                   |
| `completed`                          |        | 100                                  |

`computePercentage` is one pure function of the stored state and segment counts, used for
every write, so the API, the event stream and the dashboard cannot disagree.

- A stage counts only once it has finished.
- Translation advances only when a segment was **accepted and stored**: the checkpoint row
  and the job's counters change in one transaction. Retries add nothing.
- 100 is written only by `completeJob`, after the file is on disk. Everything else is capped
  at 99.
- A changed segment count is recalculated from the stored counts (clamped to 0–1).
- A resumed job keeps the credit of its accepted segments while it passes the early stages
  again, so the percentage never goes backwards.
- `failed` and `cancelled` keep the percentage they had.

### Remaining-time estimate

Exponentially weighted time per subtitle entry, from wall-clock durations of the segments
completed in the current run (retries included), multiplied by the entries still to
translate. It is `null` until two segments have been measured — never a guess — and is
cleared after the translation stage. The dashboard counts it down between updates.

## Real-time delivery (SSE)

Server-Sent Events; WebSockets are not needed (server → browser only, native reconnect).

- `GET /api/v1/events`.
- On every connection the server sends a `snapshot` event (active jobs, the latest finished
  jobs, unread notifications, `lastEventId`) and then live events with ids greater than
  `lastEventId`. The snapshot's event id is read before its contents, so a change that
  lands in between is delivered again as a live event; applying a job view twice is harmless.
- Event ids are the auto-increment ids of `job_events`. Each event carries the complete job
  or notification, so events are idempotent and order-safe.
- Reconnection: the browser's `EventSource` reconnects by itself (`retry: 2000`). Because a
  reconnect starts with a fresh snapshot, state is restored exactly even if the API was
  restarted or events were pruned; `Last-Event-ID` is accepted but not required.
- The worker is a separate process, so the API tails the event log every 300 ms **only
  while a browser is connected** and fans out to all clients with one query. Browsers never
  poll.
- A comment line every 15 s keeps idle connections open; `X-Accel-Buffering: no` for proxies.
- The log is pruned to the newest 5000 events.

## Notifications

- Created by the worker in the same transaction as the terminal state change.
- Unique on (job, kind, run): **exactly one** notification per completion or failure of a
  run. A retried job that fails again is a new event with its own notification; recovery
  after a crash never duplicates one.
- Stored with read state, so they are shown when the dashboard is opened later.
- In the browser: an in-app list; desktop notifications only after the owner clicks
  "Enable desktop notifications" and the browser grants permission; optional sound, off by
  default. Each notification alerts once per page: live events and reconnect snapshots are
  de-duplicated by id, and unread notifications found on first load are listed without a
  pop-up.

## Failure and retry

| Layer            | Handles                                                 | Limit                              |
| ---------------- | ------------------------------------------------------- | ---------------------------------- |
| Provider manager | timeouts, rate limits, network, 5xx; fallback provider  | `AI_MAX_RETRIES` per provider      |
| Engine           | invalid output (wrong count, tags, script, commentary…) | `SEGMENT_MAX_ATTEMPTS` per segment |
| Job              | dead worker (lease expiry)                              | `JOB_MAX_ATTEMPTS` runs            |
| Owner            | `failed → queued` via Retry; resumes from kept segments | unlimited                          |

Provider retries, fallbacks and rejected answers are counted in `retryCount` and shown in
`statusDetail` while they happen. When limits are exhausted the job becomes `failed` with a
code (`provider_<kind>`, `segment_failed`, `validation_failed`, `save_failed`,
`source_missing`, `source_changed`, `interrupted_by_restart`, `internal_error`), the message
and the stage. Partial output is never published.

## Mandatory acceptance tests

| Test | Scenario            | Where it is verified                                                                                                               |
| ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A    | Long translation    | `packages/jobs` (130 entries, 3+ segments, exact percentage per segment); browser                                                  |
| B    | Browser refresh     | browser (`e2e`): same job id, progress restored, continues live                                                                    |
| C    | Browser closure     | `packages/jobs` (no client at all); browser: context closed, job completes                                                         |
| D    | Application restart | `packages/jobs` (worker killed, resumed, no segment redone; explicit failure state); browser with real processes killed by SIGKILL |
| E    | Duplicate requests  | `packages/jobs` (6 simultaneous requests → 1 job; two workers never share a job); browser                                          |
| F    | Cancellation        | `packages/jobs` (no call after acknowledgement; in-flight abort); browser                                                          |
| G    | Provider failure    | `packages/jobs` (timeout → retry; timeout → fallback; all fail → visible failure)                                                  |
| H    | Completion          | `packages/jobs` (100% only with the file on disk; save and validation failures)                                                    |
| I    | Notifications       | `packages/jobs` (one per completion/failure/run); browser (one alert across reconnects)                                            |
| J    | Real-time updates   | `apps/api` (SSE over real HTTP, reconnect); browser (API killed and restarted)                                                     |

Run them with `pnpm test` and `pnpm test:e2e`.

## Trying it without spending money

Set `MOCK_AI=true` (and optionally `MOCK_AI_DELAY_MS`) in `.env`, run `pnpm dev`, open the
dashboard and upload any `.srt`. The whole system runs for real; only the AI provider is
simulated.
