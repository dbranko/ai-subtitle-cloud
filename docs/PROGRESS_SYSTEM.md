# Progress System — Async Jobs, Real Progress, Notifications

**This is the core of the application.** It is implemented and accepted in Phase 3, before
any Stremio work. This document is the design that phase must satisfy.

Status: **design**. Only the worker heartbeat (used for liveness and, later, dead-worker
detection) exists today.

## Principles

1. A translation never runs inside an HTTP request. Requests only create or look up jobs.
2. The database is the single source of truth. SSE, the dashboard and Stremio are views.
3. Progress is derived from persisted, completed work. No timers, no invented percentages.
4. A job is complete only when the translated file is validated **and** saved.
5. Nothing is discarded silently: every failure is recorded and visible.

## Processing flow

1. Stremio (or the dashboard) requests a translation.
2. Cache lookup by translation key → completed translation is returned immediately.
3. Otherwise the job for that key is created, or the existing active one is reused.
4. The request returns at once with a protocol-compatible response.
5. The worker claims the job and runs the pipeline, persisting progress after every stage
   and every segment.
6. Each persisted change appends a job event; the API streams events over SSE.
7. On completion or failure one persistent notification is created.
8. The finished subtitle is stored and becomes available to Stremio through a refresh /
   rediscovery mechanism that is verified in Phase 5.

## Job states

`queued → locating_source → downloading_source → parsing → preparing_context → translating →
validating → saving → completed`

Terminal states: `completed`, `failed`, `cancelled`.

Legal transitions:

| From                     | To                                                                             |
| ------------------------ | ------------------------------------------------------------------------------ |
| `queued`                 | `locating_source`, `cancelled`, `failed`                                       |
| `locating_source`        | `downloading_source`, `cancelled`, `failed`                                    |
| `downloading_source`     | `parsing`, `cancelled`, `failed`                                               |
| `parsing`                | `preparing_context`, `cancelled`, `failed`                                     |
| `preparing_context`      | `translating`, `cancelled`, `failed`                                           |
| `translating`            | `validating`, `cancelled`, `failed`                                            |
| `validating`             | `saving`, `translating` (re-translate invalid segments), `cancelled`, `failed` |
| `saving`                 | `completed`, `cancelled`, `failed`                                             |
| any non-terminal         | `queued` (recovery re-queue after a dead worker)                               |
| `failed`                 | `queued` (explicit owner retry only)                                           |
| `completed`, `cancelled` | — (none)                                                                       |

Stages that do not apply (e.g. a local upload has nothing to locate or download) are passed
through instantly; they are not skipped, so the state history is always the same shape.
Any transition not in the table is rejected with an error and changes nothing. Transitions
are applied with a compare-and-set update (`WHERE id = ? AND state = ?`) so two writers
cannot both succeed.

## Job record

Each job tracks: unique job ID; translation key; media title; IMDb ID (when available);
season/episode; source language; target language; target script; profile; provider; model;
state; percentage; completed segments; total segments; current segment; created, started,
last-update and completion times; elapsed time; estimated remaining time (when measurable);
retry count; error information (code, message, stage); lock owner and lease expiry;
cancellation-requested flag.

## Duplicate prevention

The **translation key** is a hash of: source subtitle hash, target language, target script,
translation profile, prompt version, engine version. Equivalent requests produce the same
key.

- A partial unique index allows at most one **active** (non-terminal) job per key. Creating
  a job is "insert, or return the existing active job" in one transaction, so two
  simultaneous requests cannot create two jobs.
- A completed translation for the key is served from the cache; no job is created.

When the source subtitle is not known yet (automatic mode, before discovery), a provisional
key from the media identity (IMDb ID, season, episode, video hash, target language/script,
profile) deduplicates requests until the source hash is known.

## Worker, locking and recovery

- The worker claims a job with an atomic update that sets `lockedBy = <instanceId>` and
  `leaseExpiresAt = now + lease`, only if the job is unlocked or its lease has expired.
- While working it renews the lease together with its heartbeat. Every progress write
  carries `WHERE lockedBy = <me>`; a worker that lost its lease cannot write and stops.
- **Recovery:** on startup, and periodically, jobs whose lease expired (worker died, machine
  restarted) are re-queued. Completed segments are persisted per segment, so the job resumes
  from the first unfinished segment instead of starting over. If a job cannot be resumed
  safely it is moved to `failed` with an explicit, recoverable error
  (`interrupted_by_restart`) — never left looking active.
- SQLite WAL plus single-statement compare-and-set updates make these claims safe across
  processes without an external lock service.

## Cancellation

The API sets `cancelRequested`. The worker checks the flag before each stage and each
segment; it finishes or aborts the in-flight AI request, writes no further segments, moves
the job to `cancelled` and releases the lock. Cancellation is acknowledged only when the job
row is `cancelled`; after that no segment is processed. Working files of the job are removed.

## Real progress

Weighted stages:

| Stage                | Weight |
| -------------------- | ------ |
| Source discovery     | 5%     |
| Download and parsing | 10%    |
| Context preparation  | 10%    |
| Translation          | 65%    |
| Validation           | 7%     |
| Saving               | 3%     |

```
percentage = sum(weights of fully completed stages)
           + weight(current stage) × fraction(current stage)
```

- During `translating`, `fraction = completedSegments / totalSegments`, counted from
  persisted successful segments only. A retried segment counts once, when it succeeds.
- Other stages contribute their weight only when they have finished.
- The value is capped at **99%** until the job row is `completed`; 100% is written in the
  same transaction that records the saved file.
- If `totalSegments` changes (e.g. re-segmentation after a provider limit), the fraction is
  recomputed from the new counts and the stored percentage may only be corrected, with an
  event explaining why — it is never silently inflated.
- Percentage is always computed by one pure function from the job row, so the API, SSE and
  dashboard cannot disagree.

### Remaining-time estimate

Based on measured durations of completed segments of this job (moving average, weighted
toward recent segments), multiplied by remaining segments, plus the remaining fixed stages.
No estimate is shown until at least two segments have completed; it is `null` rather than
a guess.

## Real-time delivery (SSE)

Server-Sent Events are used; WebSockets are not needed because communication is
server → browser only, and SSE reconnects natively.

- `GET /api/v1/events` (see [API.md](API.md)).
- On connect the server sends a **snapshot** of all active jobs and unread notifications,
  then live events.
- Every event has a monotonically increasing ID from the persistent `job_events` table.
  On reconnect the browser sends `Last-Event-ID`; the server replays everything after it,
  or sends a fresh snapshot if that is no longer available.
- Because the worker is a separate process, the API tails the event table (short interval,
  indexed by ID) and fans out to connected clients. Browsers hold one long-lived connection
  and never poll.
- Heartbeat comments keep the connection alive through proxies.
- State lives in the database, never in the SSE connection: closing every browser changes
  nothing about a running job.

## Notifications

- Created by the worker in the same transaction as the terminal state change, with a unique
  constraint on (job, kind) → **exactly one** notification per completion or failure.
- Persisted with read/unread state, so they are shown when the dashboard is opened later.
- Delivered in-app over SSE; shown as a browser desktop notification only after the owner
  explicitly enables it; optional sound, off by default. The client de-duplicates by
  notification ID so reconnects never re-notify.

## Failure and retry

- Transient provider errors (timeouts, rate limits, 5xx) are retried per segment with
  backoff, up to a configured limit; then the fallback provider is tried.
- Invalid segment output (wrong entry count, commentary, empty lines) counts as a failed
  attempt and is retried.
- When limits are exhausted the job becomes `failed` with stage, segment and error recorded.
  Partial output is never published as a finished subtitle.

## Mandatory acceptance tests (Phase 3)

| Test | Scenario                                          | Must show                                                   |
| ---- | ------------------------------------------------- | ----------------------------------------------------------- |
| A    | Long translation (≥100 entries, several segments) | progress advances as each segment completes                 |
| B    | Browser refresh                                   | same job continues; current progress restored               |
| C    | Browser closure                                   | translation continues independently                         |
| D    | Application restart                               | job recovered safely or explicit recoverable failure state  |
| E    | Duplicate requests                                | only one active job                                         |
| F    | Cancellation                                      | no segment processed after cancellation is acknowledged     |
| G    | Provider failure                                  | retry logic and fallback behave as specified                |
| H    | Completion                                        | 100% only after the translated file is saved                |
| I    | Notifications                                     | exactly one notification per completion and per failure     |
| J    | Real-time updates                                 | SSE updates and automatic reconnection without losing state |

Phase 3 is not complete, and Stremio work does not start, while any of these fails.
