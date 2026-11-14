import { describe, expect, it } from 'vitest';
import { parseSrt, type SubtitleEntry } from '@asc/subtitle-parser';
import {
  normalizeTranslatedText,
  resolveTargetLanguage,
  validateSegmentTranslation,
  validateTranslatedSubtitle,
  type TranslationItem,
} from './index.js';

const source: TranslationItem[] = [
  { id: 1, text: 'Are you sure this is the place?' },
  { id: 2, text: "<i>That's what the map says.</i>" },
  { id: 3, text: '[door slams]' },
  { id: 4, text: '♪♪' },
];
const good: TranslationItem[] = [
  { id: 1, text: 'Jesi li siguran da je ovo to mesto?' },
  { id: 2, text: '<i>Tako piše na mapi.</i>' },
  { id: 3, text: '[vrata se zalupe]' },
  { id: 4, text: '♪♪' },
];
const latin = resolveTargetLanguage('sr-Latn');
const check = (translated: TranslationItem[], target = latin, src = source) =>
  validateSegmentTranslation({ source: src, translated, targetLanguage: target }).map(
    (i) => i.code,
  );
const replace = (id: number, text: string) => good.map((g) => (g.id === id ? { id, text } : g));

describe('validateSegmentTranslation', () => {
  it('accepts a correct translation, including untouched symbol-only lines', () => {
    expect(check(good)).toEqual([]);
  });

  it('detects missing, unexpected and duplicate entries', () => {
    expect(check(good.slice(0, 3))).toEqual(['missing_entry']);
    expect(check([...good, { id: 9, text: 'višak' }])).toEqual(['unexpected_entry']);
    expect(check([...good, { id: 1, text: 'opet' }])).toEqual(['duplicate_entry']);
    expect(check([])).toEqual(['missing_entry', 'missing_entry', 'missing_entry', 'missing_entry']);
  });

  it('detects empty translations', () => {
    expect(check(replace(1, ''))).toEqual(['empty_translation']);
    expect(check(replace(1, '  \n '))).toEqual(['empty_translation']);
  });

  it('detects changed or dropped formatting tags', () => {
    expect(check(replace(2, 'Tako piše na mapi.'))).toEqual(['markup_changed']);
    expect(check(replace(2, '<b>Tako piše na mapi.</b>'))).toEqual(['markup_changed']);
    expect(check(replace(1, '<i>Jesi li siguran?</i>'))).toEqual(['markup_changed']);
  });

  it('detects AI commentary inside a translation', () => {
    expect(check(replace(1, 'Here is the translation: Jesi li siguran?'))).toEqual(['commentary']);
    expect(check(replace(1, 'Translation: Jesi li siguran?'))).toEqual(['commentary']);
    expect(check(replace(1, 'Jesi li siguran? (Note: informal register)'))).toEqual(['commentary']);
    expect(check(replace(1, 'Napomena: ovo je idiom. Jesi li siguran?'))).toEqual(['commentary']);
  });

  it('does not mistake a speaker label for commentary', () => {
    const src = [{ id: 1, text: 'MARTHA: Where have you been?' }];
    expect(check([{ id: 1, text: 'MARTA: Gde si bio?' }], latin, src)).toEqual([]);
    const note = [{ id: 1, text: 'Note: the meeting is at noon.' }];
    expect(check([{ id: 1, text: 'Napomena: sastanak je u podne.' }], latin, note)).toEqual([]);
  });

  it('detects runaway expansion', () => {
    expect(check(replace(3, '[vrata] ' + 'i još mnogo dodatnog teksta '.repeat(5)))).toEqual([
      'excessive_length',
    ]);
  });

  it('detects the wrong script for Cyrillic and Latin targets', () => {
    const cyrillic = resolveTargetLanguage('sr-Cyrl');
    expect(check(good, cyrillic)).toContain('wrong_script');
    const inCyrillic = [
      { id: 1, text: 'Јеси ли сигуран да је ово то место?' },
      { id: 2, text: '<i>Тако пише на мапи.</i>' },
      { id: 3, text: '[врата се залупе]' },
      { id: 4, text: '♪♪' },
    ];
    expect(check(inCyrillic, cyrillic)).toEqual([]);
    expect(check(inCyrillic, resolveTargetLanguage('hr'))).toContain('wrong_script');
  });

  it('tolerates a foreign name inside correctly scripted text', () => {
    const cyrillic = resolveTargetLanguage('sr-Cyrl');
    const src = [{ id: 1, text: 'Did you buy the new iPhone from Whitaker?' }];
    expect(
      check([{ id: 1, text: 'Јеси ли купио нови iPhone од Витакера?' }], cyrillic, src),
    ).toEqual([]);
  });

  it('detects output that was not translated at all', () => {
    const src = Array.from({ length: 6 }, (_, i) => ({
      id: i + 1,
      text: `This is sentence number ${i + 1}.`,
    }));
    expect(check(src, latin, src)).toEqual(['untranslated']);
    expect(
      validateSegmentTranslation({
        source: src,
        translated: src,
        targetLanguage: latin,
        sourceLanguage: latin,
      }),
    ).toEqual([]);
  });

  it('reports every problem with the id it concerns', () => {
    const issues = validateSegmentTranslation({
      source,
      translated: [good[0]!, { id: 2, text: 'Tako piše na mapi.' }, good[3]!],
      targetLanguage: latin,
    });
    expect(issues.map((i) => [i.code, i.id])).toEqual([
      ['markup_changed', 2],
      ['missing_entry', 3],
    ]);
  });
});

describe('normalizeTranslatedText', () => {
  it('fixes mechanical irregularities without touching wording', () => {
    expect(normalizeTranslatedText('Prvi red  \r\n\r\nDrugi red\n', 'a\nb')).toBe(
      'Prvi red\nDrugi red',
    );
    expect(normalizeTranslatedText('Prvi\\nDrugi', 'a\nb')).toBe('Prvi\nDrugi');
    expect(normalizeTranslatedText('  Uvučeno', 'x')).toBe('  Uvučeno');
    expect(normalizeTranslatedText('C:\\new', 'C:\\new')).toBe('C:\\new');
  });
});

describe('validateTranslatedSubtitle', () => {
  const src = parseSrt(
    '1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000 X1:1 X2:2\nBye\n',
  );
  const translated = (): SubtitleEntry[] =>
    src.entries.map((e, i) => ({ ...e, text: ['Zdravo', 'Ćao'][i] ?? '' }));
  const codes = (entries: SubtitleEntry[]) =>
    validateTranslatedSubtitle(src.entries, entries, src.format).map((i) => i.code);

  it('accepts a structurally identical translation', () => {
    expect(codes(translated())).toEqual([]);
  });

  it('detects a changed number of entries', () => {
    expect(codes(translated().slice(0, 1))).toEqual(['entry_count_mismatch']);
  });

  it('detects changed timing, index and settings', () => {
    const t = translated();
    t[0] = { ...t[0]!, startMs: 1001 };
    expect(codes(t)).toEqual(['timestamp_changed']);
    const u = translated();
    u[1] = { ...u[1]!, index: 3 };
    expect(codes(u)).toContain('index_changed');
    const v = translated();
    delete v[1]!.settings;
    expect(codes(v)).toEqual(['settings_changed']);
  });

  it('detects empty text and text that would corrupt the SRT structure', () => {
    const t = translated();
    t[0] = { ...t[0]!, text: '' };
    expect(codes(t)).toEqual(['empty_translation']);
    const u = translated();
    u[0] = { ...u[0]!, text: 'Zdravo\n00:00:09,000 --> 00:00:10,000\nubačeno' };
    expect(codes(u)).toEqual(['invalid_srt_output']);
  });
});
