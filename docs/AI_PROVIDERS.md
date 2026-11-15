# AI Providers

Package `@asc/ai-providers`. Three providers behind one interface, one manager that owns
retries, timeouts, fallback and cost, and a configurable price table.

## Layers

```
translation engine ── SegmentTranslator ──▶ createLlmTranslator   (prompt + response parsing)
                                              │  LlmClient.complete({ system, user })
                                              ▼
                                        provider manager           (timeout, retry, fallback, cost)
                                              │  AiProvider.complete({ model, effort, … })
                              ┌───────────────┼────────────────┐
                              ▼               ▼                ▼
                          Anthropic         OpenAI           Gemini   (official SDKs)
```

A provider only turns a prompt into text. The prompt, the response parser and all validation
live in the engine, so every provider is asked the same question and judged the same way.

## Providers

| Provider  | SDK                 | API                     | Default model      |
| --------- | ------------------- | ----------------------- | ------------------ |
| Anthropic | `@anthropic-ai/sdk` | Messages API, streaming | `claude-opus-5-5`  |
| OpenAI    | `openai`            | Responses API           | `gpt-6.1-sol`      |
| Gemini    | `@google/genai`     | `generateContent`       | `gemini-3.8-flash` |

Any model id the provider accepts can be configured; the suggestions for the settings UI are
in `models.ts`.

All three request structured JSON output with the same schema
(`{"translations":[{"id","text"}]}`), which makes malformed replies rare. The engine's
tolerant parser and validation remain the actual safety net.

### Provider-specific behaviour

**Anthropic**

- Streaming with `finalMessage()`, so long generations cannot hit HTTP idle timeouts.
- Reasoning depth through `output_config.effort`. `temperature` is **not sent**: current
  Claude models reject sampling parameters. Thinking is left at the model default (adaptive).
- The system prompt is marked cacheable (identical for every segment of a job). It only takes
  effect when the prompt exceeds the model's minimum cacheable size.
- On models that support it (Opus 5.5, Opus 5, Sonnet 5.5, Fable 5.1/5.2) the request opts
  into Anthropic's **server-side refusal fallback**: if a safety classifier declines a
  segment, the API re-runs it on another Claude model inside the same call. The model that
  actually answered is recorded and priced.
- The endpoint is fixed to `https://api.anthropic.com`; `ANTHROPIC_BASE_URL` and
  `ANTHROPIC_AUTH_TOKEN` from the environment are deliberately ignored.

**OpenAI**

- Responses API with `text.format` = strict JSON schema and `reasoning.effort`.
- `store: false`: subtitles are not kept on OpenAI's side.
- `temperature` is sent only when configured. If the chosen model rejects it, the request
  fails with a clear `bad_request` error — leave `AI_TEMPERATURE` empty in that case.
- A 429 with `insufficient_quota` is treated as a billing problem, not as a rate limit.

**Gemini**

- `responseMimeType: application/json` with `responseJsonSchema`.
- Effort maps to `thinkingConfig.thinkingLevel` on Gemini 3 and later; older models do not
  receive it.
- Thinking tokens are added to output tokens (they are billed as output).
- An invalid key arrives as HTTP 400 and is recognised as an authentication error.

## Settings

Environment variables (`.env`), all optional except the key of the provider you use:

| Variable                 | Default               | Meaning                                                     |
| ------------------------ | --------------------- | ----------------------------------------------------------- |
| `ANTHROPIC_API_KEY`      | —                     | Claude key                                                  |
| `OPENAI_API_KEY`         | —                     | OpenAI key                                                  |
| `GEMINI_API_KEY`         | —                     | Gemini key                                                  |
| `AI_PROVIDER`            | `anthropic`           | Preferred provider                                          |
| `AI_MODEL`               | provider default      | Preferred model                                             |
| `AI_FALLBACK_PROVIDER`   | —                     | Second choice (may be the same provider with another model) |
| `AI_FALLBACK_MODEL`      | provider default      | Fallback model                                              |
| `AI_EFFORT`              | `medium`              | `low` / `medium` / `high` reasoning depth                   |
| `AI_TEMPERATURE`         | —                     | 0–2, OpenAI and Gemini only                                 |
| `AI_MAX_OUTPUT_TOKENS`   | `32000`               | Output limit per request                                    |
| `AI_MAX_SEGMENT_ENTRIES` | `60`                  | Largest segment (entries per request)                       |
| `AI_TRANSLATION_PROFILE` | `natural`             | Default quality profile                                     |
| `AI_REQUEST_TIMEOUT_MS`  | `180000`              | Time limit for one request                                  |
| `AI_MAX_RETRIES`         | `3`                   | Retries per provider for temporary failures                 |
| `PRICING_FILE`           | `config/pricing.json` | Price table                                                 |

A single request can override provider, model, fallback, effort and temperature
(`ProviderSelection`) — this is what manual translations from the dashboard use. The
dashboard's Settings page edits the same settings (and the API keys, stored encrypted);
values saved there override the environment and apply without a restart.

"Temperature or equivalent": `AI_EFFORT` is the setting that works on all three providers
and is the recommended control. `AI_TEMPERATURE` exists for providers that accept it.

## Errors

Every failure becomes a `ProviderError` with a `kind`:

| Kind          | Typical cause                   | Retried | Falls back    | Disables provider |
| ------------- | ------------------------------- | ------- | ------------- | ----------------- |
| `rate_limit`  | HTTP 429                        | yes     | after retries | no                |
| `timeout`     | no answer within the time limit | yes     | after retries | no                |
| `network`     | cannot reach the provider       | yes     | after retries | no                |
| `server`      | HTTP 5xx                        | yes     | after retries | no                |
| `overloaded`  | HTTP 529 / 503                  | yes     | after retries | no                |
| `auth`        | invalid key, no permission      | no      | yes           | yes               |
| `billing`     | no credit / quota exhausted     | no      | yes           | yes               |
| `not_found`   | unknown or unavailable model    | no      | yes           | yes               |
| `bad_request` | unsupported parameter           | no      | yes           | no                |
| `refusal`     | safety filter declined          | no      | yes           | no                |
| `truncated`   | cut off at the output limit     | no      | yes           | no                |
| `empty`       | no text returned                | no      | yes           | no                |
| `unknown`     | anything else                   | no      | yes           | no                |
| `cancelled`   | caller aborted                  | no      | **no**        | no                |

Messages are shortened and never contain API keys.

## Manager policy

1. Call the preferred provider. Transient failures are retried with exponential backoff
   (1 s, 2 s, 4 s … capped at 30 s, with jitter). A `retry-after` header is honoured exactly;
   one longer than two minutes is not waited out.
2. When retries are exhausted or the failure is not transient, the fallback is tried with
   the same policy.
3. A provider that fails for a configuration reason (`auth`, `billing`, `not_found`) is
   skipped for the rest of that manager's life (one translation job), so a bad key costs one
   request, not one per segment.
4. A one-off failure (e.g. a refusal) does not disable anything: the next segment starts
   with the preferred provider again.
5. If everything fails, `AllProvidersFailedError` lists every cause.
6. Cancellation stops immediately — no retry, no fallback, also while waiting between
   retries.

The SDKs' own retries are switched off (`maxRetries: 0`) so there is exactly one retry
policy, and it is the tested one.

The manager emits events (`attempt_failed`, `fallback`, `provider_disabled`, `completed`)
that the job engine will record in Phase 3.

**Two retry layers, on purpose:** the manager retries _provider failures_; the engine
retries _invalid output_ (wrong entry count, wrong script, …) by asking again with the
problems listed. Each engine attempt goes through the manager, and each is paid for.

## Token usage and cost

Each call reports input and output tokens; the engine sums them per segment and per
translation (`stats.usage`). Output includes reasoning/thinking tokens for all providers.

Cost is an **estimate** from `config/pricing.json` (USD per million tokens, per provider and
model). Edit the file to change prices or add models; `PRICING_FILE` points elsewhere. A
model without a price yields `costUsd: null` — never a guess. Cache discounts, batch
discounts and long-context surcharges are not modelled.

Shipped prices: Anthropic's are from Anthropic's published model table. **OpenAI and Gemini
prices come from third-party trackers and are not verified** (the official pricing pages
were not reachable from the development environment) — check them before trusting the
estimates.

## Using it

```bash
pnpm translate movie.srt --to sr-Latn
```

```bash
pnpm translate movie.srt --to hr --from en --provider openai --model gpt-6.1-terra
```

```bash
pnpm translate movie.srt --to sr-Cyrl --mock
```

`--mock` uses the built-in mock translator (no API call, no cost). Run
`pnpm translate --help` for all options. Output is written next to the input as
`<name>.<language>.srt` in UTF-8.

## Testing

- **Ordinary tests (`pnpm test`)** never call a provider. The real SDKs are driven by a fake
  HTTP transport that answers in each provider's actual wire format (Anthropic SSE stream,
  OpenAI Responses JSON, Gemini `generateContent` JSON), so request building, response
  mapping and error classification are tested through the SDK code that runs in production.
- **Live test (`pnpm test:live`)** calls the real APIs with the keys from `.env`: one 12-line
  subtitle per configured provider, into Serbian Latin and Serbian Cyrillic, and prints
  tokens, cost and the first translated lines. Costs a few cents. Providers without a key
  are skipped. It is never part of `pnpm test` or CI.
