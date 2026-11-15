# Testing

Two suites. Neither calls a real AI provider or a real subtitle site; both are free to run.

| Command         | What runs                                                                   |
| --------------- | --------------------------------------------------------------------------- |
| `pnpm test`     | Vitest: unit and integration tests, each with its own temporary SQLite file |
| `pnpm test:e2e` | Playwright: real `api`, `worker` and `addon` processes and a real browser   |
| `pnpm check`    | format check + lint + typecheck + `pnpm test`                               |

A separate, manual live test with a real provider is described in
[AI_PROVIDERS.md](AI_PROVIDERS.md); it costs credits and never runs automatically.

## What "integration" means here

The integration tests run the **production code path** with only the network replaced:

- AI: the worker uses the production translator factory, which builds the real Claude,
  OpenAI and Gemini adapters on the official SDKs. A fake HTTP transport answers in each
  provider's real wire format — streamed Claude events, OpenAI Responses, Gemini
  `generateContent` — including `429` with `retry-after`, `529` overloaded, `500`, `401` and
  answers cut off at the output limit.
- Subtitles: the real OpenSubtitles adapter (search → download link → file, through the SSRF
  guard) talks to a fake transport.
- Everything else is real: SQLite database, worker, translation engine, validation, files on
  disk, translation cache.

The end-to-end tests go one step further: separate operating-system processes, killed with
`SIGKILL` to simulate crashes, and Chromium driving the dashboard.

## Scenario matrix (Phase 7)

| Scenario                              | Where it is tested                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Movie, found and translated           | `packages/jobs/src/language-matrix.test.ts` (movie × 3 languages)                                                               |
| Episode, found and translated         | `language-matrix.test.ts` (episode × 3 languages); `e2e/stremio.spec.ts`                                                        |
| Serbian Latin                         | `language-matrix.test.ts`; Cyrillic answer transliterated, not rejected                                                         |
| Serbian Cyrillic                      | `language-matrix.test.ts`; `e2e/stremio.spec.ts`, `e2e/reliability.spec.ts`                                                     |
| Croatian                              | `language-matrix.test.ts`; Cyrillic answer rejected, job fails visibly, nothing published                                       |
| Timing and entry count preserved      | `language-matrix.test.ts` (every entry's start/end compared with the source)                                                    |
| Provider failure → fallback           | `providers-integration.test.ts` (529 overloaded, 401 rejected key)                                                              |
| Every provider down → failure → retry | `providers-integration.test.ts` (finished segments kept, only the rest translated again)                                        |
| Rate limit with `retry-after`         | `providers-integration.test.ts` (waits exactly as asked, no fallback)                                                           |
| Rate limit without `retry-after`      | `providers-integration.test.ts` (Gemini, exponential back-off)                                                                  |
| Very long `retry-after`               | `providers-integration.test.ts` (not waited out; fallback used)                                                                 |
| Answer cut off at the output limit    | `providers-integration.test.ts` (segment asked again; job completes)                                                            |
| Cache reuse                           | `language-matrix.test.ts` (second request: no search, no AI call); `sources-cache.test.ts`                                      |
| Restart / crash                       | `e2e/progress.spec.ts` TEST D; `e2e/reliability.spec.ts` (worker crash + add-on restart, Stremio)                               |
| Cancellation                          | `e2e/progress.spec.ts` TEST F; `providers-integration.test.ts` (during a rate-limit pause)                                      |
| Concurrent jobs                       | `e2e/dashboard.spec.ts` (two in parallel); `acceptance.test.ts` (two workers, one job)                                          |
| Stremio client compatibility          | `e2e/reliability.spec.ts` (extras in any order, encoded names, CORS/PNA preflight, HEAD, 50 parallel requests, unsupported ids) |
| Hostile input (parser)                | `packages/subtitle-parser/src/fuzz.test.ts` (3500 mutated/random files, slow-regex inputs)                                      |
| Hostile input (API)                   | `apps/api/src/fuzz.test.ts` (600 mutated bodies, broken JSON, hostile ids and queries)                                          |
| Hostile input (add-on)                | `apps/addon/src/fuzz.test.ts` (1400 random Stremio-like URLs, with and without token)                                           |
| A website using the API (CSRF)        | `e2e/csrf.spec.ts` (real browser; shown to fail without the server check)                                                       |
| DNS rebinding                         | `apps/api/src/api.test.ts`, `apps/addon/src/app.test.ts`, `e2e/csrf.spec.ts`                                                    |
| Secrets never in logs or responses    | `packages/shared/src/logger.test.ts`; `e2e/dashboard.spec.ts` (API key never reaches the browser)                               |

Fuzz tests use a seeded generator: a failure names its seed, and the same seed reproduces it.

## Not covered automatically

- Stremio itself cannot run in the test environment; the add-on is tested as a Stremio
  client sees it over HTTP. Real-Stremio results are recorded in [STREMIO.md](STREMIO.md).
- Translation quality (does the Serbian read naturally?) needs a human; the automated tests
  check structure, script, timing and markup, not style.
