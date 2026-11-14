# Translation Engine

Two packages, both independent of Stremio, HTTP and the database:

- `@asc/subtitle-parser` — reads and writes SRT.
- `@asc/translation-engine` — turns a source SRT into a validated translated SRT using any
  `SegmentTranslator` (a real AI provider from Phase 2, or the mock translator).

## Pipeline

```
SRT text ─▶ parse + validate source ─▶ plan segments ─▶ for each segment:
                                                          build request (items + context)
                                                          translator.translateSegment()
                                                          normalize ─▶ validate ─▶ accept | retry
                                       ─▶ assemble ─▶ final structural validation ─▶ SRT text
```

Only `{id, text}` pairs are sent for translation. Index numbers, timestamps and position
settings never leave the engine; they are re-attached from the source, so they cannot be
changed by a model.

## SRT parser (`@asc/subtitle-parser`)

| Function              | Purpose                                                               |
| --------------------- | --------------------------------------------------------------------- |
| `decodeSubtitleBytes` | Bytes → text: UTF-8/UTF-16 BOM, strict UTF-8, then a legacy code page |
| `parseSrt`            | Text → entries + file format (BOM, line ending) + warnings            |
| `serializeSrt`        | Entries → canonical SRT text in the requested format                  |
| `validateSrt`         | Structural errors and warnings for a list of entries                  |

An entry is `{ index, startMs, endMs, settings?, text }`. Times are integer milliseconds.

**Preserved verbatim:** index numbers (never renumbered), timing, order, position settings
after the timestamps, line breaks, formatting tags (`<i>`, `<font …>`, `{\an8}`), speaker
labels, sound descriptions, music symbols, leading indentation.

**Tolerated on input (reported as warnings):** BOM, CRLF/CR line endings, missing blank line
between cues, missing index (assigned sequentially), extra blank lines, blank line inside a
cue (removed — it cannot be represented in SRT), `.` instead of `,` in timestamps, missing
hour field, junk before the first cue.

**Rejected (`SrtParseError`):** input with no cue at all, timestamps with invalid minutes or
seconds.

`validateSrt` errors: `no_entries`, `invalid_index`, `duplicate_index`, `invalid_time`,
`negative_duration`, `blank_line_in_text`. Warnings: `non_sequential_index`, `zero_duration`,
`out_of_order`, `overlap`, `empty_text`.

Clean files round-trip byte for byte (`serializeSrt(parseSrt(x)) === x`), which is tested on
the fixtures.

## Languages and scripts

Identifiers are BCP 47 tags (`languages.ts`). A script subtag is used where the script is a
real choice for the viewer.

- `sr-Latn` (Serbian Latin) and `sr-Cyrl` (Serbian Cyrillic) are separate targets.
  Bare `sr` is rejected.
- Other targets include `hr`, `en`, `de`, `fr`, `es`, `it`, `ru` and about 25 more.
- `bs` (Bosnian) and `cnr` (Montenegrin) exist as **source** languages only;
  `resolveTargetLanguage` refuses them.
- Each language carries its script, an optional target note for the prompt (script and
  standard variety) and the legacy code page its non-UTF-8 files usually use.

**Script guarantees**

| Target            | Mechanism                                                                                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sr-Latn`         | Any Cyrillic in the answer is transliterated with the exact Serbian Cyrillic→Latin mapping (Љ→Lj/LJ, Њ→Nj/NJ, Џ→Dž/DŽ). Output cannot contain Serbian Cyrillic. |
| `sr-Cyrl`, others | Script validation: a segment whose letters are mostly in the wrong script is rejected and retried, then fails the job. The wrong script is never delivered.     |

## Profiles

`natural` (default), `literal`, `cinematic`, `concise`, `custom`. Each adds one style
instruction to the prompt. `custom` requires the owner's own instructions; other profiles
accept them as an addition.

## Segmentation

Defaults: 30–60 entries per segment (target 40), at most 6000 source characters, 6 entries
of preceding and 3 of following context.

- Cuts are placed at **scene changes** (a pause of at least 2.5 s) when one falls inside the
  allowed window; otherwise at the target size.
- A final fragment shorter than the minimum is avoided by rebalancing the last two segments.
- The character budget always wins, even below the minimum entry count; a single oversized
  entry still forms its own segment.
- `adaptSegmentation(options, { maxOutputTokens, maxInputTokens })` shrinks the budget for
  small models.
- The plan is deterministic, so an interrupted job resumes with the same segments.

Preceding context includes the **already accepted translations**, so names and terminology
stay consistent across segments.

## Translator interfaces

```ts
interface SegmentTranslator {
  translateSegment(request, options?): Promise<SegmentTranslationResponse>;
}
interface LlmClient {
  complete({ system, user, signal }): Promise<{ text; usage?; provider?; model? }>;
}
```

`createLlmTranslator(client)` = `buildSegmentPrompt` + `client.complete` +
`parseTranslationResponse`. A provider only implements `LlmClient`; prompt and parsing are
shared by all providers.

**Prompt (`PROMPT_VERSION = v1`).** The system prompt states the language pair, the target
note, eleven translation rules (meaning over words, names, consistent terminology, idioms and
humor, conversational language, no expansion, readability, exact tags, labels and symbols,
no merging or splitting), the profile and the output format. The user prompt carries media
context, preceding and following context marked "do not return", the reasons a previous
attempt was rejected (on retries) and the items as JSON.

**Response.** Expected: `{"translations":[{"id":1,"text":"…"}]}`. Also accepted: a markdown
code fence, a bare array, numeric ids as strings, prose around the JSON (discarded and
recorded as an `extraneous_text` warning). Anything else raises `TranslationResponseError`
and counts as a failed attempt.

## Validation

Per segment (any issue → the segment is retried):

| Code                | Meaning                                                         |
| ------------------- | --------------------------------------------------------------- |
| `invalid_response`  | Reply was not parseable as translations                         |
| `missing_entry`     | A requested id was not returned                                 |
| `unexpected_entry`  | An id that was not requested was returned                       |
| `duplicate_entry`   | An id was returned more than once                               |
| `empty_translation` | Empty text for a non-empty source                               |
| `markup_changed`    | Formatting tags differ from the source                          |
| `commentary`        | "Here is the translation:", "(Note: …)" and similar inside text |
| `excessive_length`  | Far longer than the source                                      |
| `wrong_script`      | Not written in the target script                                |
| `untranslated`      | Most entries returned unchanged                                 |

Mechanical irregularities (CRLF, trailing spaces, blank lines, double-escaped `\n`) are
normalized before validation; wording is never altered.

Final, whole file (any issue → `TranslationValidationError`): same number of entries, same
indexes, same timing, same position settings, no empty text, valid SRT, and the serialized
output must re-parse to identical entries.

## Failure behaviour

`translateSubtitle` returns only a complete, validated translation. Otherwise it throws:

| Error                        | When                                                          |
| ---------------------------- | ------------------------------------------------------------- |
| `SourceSubtitleError`        | Source is not usable SRT                                      |
| `UnsupportedLanguageError`   | Unknown, source-only or ambiguous language                    |
| `TranslationRequestError`    | Unknown profile, custom profile without instructions          |
| `SegmentFailedError`         | A segment was still invalid after `maxAttemptsPerSegment` (3) |
| `TranslationValidationError` | Final structural validation failed                            |
| `TranslationCancelledError`  | The `AbortSignal` was aborted                                 |

Errors thrown by the translator itself (network, authentication, rate limits) are passed
through unchanged; retrying and fallback for those belong to the provider layer (Phase 2).

## Hooks for the job engine (Phase 3)

- `onProgress` events: `planned`, `segment_started`, `segment_attempt_failed`,
  `segment_completed` (only after validation passed; includes the `SegmentResult`),
  `validating`. Callbacks are awaited, so a listener can persist before work continues.
- `completedSegments`: results saved earlier are reused and not translated again. Resume
  data that does not match the current plan is ignored.
- `signal`: checked before every attempt and passed to the translator.
- Lower-level functions `prepareTranslation`, `translateSegment`, `assembleTranslation` are
  exported for callers that need to drive segments themselves.

## Result

```ts
{
  srt, entries,
  metadata: { engineVersion, promptVersion, sourceLanguage, targetLanguage, targetScript, profile, models },
  stats: { entries, segments, attempts, retries, transliteratedEntries, usage, costUsd, sourceCharacters, translatedCharacters, translationMs },
  validation: { valid: true, warnings }
}
```

`ENGINE_VERSION` and `PROMPT_VERSION` become part of the cache key in Phase 4.

## Mock translator

`createMockTranslator()` rewrites letters into the target script and leaves markup,
punctuation, digits and line breaks alone. It can inject faults (`missing_entry`,
`extra_entry`, `duplicate_entry`, `empty_translation`, `drop_tags`, `commentary`,
`cyrillic_output`, `untranslated`, `error`) and latency, and records every request. All
ordinary tests use it; no test calls a real AI API.

## Fixtures

See [`fixtures/subtitles/README.md`](../fixtures/subtitles/README.md).
