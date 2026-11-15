import { describe, expect, it } from 'vitest';
import { parseSrt, serializeSrt, validateSrt } from '@asc/subtitle-parser';
import {
  assembleTranslation,
  containsCyrillic,
  createLlmTranslator,
  createMockTranslator,
  ENGINE_VERSION,
  extractTags,
  measureScript,
  MOCK_MODEL,
  MOCK_PROVIDER,
  prepareTranslation,
  PROMPT_VERSION,
  SegmentFailedError,
  SourceSubtitleError,
  stripTags,
  targetLanguages,
  translateSegment,
  translateSubtitle,
  TranslationCancelledError,
  TranslationRequestError,
  TranslationValidationError,
  UnsupportedLanguageError,
  type MockFault,
  type SegmentResult,
  type TranslationProgressEvent,
} from './index.js';
import { fixtureText } from './test-fixtures.js';

const FIXTURES = ['basic-movie.srt', 'formatting.srt', 'messy.srt', 'long-episode.srt'];
const TARGETS = ['sr-Latn', 'sr-Cyrl', 'hr'];

describe('translateSubtitle — structure preservation', () => {
  it.each(FIXTURES.flatMap((f) => TARGETS.map((t) => [f, t] as const)))(
    '%s → %s keeps every index, timestamp, setting and tag',
    async (fixture, target) => {
      const srt = fixtureText(fixture);
      const source = parseSrt(srt);
      const result = await translateSubtitle(
        { srt, targetLanguage: target },
        createMockTranslator(),
      );

      expect(result.entries).toHaveLength(source.entries.length);
      result.entries.forEach((entry, i) => {
        const original = source.entries[i]!;
        expect(entry.index).toBe(original.index);
        expect(entry.startMs).toBe(original.startMs);
        expect(entry.endMs).toBe(original.endMs);
        expect(entry.settings).toBe(original.settings);
        expect(extractTags(entry.text)).toEqual(extractTags(original.text));
        expect(entry.text.split('\n')).toHaveLength(original.text.split('\n').length);
        expect(entry.text.trim() === '').toBe(original.text.trim() === '');
      });

      // The output is valid SRT in the source file's format and re-parses to the same entries.
      const reparsed = parseSrt(result.srt);
      expect(reparsed.warnings).toEqual([]);
      expect(reparsed.format).toEqual(source.format);
      expect(reparsed.entries).toEqual(result.entries);
      expect(validateSrt(reparsed.entries).valid).toBe(true);
      expect(result.validation.valid).toBe(true);

      // Only the text lines differ from a canonical serialization of the source.
      const structure = (text: string) =>
        text.split(/\r?\n/).filter((line) => /^\d+$/.test(line) || line.includes('-->'));
      expect(structure(result.srt)).toEqual(structure(serializeSrt(source.entries, source.format)));
    },
  );

  it('actually changes the dialogue text', async () => {
    const srt = fixtureText('basic-movie.srt');
    const result = await translateSubtitle({ srt, targetLanguage: 'hr' }, createMockTranslator());
    expect(result.entries[0]?.text).toBe('Áré yóú súré thís ís thé plácé?');
    expect(result.entries[2]?.text).toBe("Í dón't trúst thát máp.\nÍt gót ús lóst twícé álréády.");
  });

  it('leaves symbol-only subtitles untouched and keeps position settings', async () => {
    const result = await translateSubtitle(
      { srt: fixtureText('formatting.srt'), targetLanguage: 'sr-Cyrl' },
      createMockTranslator(),
    );
    const byIndex = (i: number) => result.entries.find((e) => e.index === i);
    expect(byIndex(9)?.text).toBe('♪♪');
    expect(byIndex(11)?.text).toBe('...');
    expect(byIndex(7)?.settings).toBe('X1:040 X2:600 Y1:020 Y2:050');
    expect(result.srt).toContain('00:01:21,000 --> 00:01:24,000 X1:040 X2:600 Y1:020 Y2:050');
    expect(byIndex(2)?.text.startsWith('{\\an8}<b>')).toBe(true);
    expect(byIndex(6)?.text).toContain('<font color="#ffff00">');
  });

  it('reports tolerated source irregularities as warnings', async () => {
    const result = await translateSubtitle(
      { srt: fixtureText('messy.srt'), targetLanguage: 'hr' },
      createMockTranslator(),
    );
    expect(result.srt.startsWith('﻿1\r\n')).toBe(true);
    expect(result.validation.warnings.map((w) => w.code)).toEqual(
      expect.arrayContaining(['source_missing_index', 'source_missing_blank_line']),
    );
  });

  it.each(targetLanguages().map((l) => l.id))(
    'produces an accepted translation for target %s',
    async (id) => {
      const result = await translateSubtitle(
        { srt: fixtureText('basic-movie.srt'), sourceLanguage: 'en', targetLanguage: id },
        createMockTranslator(),
      );
      expect(result.metadata.targetLanguage).toBe(id);
      expect(result.entries).toHaveLength(12);
    },
  );
});

describe('translateSubtitle — Serbian scripts', () => {
  it('Serbian Cyrillic output is written in Cyrillic', async () => {
    const result = await translateSubtitle(
      { srt: fixtureText('basic-movie.srt'), targetLanguage: 'sr-Cyrl' },
      createMockTranslator(),
    );
    const text = result.entries.map((e) => stripTags(e.text)).join('\n');
    expect(measureScript(text, 'Cyrl').ratio).toBe(1);
    expect(result.metadata).toMatchObject({ targetLanguage: 'sr-Cyrl', targetScript: 'Cyrl' });
  });

  it('Serbian Latin output never contains Cyrillic, even when the model answers in Cyrillic', async () => {
    const translator = createMockTranslator({ fault: () => 'cyrillic_output' });
    const result = await translateSubtitle(
      { srt: fixtureText('formatting.srt'), targetLanguage: 'sr-Latn' },
      translator,
    );
    expect(containsCyrillic(result.srt)).toBe(false);
    expect(result.stats.transliteratedEntries).toBeGreaterThan(0);
    expect(result.stats.retries).toBe(0);
    expect(result.metadata).toMatchObject({ targetLanguage: 'sr-Latn', targetScript: 'Latn' });
  });

  it('transliterates Serbian Cyrillic exactly, digraphs included', async () => {
    // The identity "translation" returns the Cyrillic source; the engine must still deliver Latin.
    const translator = createMockTranslator({ translate: (text) => text });
    const result = await translateSubtitle(
      {
        srt: fixtureText('cyrillic-source.srt'),
        sourceLanguage: 'sr-Cyrl',
        targetLanguage: 'sr-Latn',
      },
      translator,
    );
    expect(result.entries.map((e) => e.text)).toEqual([
      'Dobro veče, gospodine Petroviću.',
      'Džak ljubičica njiše se\nna đačkoj klupi.',
      '<i>Ljiljana i Njegoš putuju u Džibuti.</i>',
    ]);
    expect(result.stats.transliteratedEntries).toBe(3);
  });

  it('rejects Latin output for a Serbian Cyrillic target instead of delivering the wrong script', async () => {
    const translator = createMockTranslator({ translate: (text) => text.toUpperCase() });
    const error = await translateSubtitle(
      { srt: fixtureText('basic-movie.srt'), targetLanguage: 'sr-Cyrl' },
      translator,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SegmentFailedError);
    expect((error as SegmentFailedError).issues.map((i) => i.code)).toContain('wrong_script');
    expect(translator.calls).toHaveLength(3);
  });

  it('rejects Cyrillic output for a Croatian target', async () => {
    const translator = createMockTranslator({ fault: () => 'cyrillic_output' });
    await expect(
      translateSubtitle({ srt: fixtureText('basic-movie.srt'), targetLanguage: 'hr' }, translator),
    ).rejects.toThrow(SegmentFailedError);
  });
});

describe('translateSubtitle — segments, context and progress', () => {
  const srt = fixtureText('long-episode.srt');

  it('translates a long file in several segments and reports real progress', async () => {
    const translator = createMockTranslator();
    const events: TranslationProgressEvent[] = [];
    const result = await translateSubtitle({ srt, targetLanguage: 'sr-Latn' }, translator, {
      onProgress: (e) => void events.push(e),
    });

    const plan = prepareTranslation({ srt, targetLanguage: 'sr-Latn' });
    expect(plan.segments.length).toBeGreaterThanOrEqual(3);
    expect(translator.calls).toHaveLength(plan.segments.length);
    expect(result.stats).toMatchObject({
      entries: 130,
      segments: plan.segments.length,
      attempts: plan.segments.length,
      retries: 0,
    });

    expect(events[0]).toEqual({
      type: 'planned',
      totalSegments: plan.segments.length,
      totalEntries: 130,
    });
    expect(events[events.length - 1]).toEqual({ type: 'validating' });
    const completed = events.filter((e) => e.type === 'segment_completed');
    expect(completed.map((e) => e.completedSegments)).toEqual(plan.segments.map((_, i) => i + 1));
    expect(completed.map((e) => e.completedEntries)).toEqual(plan.segments.map((s) => s.end));
    expect(completed[completed.length - 1]?.completedEntries).toBe(130);
    // A segment is reported complete only after it was requested.
    const order = events
      .filter((e) => e.type !== 'planned' && e.type !== 'validating')
      .map((e) => e.type);
    expect(order).toEqual(plan.segments.flatMap(() => ['segment_started', 'segment_completed']));
  });

  it('sends each entry for translation exactly once', async () => {
    const translator = createMockTranslator();
    await translateSubtitle({ srt, targetLanguage: 'hr' }, translator);
    const ids = translator.calls.flatMap((c) => c.items.map((i) => i.id));
    expect(ids).toEqual(Array.from({ length: 130 }, (_, i) => i + 1));
  });

  it('gives every segment overlapping context, with accepted translations for what came before', async () => {
    const translator = createMockTranslator();
    const result = await translateSubtitle({ srt, targetLanguage: 'hr' }, translator, {
      segmentation: { contextBefore: 5, contextAfter: 2 },
    });
    const [first, second] = translator.calls;
    expect(first?.contextBefore).toEqual([]);
    expect(first?.contextAfter.map((c) => c.id)).toEqual(
      second?.items.slice(0, 2).map((i) => i.id),
    );

    const firstIds = first?.items.map((i) => i.id) ?? [];
    expect(second?.contextBefore.map((c) => c.id)).toEqual(firstIds.slice(-5));
    for (const context of second?.contextBefore ?? []) {
      expect(context.translation).toBe(result.entries[context.id - 1]?.text);
    }
    expect(second).toMatchObject({ segmentIndex: 1, attempt: 1, previousIssues: [] });
    const last = translator.calls[translator.calls.length - 1];
    expect(last?.contextAfter).toEqual([]);
  });

  it('passes languages, profile, custom instructions and media context to the translator', async () => {
    const translator = createMockTranslator();
    await translateSubtitle(
      {
        srt: fixtureText('basic-movie.srt'),
        sourceLanguage: 'en',
        targetLanguage: 'hr',
        profile: 'custom',
        customInstructions: '  Keep it formal.  ',
        mediaContext: { type: 'movie', title: 'Lost Again', year: 2019 },
      },
      translator,
    );
    expect(translator.calls[0]).toMatchObject({
      profile: 'custom',
      customInstructions: 'Keep it formal.',
      mediaContext: { title: 'Lost Again', year: 2019 },
      segmentCount: 1,
    });
    expect(translator.calls[0]?.sourceLanguage?.id).toBe('en');
    expect(translator.calls[0]?.targetLanguage.id).toBe('hr');
  });

  it('records metadata and statistics', async () => {
    const result = await translateSubtitle(
      { srt: fixtureText('basic-movie.srt'), targetLanguage: 'hr', profile: 'concise' },
      createMockTranslator(),
    );
    expect(result.metadata).toEqual({
      engineVersion: ENGINE_VERSION,
      promptVersion: PROMPT_VERSION,
      sourceLanguage: 'auto',
      targetLanguage: 'hr',
      targetScript: 'Latn',
      profile: 'concise',
      models: [{ provider: MOCK_PROVIDER, model: MOCK_MODEL }],
    });
    expect(result.stats.usage.inputTokens).toBeGreaterThan(0);
    expect(result.stats.usage.outputTokens).toBeGreaterThan(0);
    expect(result.stats.sourceCharacters).toBeGreaterThan(0);
    expect(result.stats.translatedCharacters).toBe(result.stats.sourceCharacters);
  });
});

describe('translateSubtitle — invalid output and retries', () => {
  const srt = fixtureText('formatting.srt');
  const FAULTS: [MockFault, string][] = [
    ['missing_entry', 'missing_entry'],
    ['extra_entry', 'unexpected_entry'],
    ['duplicate_entry', 'duplicate_entry'],
    ['empty_translation', 'empty_translation'],
    ['drop_tags', 'markup_changed'],
    ['commentary', 'commentary'],
    ['untranslated', 'untranslated'],
  ];

  it.each(FAULTS)(
    'retries a segment whose output has "%s" and then succeeds',
    async (fault, code) => {
      const translator = createMockTranslator({
        fault: (req) => (req.attempt === 1 ? fault : undefined),
      });
      const events: TranslationProgressEvent[] = [];
      const result = await translateSubtitle({ srt, targetLanguage: 'hr' }, translator, {
        onProgress: (e) => void events.push(e),
      });

      expect(translator.calls).toHaveLength(2);
      expect(result.stats).toMatchObject({ attempts: 2, retries: 1 });
      const failures = events.filter((e) => e.type === 'segment_attempt_failed');
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ segmentIndex: 0, attempt: 1, willRetry: true });
      expect(failures[0]?.issues.map((i) => i.code)).toContain(code);
      // The retry tells the model what was wrong.
      expect(translator.calls[1]?.attempt).toBe(2);
      expect(translator.calls[1]?.previousIssues.length).toBeGreaterThan(0);
    },
  );

  // Formatting that keeps coming back wrong is handled separately (simplified, not failed).
  const FATAL_FAULTS = FAULTS.filter(([fault]) => fault !== 'drop_tags');

  it.each(FATAL_FAULTS)(
    'never returns a translation with "%s": it fails after the retry limit',
    async (fault, code) => {
      const translator = createMockTranslator({ fault: () => fault });
      const events: TranslationProgressEvent[] = [];
      const error = await translateSubtitle({ srt, targetLanguage: 'hr' }, translator, {
        maxAttemptsPerSegment: 2,
        onProgress: (e) => void events.push(e),
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(SegmentFailedError);
      const failed = error as SegmentFailedError;
      expect(failed).toMatchObject({ segmentIndex: 0, attempts: 2 });
      expect(failed.issues.map((i) => i.code)).toContain(code);
      expect(translator.calls).toHaveLength(2);
      expect(events.some((e) => e.type === 'segment_completed')).toBe(false);
      expect(
        events.filter((e) => e.type === 'segment_attempt_failed').map((e) => e.willRetry),
      ).toEqual([true, false]);
    },
  );

  it('puts back whole-line formatting the model dropped, without a retry', async () => {
    // Only entries whose tags wrap whole lines: the repair is unambiguous.
    const wrapped = [
      '1\n00:00:01,000 --> 00:00:02,000\n<i>Previously on Harbor Lights...</i>\n',
      '2\n00:00:03,000 --> 00:00:04,000\n{\\an8}<b>LISBON, 1987</b>\n',
      '3\n00:00:05,000 --> 00:00:06,000\n<font color="#ffff00">I can explain.</font>\n<i>If you let me.</i>\n',
      '4\n00:00:07,000 --> 00:00:08,000\n<i>- Is he gone?</i>\n<i>- For now.</i>\n',
    ].join('\n');
    const translator = createMockTranslator({ fault: () => 'drop_tags' });
    const result = await translateSubtitle({ srt: wrapped, targetLanguage: 'hr' }, translator);

    expect(translator.calls).toHaveLength(1);
    expect(result.stats.repairedMarkupEntries).toBe(4);
    const source = parseSrt(wrapped).entries;
    result.entries.forEach((entry, i) => {
      expect(extractTags(entry.text)).toEqual(extractTags(source[i]!.text));
    });
    expect(result.validation.warnings).toEqual([]);
  });

  it('keeps the translation without inline tags when the model keeps breaking them', async () => {
    const translator = createMockTranslator({ fault: () => 'drop_tags' });
    const result = await translateSubtitle({ srt, targetLanguage: 'hr' }, translator, {
      maxAttemptsPerSegment: 2,
    });

    // Retried once, then accepted instead of failing the whole job.
    expect(translator.calls).toHaveLength(2);
    const source = parseSrt(srt).entries;
    const byIndex = (n: number) => result.entries.find((e) => e.index === n)!;
    // Whole-line tags restored exactly.
    for (const n of [1, 2, 6, 12]) {
      expect(extractTags(byIndex(n).text)).toEqual(extractTags(source[n - 1]!.text));
    }
    // Inline tags (`respond to <i>Pier 14</i>.`, `<u>Never</u> call…`) could not be placed.
    expect(extractTags(byIndex(10).text)).toEqual([]);
    expect(extractTags(byIndex(14).text)).toEqual([]);
    expect(stripTags(byIndex(14).text)).not.toBe('');
    const simplified = result.validation.warnings.filter((w) => w.code === 'markup_simplified');
    expect(simplified.map((w) => w.id).sort()).toEqual([10, 14]);
  });

  it('accepts tags that differ only in case, quotes or spacing', async () => {
    const one = '1\n00:00:01,000 --> 00:00:02,000\n<font color="#ffff00">I can explain.</font>\n';
    const translator = createMockTranslator({
      translate: () => '<FONT color=#FFFF00 >Mogu objasniti.</FONT>',
    });
    const result = await translateSubtitle({ srt: one, targetLanguage: 'hr' }, translator);
    expect(translator.calls).toHaveLength(1);
    expect(result.entries[0]?.text).toBe('<FONT color=#FFFF00 >Mogu objasniti.</FONT>');
  });

  it('stops at the failing segment and does not translate later ones', async () => {
    const translator = createMockTranslator({
      fault: (req) => (req.segmentIndex === 1 ? 'missing_entry' : undefined),
    });
    await expect(
      translateSubtitle({ srt: fixtureText('long-episode.srt'), targetLanguage: 'hr' }, translator),
    ).rejects.toThrow(/Segment 2 could not be translated correctly after 3 attempt/);
    expect(translator.calls.map((c) => c.segmentIndex)).toEqual([0, 1, 1, 1]);
  });

  it('treats an unparseable model reply as a failed attempt and retries', async () => {
    let call = 0;
    const translator = createLlmTranslator({
      complete: () => {
        call++;
        if (call === 1) return Promise.resolve({ text: 'I am sorry, I cannot do that.' });
        return Promise.resolve({
          text:
            'Here it is:\n' +
            JSON.stringify({
              translations: [
                { id: 1, text: 'Dobro veče.' },
                { id: 2, text: 'Laku noć.' },
              ],
            }),
        });
      },
    });
    const events: TranslationProgressEvent[] = [];
    const result = await translateSubtitle(
      {
        srt: '1\n00:00:01,000 --> 00:00:02,000\nGood evening.\n\n2\n00:00:03,000 --> 00:00:04,000\nGood night.\n',
        targetLanguage: 'sr-Latn',
      },
      translator,
      { onProgress: (e) => void events.push(e) },
    );
    expect(call).toBe(2);
    expect(result.srt).toBe(
      '1\n00:00:01,000 --> 00:00:02,000\nDobro veče.\n\n2\n00:00:03,000 --> 00:00:04,000\nLaku noć.\n',
    );
    const failure = events.find((e) => e.type === 'segment_attempt_failed');
    expect(failure?.issues[0]?.code).toBe('invalid_response');
    expect(result.validation.warnings.map((w) => w.code)).toEqual(['extraneous_text']);
  });

  it('does not swallow provider errors', async () => {
    const translator = createMockTranslator({ fault: () => 'error' });
    await expect(translateSubtitle({ srt, targetLanguage: 'hr' }, translator)).rejects.toThrow(
      'Mock provider failure',
    );
    expect(translator.calls).toHaveLength(1);
  });

  it('normalises double-escaped line breaks and stray blank lines from the model', async () => {
    const translator = createMockTranslator({ translate: () => 'Prvi red\\nDrugi red\n\n' });
    const result = await translateSubtitle(
      { srt: '1\n00:00:01,000 --> 00:00:02,000\nFirst line\nSecond line\n', targetLanguage: 'hr' },
      translator,
    );
    expect(result.entries[0]?.text).toBe('Prvi red\nDrugi red');
  });
});

describe('translateSubtitle — cancellation and resume', () => {
  const srt = fixtureText('long-episode.srt');

  it('stops before the next segment when cancelled', async () => {
    const controller = new AbortController();
    const translator = createMockTranslator();
    const promise = translateSubtitle({ srt, targetLanguage: 'hr' }, translator, {
      signal: controller.signal,
      onProgress: (e) => {
        if (e.type === 'segment_completed' && e.segmentIndex === 0) controller.abort();
      },
    });
    await expect(promise).rejects.toThrow(TranslationCancelledError);
    expect(translator.calls).toHaveLength(1);
  });

  it('aborts an in-flight request when cancelled', async () => {
    const controller = new AbortController();
    const translator = createMockTranslator({ delayMs: 5000 });
    const promise = translateSubtitle({ srt, targetLanguage: 'hr' }, translator, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await expect(promise).rejects.toThrow(TranslationCancelledError);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does nothing when the signal is already aborted', async () => {
    const translator = createMockTranslator();
    await expect(
      translateSubtitle({ srt, targetLanguage: 'hr' }, translator, { signal: AbortSignal.abort() }),
    ).rejects.toThrow(TranslationCancelledError);
    expect(translator.calls).toHaveLength(0);
  });

  it('resumes from previously completed segments and produces the identical result', async () => {
    const full = await translateSubtitle(
      { srt, targetLanguage: 'sr-Latn' },
      createMockTranslator(),
    );

    // First run is interrupted after two segments; their results were persisted by the caller.
    const saved: SegmentResult[] = [];
    const controller = new AbortController();
    await translateSubtitle({ srt, targetLanguage: 'sr-Latn' }, createMockTranslator(), {
      signal: controller.signal,
      onProgress: (e) => {
        if (e.type !== 'segment_completed') return;
        saved.push(e.result);
        if (saved.length === 2) controller.abort();
      },
    }).catch(() => undefined);
    expect(saved).toHaveLength(2);

    // JSON round trip = what a database would hand back.
    const restored = JSON.parse(JSON.stringify(saved)) as SegmentResult[];
    const translator = createMockTranslator();
    const events: TranslationProgressEvent[] = [];
    const resumed = await translateSubtitle({ srt, targetLanguage: 'sr-Latn' }, translator, {
      completedSegments: restored,
      onProgress: (e) => void events.push(e),
    });

    expect(translator.calls.map((c) => c.segmentIndex)).toEqual(
      full.entries.length ? Array.from({ length: full.stats.segments - 2 }, (_, i) => i + 2) : [],
    );
    expect(resumed.srt).toBe(full.srt);
    // The first resumed segment still receives the earlier translations as context.
    expect(translator.calls[0]?.contextBefore.every((c) => c.translation !== undefined)).toBe(true);
    const completed = events.filter((e) => e.type === 'segment_completed');
    expect(completed[0]?.completedSegments).toBe(3);
  });

  it('ignores resume data that does not match the current plan', async () => {
    const bogus: SegmentResult = {
      segmentIndex: 0,
      translations: [{ id: 1, text: 'samo jedan' }],
      attempts: 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: 0,
      transliteratedEntries: 0,
      warnings: [],
    };
    const translator = createMockTranslator();
    const result = await translateSubtitle({ srt, targetLanguage: 'hr' }, translator, {
      completedSegments: [bogus],
    });
    expect(translator.calls[0]?.segmentIndex).toBe(0);
    expect(result.entries[0]?.text).not.toBe('samo jedan');
  });
});

describe('lower-level API', () => {
  const srt = fixtureText('long-episode.srt');

  it('prepareTranslation is deterministic', () => {
    const a = prepareTranslation({ srt, targetLanguage: 'hr' });
    const b = prepareTranslation({ srt, targetLanguage: 'hr' });
    expect(a.segments).toEqual(b.segments);
    expect(a.entries).toEqual(b.entries);
  });

  it('assembleTranslation refuses an incomplete set of segments', async () => {
    const plan = prepareTranslation({ srt, targetLanguage: 'hr' });
    const first = await translateSegment(plan, 0, new Map(), createMockTranslator());
    expect(() => assembleTranslation(plan, [first])).toThrow(TranslationValidationError);
    try {
      assembleTranslation(plan, [first]);
    } catch (e) {
      expect(
        (e as TranslationValidationError).issues.every((i) => i.code === 'missing_segment'),
      ).toBe(true);
    }
  });

  it('assembleTranslation refuses a segment result with missing entries', async () => {
    const plan = prepareTranslation({ srt: fixtureText('basic-movie.srt'), targetLanguage: 'hr' });
    const result = await translateSegment(plan, 0, new Map(), createMockTranslator());
    const truncated = { ...result, translations: result.translations.slice(0, -1) };
    expect(() => assembleTranslation(plan, [truncated])).toThrow(/Entry 12 has no translation/);
  });

  it('translateSegment rejects an unknown segment index', async () => {
    const plan = prepareTranslation({ srt, targetLanguage: 'hr' });
    await expect(translateSegment(plan, 99, new Map(), createMockTranslator())).rejects.toThrow(
      RangeError,
    );
  });
});

describe('request validation', () => {
  const srt = fixtureText('basic-movie.srt');
  const run = (input: Parameters<typeof translateSubtitle>[0]) =>
    translateSubtitle(input, createMockTranslator());

  it('rejects unavailable or ambiguous target languages', async () => {
    await expect(run({ srt, targetLanguage: 'bs' })).rejects.toThrow(UnsupportedLanguageError);
    await expect(run({ srt, targetLanguage: 'cnr' })).rejects.toThrow(UnsupportedLanguageError);
    await expect(run({ srt, targetLanguage: 'sr' })).rejects.toThrow(/explicit script/);
    await expect(run({ srt, targetLanguage: 'klingon' })).rejects.toThrow(UnsupportedLanguageError);
  });

  it('rejects input that is not a usable subtitle', async () => {
    await expect(run({ srt: 'not a subtitle', targetLanguage: 'hr' })).rejects.toThrow(
      SourceSubtitleError,
    );
    await expect(run({ srt: '', targetLanguage: 'hr' })).rejects.toThrow(SourceSubtitleError);
    await expect(
      run({ srt: '1\n00:00:05,000 --> 00:00:01,000\nBackwards\n', targetLanguage: 'hr' }),
    ).rejects.toThrow(/ends before it starts/);
  });

  it('rejects an unknown profile and a custom profile without instructions', async () => {
    await expect(run({ srt, targetLanguage: 'hr', profile: 'custom' })).rejects.toThrow(
      TranslationRequestError,
    );
    await expect(
      run({ srt, targetLanguage: 'hr', profile: 'custom', customInstructions: '   ' }),
    ).rejects.toThrow(/requires custom instructions/);
    await expect(
      run({ srt, targetLanguage: 'hr', profile: 'poetic' as unknown as 'natural' }),
    ).rejects.toThrow(/Unknown translation profile/);
  });
});
