# Stremio Add-on

Code: `apps/addon` (`stremio.ts`: manifest, id parsing, subtitles handler; `app.ts`: server).
Built on the official **Stremio Add-on SDK** (`stremio-addon-sdk`): the manifest is checked
by the SDK's linter, and `/manifest.json` and `/subtitles/...` are served by the SDK's router.

## What the protocol allows — and what it does not

Taken from the SDK's own documentation and source (`docs/api/requests/defineSubtitlesHandler.md`,
`docs/api/responses/subtitles.md`, `docs/protocol.md`, `src/getRouter.js`):

- A subtitles request carries `type`, `id` and optional `extra` (`videoHash`, `videoSize`,
  `filename`). The answer is `{ subtitles: [{ id, url, lang }] }` plus cache hints
  (`cacheMaxAge`, `staleRevalidate`, `staleError`).
- `lang` is an ISO 639-2 code; any other text is shown as it is.
- An add-on must be reachable on `127.0.0.1` or over HTTPS.
- **There is no way to show progress in the player, to push a notification, or to tell
  Stremio that a subtitle has become available.** None of the documented resources or
  response fields provides it, so this add-on does not pretend otherwise.

Consequences for this add-on:

1. A request is answered from the database in milliseconds. Translation never runs in it.
2. Only **finished** translations are listed. While a translation is running, that language
   is simply absent — no placeholder subtitle, no status text formatted as a subtitle.
3. Unfinished answers are sent with `Cache-Control: max-age=0`, so that Stremio's next
   request is not served a stale empty list.
4. Progress is shown in the dashboard (the companion progress page), which the add-on links
   to from its landing page and from Stremio's **Configure** button.

## How it behaves

When Stremio asks for subtitles of a title, for each configured target language:

| Situation                             | Answer for that language | Side effect                     |
| ------------------------------------- | ------------------------ | ------------------------------- |
| A finished translation exists (cache) | Subtitle entry           | none                            |
| A job is queued or running            | nothing                  | none (the job is reused)        |
| Nothing exists, automatic mode on     | nothing                  | a background job is created     |
| Nothing exists, automatic mode off    | nothing                  | none                            |
| A recent search found no source       | nothing                  | none for `SOURCE_RETRY_MINUTES` |
| Daily limit of automatic jobs reached | nothing                  | none (logged)                   |
| No AI provider configured             | nothing                  | none (logged)                   |

The job finds a source subtitle (your uploads first, then OpenSubtitles), prefers an exact
video-hash match, translates in the background, and stores the result. See
[SOURCES_AND_CACHE.md](SOURCES_AND_CACHE.md) and [PROGRESS_SYSTEM.md](PROGRESS_SYSTEM.md).

**Getting the subtitle into the player.** The add-on can only answer when Stremio asks. From
the protocol it follows that the finished subtitle is listed on the next subtitles request
for that video. When exactly the Stremio client sends that request (for example on
reopening the video) is client behaviour that is **not yet verified in Stremio Desktop** —
see the checklist below.

### Subtitle entries

- `id`: `asc-<translation id>` — stable for a translation.
- `url`: `<ADDON_PUBLIC_URL>[/<token>]/files/<job id>.<language>.srt` — a real SRT file,
  UTF-8, `Content-Type: application/x-subrip; charset=utf-8`, `Access-Control-Allow-Origin: *`.
- `lang`: ISO 639-2 (`srp`, `hrv`, `eng`, …).

Both Serbian scripts map to `srp`. If you offer both, tell them apart with a label:
`STREMIO_LANGUAGE_LABELS=sr-Cyrl=Српски (ћирилица)` (a non-ISO value is shown literally,
but Stremio's preferred-language selection will not match it). For languages whose two
ISO 639-2 codes differ (German, French, Dutch, Greek, Czech, Slovak, Romanian, Macedonian,
Chinese) the bibliographic code is sent; which variant Stremio expects is unverified —
override it the same way if a language shows up as raw text.

### Video ids

- Movie: `tt0111161`
- Series episode: `tt0903747:2:5` (series IMDb id, season, episode)

Other ids (non-IMDb catalogs) are answered with an empty list. Stremio does not send the
title; the job takes it from the source subtitle's metadata once one is found.

## Modes

**On demand** (`STREMIO_AUTO_TRANSLATE=false`, default): opening a video starts nothing.
For every configured language that has no translation yet, Stremio's subtitle menu shows an
entry labelled `<language> · AI translate`. Only when you pick that entry does Stremio load
its URL (`/translate/...`), and that request starts the translation. What the player then
shows is a short status message (in Serbian for Serbian/Croatian targets), repeated for ten
seconds every minute: "AI prevod je pokrenut…". It is plainly a status, never presented as
a translation. While the job runs the entry reads `<language> · AI 42%` and picking it again
shows the current progress; it never starts a second job. When the translation is finished,
reopen the video: the entry is replaced by the real subtitle (with its language code, e.g.
`srp`). An old entry still loaded in the player then delivers the finished translation.

The entry's label is deliberately not a language code, so Stremio's automatic choice of a
subtitle in your preferred language never picks it — nothing is translated without your
choice. Stremio loads a subtitle URL only when it is selected (observed behaviour of the
Stremio player; HEAD requests to `/translate/...` are refused so a probe cannot start
anything).

**Automatic** (`STREMIO_AUTO_TRANSLATE=true`, opt-in): opening a title in Stremio starts a
translation for every configured language that has none; no translate entries are shown.

> Every translation costs AI credits. `STREMIO_DAILY_JOB_LIMIT` (default 20 per 24 hours)
> caps how many Stremio can start in either mode; use `MOCK_AI=true` to try the flow for
> free.

Translations can also be started from the dashboard ("Translate by IMDb ID", or an uploaded
SRT with the title's IMDb id); they appear in Stremio for that title.

## Installing

1. Start the application (`pnpm dev`, or Docker Compose).
2. Open the add-on's page, `http://127.0.0.1:7000`, or the **Stremio** card in the dashboard.
3. Click **Install in Stremio**, or paste the add-on address into Stremio's add-on search box:
   `http://127.0.0.1:7000/manifest.json`

Stremio on another device (TV, phone) cannot reach `127.0.0.1` of this computer. For that,
put the add-on behind HTTPS, set `ADDON_PUBLIC_URL` to that address and set `AUTH_TOKEN`;
the add-on is then served only under `/<token>/...` and the token is part of the address
you install. See [SECURITY.md](SECURITY.md).

## Routes

| Route                                    | Purpose                                                |
| ---------------------------------------- | ------------------------------------------------------ |
| `GET /manifest.json`                     | Manifest (SDK router, CORS enabled)                    |
| `GET /subtitles/:type/:id[/:extra].json` | Subtitles (SDK router)                                 |
| `GET /files/<name>.srt`                  | A finished translation; only files known to the cache  |
| `GET /translate/<lang>/<type>/<id>.srt`  | "AI translate" entry: starts the job, returns status   |
| `GET /`                                  | Landing page: install link, dashboard link             |
| `GET /configure`                         | Redirect to the dashboard (Stremio's Configure button) |
| `GET /health`, `/health/ready`           | Health checks (never require the token)                |

With `AUTH_TOKEN` set, all but the health routes exist only under `/<token>/`.

## Settings

| Variable                   | Default                  | Meaning                                         |
| -------------------------- | ------------------------ | ----------------------------------------------- |
| `STREMIO_TARGET_LANGUAGES` | `sr-Latn`                | Languages offered, in order                     |
| `STREMIO_AUTO_TRANSLATE`   | `false`                  | On demand (false) or automatic (true)           |
| `STREMIO_DAILY_JOB_LIMIT`  | `20`                     | Translations Stremio may start per 24 h (0 = ∞) |
| `STREMIO_PROFILE`          | `AI_TRANSLATION_PROFILE` | Translation profile for Stremio requests        |
| `STREMIO_LANGUAGE_LABELS`  | —                        | `id=value` overrides of the `lang` sent         |
| `ADDON_PUBLIC_URL`         | `http://127.0.0.1:7000`  | Address Stremio uses to reach the add-on        |
| `DASHBOARD_PUBLIC_URL`     | `http://127.0.0.1:7001`  | Dashboard address the add-on links to           |
| `SOURCE_LANGUAGES`         | `en`                     | Source subtitle languages to look for           |

Settings are read from the environment; one installation serves one owner, so nothing is
configured per Stremio user and the manifest declares no user settings.

## What has been tested

- Automated (`apps/addon`): manifest content and linting, movie and series ids, extra
  parameters, language codes, non-blocking answers, duplicate requests, finished
  translations on the next request, several languages, manual mode, daily limit, missing
  provider, file delivery and headers, path traversal attempts, missing files, token
  protection, and a client's view over real HTTP.
- End to end (`e2e/stremio.spec.ts`): add-on, API and worker as separate processes; the
  test plays the Stremio client over HTTP while the dashboard shows the jobs live; the
  add-on keeps serving cached subtitles when the API and worker are down.
- Docker Compose: the add-on container serves the manifest and answers subtitle requests.

## Field report: Stremio 6.0.7 on Windows (2026-11-15)

First test on a real installation, add-on running in Docker Desktop:

- `http://127.0.0.1:7000/manifest.json` opened correctly in a browser.
- Stremio 6.0.7 answered "failed to get addon manifest" for both `http://127.0.0.1:7000/…`
  and `http://localhost:7000/…`.
- The add-on's request log showed **no request at all** from Stremio (the add-on logs every
  request, including browser preflights). The request is therefore stopped inside Stremio
  before it is sent; nothing in the manifest is being rejected.

So with this Stremio version the `127.0.0.1` route described in the SDK documentation did
not work, and the add-on has to be given an HTTPS address (`ADDON_PUBLIC_URL`) together with
`AUTH_TOKEN`. Why Stremio 6 blocks the local address is not established.

Second test, same installation, add-on reached through an HTTPS tunnel with `AUTH_TOKEN`
(translations simulated with `MOCK_AI`):

- The add-on installed from `https://<tunnel>/<token>/manifest.json`, and the Configure
  button reached `/configure`.
- **First play:** Stremio sent one subtitles request with `filename`, `videoSize` and (for
  one of two films) `videoHash`. The add-on answered in under 150 ms and created the job;
  playback was not delayed.
- **Refresh behaviour — verified:** Stremio did not ask again while the video stayed open.
  When the video was opened again after the job had finished, Stremio sent a new subtitles
  request, received the finished subtitle, and downloaded the file from `/files/…`
  (HTTP 200). This matched for two different films.

So a translation that finishes while a video is playing becomes available **the next time
the video is opened**. Still to be confirmed with a real (non-simulated) translation: that
the text is displayed with the correct characters and under the right language name.

Third test, with a real AI provider instead of the simulation: the owner reported that the
translated subtitle was displayed correctly in Stremio ("works great"). No problem with
characters or timing was reported.

## Not yet verified: Stremio Desktop

Stremio itself could not be run in the development environment. The following must be
checked on a real installation; please note the result of each step.

1. **Install.** Paste `http://127.0.0.1:7000/manifest.json` into Stremio's add-on search.
   _Expected:_ "AI Subtitle Cloud" is offered with a Configure button and installs.
2. **First play.** With `MOCK_AI=true` (free), open a movie that has English subtitles on
   OpenSubtitles. _Expected:_ playback is not delayed; a job "requested by Stremio" appears
   in the dashboard and progresses; no AI Subtitle Cloud entry is in the subtitle menu yet.
3. **After completion.** Wait for the completion notification. _Check:_ does the subtitle
   appear in the subtitle menu of the **already open** player? If not, does it appear after
   closing and reopening the video? After restarting Stremio? (This is the refresh behaviour
   the protocol does not define.)
4. **Language name.** _Check:_ is the entry listed under the right language name (Serbian)?
5. **Display.** Select it. _Expected:_ text is readable, characters like č ć š ž đ are
   correct, timing matches.
6. **Series.** Repeat with an episode. _Expected:_ the job is titled with the series name
   and `SxxEyy`.
7. **Configure button.** In the add-on list, click Configure. _Expected:_ the dashboard opens.
8. **Stremio Web** (optional): the same from `https://web.stremio.com`.

If step 3 shows that the subtitle only appears after reopening the video, that is the
documented behaviour of this add-on and nothing needs to change. If it never appears, or
the language or encoding is wrong, report what you saw.
