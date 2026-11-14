# Product Specification

## What this is

A private AI subtitle translation system for **one owner**, integrated with Stremio.

It is **not** a SaaS product. There is no registration, no customers, no subscriptions, no
payments, no billing, no pricing plans, no multi-tenancy and no commercial admin panel.
Simplicity and maintainability win over generality.

## Goals

1. Automatically find a source subtitle for a movie or TV episode.
2. Translate it with AI, preserving timing and structure exactly.
3. Support automatic (from Stremio) and manual (from the dashboard) translation.
4. Support several AI providers: Anthropic Claude, OpenAI, Google Gemini, with fallback.
5. Run every translation asynchronously in a persistent background worker.
6. Show accurate, real-time progress based on real completed work.
7. Notify the owner when a translation completes or fails.
8. Cache completed translations; never translate the same subtitle twice.
9. Let the owner manage everything from a private web dashboard.
10. Make completed translations available to Stremio.

Stremio is the first and only integration for now. The translation engine and job system
are independent of Stremio so Kodi or other players can be added later; nothing for them is
built now.

## The most important requirement

**Asynchronous translation with trustworthy progress monitoring.** A long AI translation is
never performed inside a Stremio HTTP request. Jobs are persistent, survive browser closure
and application restarts, are never duplicated, and report progress that reflects actual
completed segments. This is designed, built and tested (Phase 3) before the Stremio add-on
(Phase 5). See [PROGRESS_SYSTEM.md](PROGRESS_SYSTEM.md).

## Functional requirements

### Translation engine

- Input: SRT file, source language (if known), target language, target script where
  applicable, translation profile, optional media context.
- Output: valid translated SRT, metadata, processing statistics, validation results.
- Preserves indexes, timestamps, order, line breaks, formatting tags, speaker identifiers,
  sound descriptions and special markup. Timestamps and structure are never sent for
  "translation".
- Splits the file into segments (initially 30–60 entries) with contextual overlap; segment
  size adapts to provider limits.
- Profiles: Natural, Literal, Cinematic, Concise, Custom.
- Validates entry count, timestamps, order, empty/missing translations, SRT format, AI
  commentary and duplicate/malformed entries. Invalid segments are retried within limits.
  An incomplete translation is never returned silently.

### Languages and scripts

- Consistent language identifiers throughout.
- **Serbian Latin and Serbian Cyrillic are separate selectable targets.** Serbian Latin must
  never come back as Cyrillic.
- Also: Croatian, English, German, French, Spanish, Italian, Russian and other languages the
  providers translate reliably.
- **Bosnian and Montenegrin are not offered as target languages.**

### AI providers

- One interface for all providers: translate segments, structured results, token usage,
  model information, cost estimate from configurable pricing, rate-limit and timeout
  handling, retries for transient errors, fallback provider.
- Dashboard settings: preferred provider/model, fallback provider/model, temperature (or
  equivalent), maximum segment size, quality profile.
- API keys are never hardcoded, never sent to the browser, never sent to Stremio, never logged.

### Subtitle sources

- Local SRT uploads.
- OpenSubtitles through its official API, when configured. No scraping.
- Matching considers IMDb ID, title, year, season, episode, video hash, video size, filename
  and release information. Sources sit behind a replaceable adapter interface.

### Cache

- Key: source subtitle hash + target language + target script + profile + prompt version +
  engine version.
- Stores original and translated subtitle, provider, model, date, validation result and
  statistics. Cleanup is configurable and never touches files of active jobs.

### Stremio add-on

- Official Stremio Add-on SDK: manifest, movie and series subtitle handlers, correct language
  codes, stable subtitle IDs and URLs, hash/size matching where available, cache headers, CORS.
- Automatic mode: detect media, find the best source (exact hash preferred), check cache,
  reuse an active job, create a job only when needed, return finished translations.
- Never blocks on translation, never returns something that is not a real subtitle, never
  claims in-player progress features the protocol does not have. Actual client behaviour is
  verified in Stremio Desktop.

### Dashboard

- Main view: active jobs with live progress, recent completions, failures, current provider,
  recent activity.
- Translate page: upload SRT, choose languages/script/provider/model/profile, start, cancel,
  download.
- Job details: title, stage, percentage, completed/total segments, current segment,
  duration, ETA, provider/model, retries, error details.
- Settings: provider credentials, models, target languages, default script, profiles,
  sources, cache directory, notification preferences, Stremio integration.
- History: title, date, languages, provider, model, status, download link.

### Notifications

- In-app and browser desktop notifications for completion and failure; optional sound
  (off by default). Browser notifications require explicit opt-in. Each event notifies once.
  Events are persisted so they are visible after the browser was closed.

## Non-functional requirements

- Runs on Windows and Linux; Docker Compose deployment supported.
- SQLite + local filesystem; no Redis unless it brings a measurable benefit.
- TypeScript strict mode everywhere; automated tests use mock providers and spend no AI credits.
- Private by default: localhost binding, authentication required beyond localhost.

## Out of scope

Public hosting, user accounts, payments, multi-tenant features, Kodi/other players (for now),
unauthorized subtitle scraping.
