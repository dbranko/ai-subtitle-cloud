# Subtitle Sources and Cache

Code: `packages/subtitle-sources` (adapters, ranking, safe download, validation) and
`packages/jobs` (`library.ts`, `store.ts`, `worker.ts`: library, cache, media requests).

## Two ways a translation starts

| Way               | Who supplies the subtitle     | Entry point                                                |
| ----------------- | ----------------------------- | ---------------------------------------------------------- |
| **Upload**        | The owner uploads an SRT file | `POST /api/v1/jobs` / `createJob`                          |
| **Media request** | The job finds one by itself   | `POST /api/v1/jobs/from-media` / `requestMediaTranslation` |

Both return immediately and are processed by the same worker. A media request is what the
Stremio add-on will call (Phase 5): it is safe to call on every play.

## Sources

`SubtitleSource` is a small adapter interface: `search(query, languages)` and
`download(candidate)`. Ranking, validation, storage and caching are shared code outside the
adapters, so adding a source means writing only those two functions.

| Source        | Id              | Used when                                                                           |
| ------------- | --------------- | ----------------------------------------------------------------------------------- |
| Your uploads  | `library`       | Always. Uploads that carry an IMDb id (and season/episode) are found for that title |
| OpenSubtitles | `opensubtitles` | `OPENSUBTITLES_API_KEY` is set                                                      |

### OpenSubtitles

Official REST API only (`https://api.opensubtitles.com/api/v1`), with the owner's own API key
— no scraping.

- Search: `GET /subtitles` by `imdb_id` (movies), `parent_imdb_id` + `season_number` +
  `episode_number` (episodes), optional `moviehash`, `languages`; title search as a fallback.
- Download: `POST /download` with `file_id` and `sub_format: "srt"`; the returned link is
  fetched with the safe downloader.
- `Api-Key` and `User-Agent` headers on every API call. With `OPENSUBTITLES_USERNAME` /
  `OPENSUBTITLES_PASSWORD` the adapter logs in once (`POST /login`), sends the token, and
  logs in again if it expires.
- Errors are classified: `auth`, `quota` (HTTP 406), `rate_limit`, `unavailable`,
  `not_found`, `invalid_response`, `blocked`.

> **Not verified against the live service.** The official documentation and the API were not
> reachable from the development environment and no API key was available. The adapter
> follows the published API as known and is tested against simulated responses in that
> format. The first real run may need small adjustments.

## Matching

`rankCandidates` filters out what cannot fit and orders the rest, best first. Every
candidate carries its score and the reasons, which the search API returns for manual mode.

Never used: a subtitle in the target language; a subtitle in a language that was not asked
for; a subtitle for another season or episode.

| Signal                                                  | Points                   |
| ------------------------------------------------------- | ------------------------ |
| Uploaded by the owner for this title                    | +2000                    |
| Source confirms it matches the exact video file (hash)  | +1000                    |
| Preferred source language (first, second, …)            | +100, +80, …             |
| Same source type as the video (BluRay, WEB, HDTV, DVD…) | +40 / −25 when different |
| Same release group                                      | +25                      |
| Same resolution / codec                                 | +8 / +4                  |
| Similar release name                                    | up to +20                |
| Trusted uploader                                        | +15                      |
| Popularity (downloads), rating                          | up to +30, +10           |
| For the hearing impaired                                | −5                       |
| Different year (movies)                                 | −150                     |
| Machine or AI translated                                | −200                     |

Query data used: IMDb id, title, year, season, episode, video hash, video size (passed
through for future use), file name (release information). Ranking is deterministic.

## Source validation

Every downloaded file passes `validateSourceBytes` before it is stored or translated:

- not empty, not larger than `SOURCE_MAX_BYTES`;
- not an archive or binary file, not HTML, JSON or WebVTT;
- decodes (UTF-8, UTF-16, or the language's usual legacy code page) and parses as SRT;
- structurally valid (no negative durations, no duplicate indexes);
- at least 3 cues.

If the best candidate fails, the next is tried (up to 3). Invalid files are never stored.
For Serbian, the script is read from the text, so the source becomes `sr-Latn` or `sr-Cyrl`.

### Safe downloads (SSRF protection)

Download links come from a third party, so `safeDownload` enforces: HTTPS only, default
port, no credentials in the URL, host on an allow-list (`opensubtitles.com`,
`opensubtitles.org` and subdomains), no bare IP addresses, the host must not resolve to a
private, loopback, link-local, carrier-NAT or multicast address (IPv4 and IPv6), redirects
followed manually with every hop checked again (max 3), and a hard size limit while reading.

## Source library

Table `source_subtitles`, files in `<cache dir>/sources/<content hash>.srt`.

- Content-addressed: the same subtitle is stored once, whatever its encoding, line endings
  or origin. Details that were unknown are filled in later.
- Records provider, external id, language, file name, release, media ids and — when the
  source confirmed it — the video hash it matches.
- Uploads are the owner's library: they are found by IMDb id for later media requests and
  are never removed by cache cleanup.

## Translation cache

Table `translations`, one row per **translation key**; files in the subtitles directory.

The key is a hash of: source content hash, target language, target script, profile, custom
instructions, prompt version, engine version. Changing the prompt or the engine therefore
invalidates old entries naturally.

Stored with each entry: source subtitle (original), translated file, provider/model pairs,
creation date, validation result, processing statistics, sizes, last use.

How it is used:

1. **Upload:** an identical finished translation is returned instead of a new job
   (`reason: "completed"`).
2. **Media request:** `media_links` maps the media key (title/episode + video hash + target
   - profile) to a translation key. A repeated request is answered from the cache without
     searching or translating (`status: "cached"`).
3. **Inside a job:** once a media job knows its source, it looks up the content-based key.
   If the translation exists — from an upload, or from another video file that led to the
   same subtitle — the job completes with `cacheHit: true` and makes no AI request.
4. An entry whose file is gone is not a hit; it is removed and the request is processed
   normally.
5. `force: true` translates again and replaces the entry (the old file is deleted).

## Duplicate prevention

- **Uploads:** one active job per translation key (Phase 3).
- **Media requests, before the source is known:** the job holds a provisional key
  `media:<mediaKey>`; simultaneous identical requests create one job. Later requests find
  the job by `mediaKey` whatever stage it is in.
- **After the source is known:** the job switches to the content-based key. If another
  active job already holds it (the same subtitle is being translated right now), the job
  does not fail and does not translate twice: it returns to the queue, waits, and picks the
  result up from the cache when the other job finishes. Its downloaded source is remembered,
  so waiting costs no further searches or downloads.
- **Nothing found:** the job fails with `source_not_found`. The same request is not searched
  again for `SOURCE_RETRY_MINUTES` (default 30) — it returns `status: "failed"` with the
  earlier job — so repeated plays do not flood the source or the notifications.

## Job pipeline for a media request

`queued → locating_source` (search all sources, rank) `→ downloading_source` (download,
validate, store; adopt the content key; cache lookup) `→ parsing → … → completed`.

Failure codes: `source_not_found`, `source_invalid`, `source_quota`, `source_auth`,
`source_rate_limit`, `source_unavailable`, `source_blocked`.

## Cache cleanup

`CACHE_MAX_AGE_DAYS` (remove translations not used for that long) and `CACHE_MAX_SIZE_MB`
(remove least recently used until the cache fits). Both default to 0 = no limit. The worker
runs cleanup hourly when a limit is set; `POST /api/v1/cache/cleanup` runs it on demand.

- "Used" means served: a download or a cache hit updates `lastUsedAt`.
- **Never removed:** the source of an active job, any translation of that source, the
  translation an active job is about to reuse, and uploaded subtitles.
- A removed translation's job stays in the history without a download; the same request is
  simply translated again.
- Downloaded sources that no translation and no active job refers to are removed too.

## Settings

| Variable                               | Default                  | Meaning                                    |
| -------------------------------------- | ------------------------ | ------------------------------------------ |
| `OPENSUBTITLES_API_KEY`                | —                        | Enables OpenSubtitles                      |
| `OPENSUBTITLES_USERNAME` / `_PASSWORD` | —                        | Optional account (higher download quota)   |
| `OPENSUBTITLES_USER_AGENT`             | `AISubtitleCloud v0.1.0` | Required by the API                        |
| `SOURCE_LANGUAGES`                     | `en`                     | Source languages, most preferred first     |
| `SOURCE_MAX_BYTES`                     | `2097152`                | Largest downloaded subtitle                |
| `SOURCE_RETRY_MINUTES`                 | `30`                     | Wait before searching a failed title again |
| `CACHE_MAX_AGE_DAYS`                   | `0`                      | Age limit (0 = keep forever)               |
| `CACHE_MAX_SIZE_MB`                    | `0`                      | Size limit (0 = unlimited)                 |
| `CACHE_DIR`, `SUBTITLES_DIR`           | under `DATA_DIR`         | Where sources and translations are stored  |
