import { describe, expect, it } from 'vitest';
import {
  decodeSubtitleBytes,
  formatTimestamp,
  parseSrt,
  parseTimestamp,
  serializeSrt,
  SrtParseError,
  validateSrt,
  type SubtitleEntry,
} from './index.js';
import { fixtureBytes, fixtureText } from './test-fixtures.js';

describe('timestamps', () => {
  it('formats milliseconds as HH:MM:SS,mmm', () => {
    expect(formatTimestamp(0)).toBe('00:00:00,000');
    expect(formatTimestamp(3_723_004)).toBe('01:02:03,004');
    expect(formatTimestamp(100 * 3_600_000 + 59_999)).toBe('100:00:59,999');
  });

  it('parses standard and tolerated variants', () => {
    expect(parseTimestamp('01:02:03,004')).toBe(3_723_004);
    expect(parseTimestamp('01:02:03.004')).toBe(3_723_004);
    expect(parseTimestamp('1:02:03,004')).toBe(3_723_004);
    expect(parseTimestamp('02:03,004')).toBe(123_004);
    expect(parseTimestamp('00:00:01,5')).toBe(1500);
  });

  it('round-trips every value exactly', () => {
    for (const ms of [0, 1, 999, 1000, 59_999, 60_000, 3_599_999, 3_600_000, 86_399_999]) {
      expect(parseTimestamp(formatTimestamp(ms))).toBe(ms);
    }
  });

  it('rejects invalid values', () => {
    expect(() => parseTimestamp('00:61:00,000')).toThrow(SrtParseError);
    expect(() => parseTimestamp('00:00:75,000')).toThrow(SrtParseError);
    expect(() => parseTimestamp('garbage')).toThrow(SrtParseError);
    expect(() => formatTimestamp(-1)).toThrow(RangeError);
    expect(() => formatTimestamp(1.5)).toThrow(RangeError);
  });
});

describe('parseSrt', () => {
  it('parses a clean file without warnings', () => {
    const { entries, warnings, format } = parseSrt(fixtureText('basic-movie.srt'));
    expect(warnings).toEqual([]);
    expect(format).toEqual({ bom: false, newline: '\n' });
    expect(entries).toHaveLength(12);
    expect(entries[0]).toEqual({
      index: 1,
      startMs: 12_480,
      endMs: 14_920,
      text: 'Are you sure this is the place?',
    });
    expect(entries[2]?.text).toBe("I don't trust that map.\nIt got us lost twice already.");
    expect(entries.map((e) => e.index)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('keeps markup, speaker labels, sound descriptions and position settings verbatim', () => {
    const { entries, warnings } = parseSrt(fixtureText('formatting.srt'));
    expect(warnings).toEqual([]);
    const text = (index: number) => entries.find((e) => e.index === index)?.text;
    expect(text(1)).toBe('<i>Previously on Harbor Lights...</i>');
    expect(text(2)).toBe('{\\an8}<b>LISBON, 1987</b>');
    expect(text(3)).toBe('[door slams]');
    expect(text(4)).toBe('MARTHA: Where have you been?\nWe were worried sick.');
    expect(text(5)).toBe("- I told you I'd be late.\n- You said an hour, not six!");
    expect(text(6)).toBe('<font color="#ffff00">I can explain.</font>\n<i>If you let me.</i>');
    expect(text(9)).toBe('♪♪');
    expect(text(11)).toBe('...');
    expect(entries.find((e) => e.index === 7)?.settings).toBe('X1:040 X2:600 Y1:020 Y2:050');
    expect(entries.find((e) => e.index === 6)?.settings).toBeUndefined();
  });

  it('recovers from real-world irregularities and reports each one', () => {
    const { entries, warnings, format } = parseSrt(fixtureText('messy.srt'));
    expect(format).toEqual({ bom: true, newline: '\r\n' });
    expect(entries.map((e) => e.index)).toEqual([1, 2, 3, 4, 6, 7]);
    expect(entries.map((e) => e.text)).toEqual([
      'First line.',
      'Dot separators here.',
      'No blank line above me.',
      'I have no index.',
      'Line one\nLine three after a blank',
      '  Indented text stays indented.',
    ]);
    expect(entries[1]).toMatchObject({ startMs: 4000, endMs: 6500 });
    expect(entries[2]).toMatchObject({ startMs: 7000, endMs: 9000 });
    expect(warnings.map((w) => w.code).sort()).toEqual([
      'blank_line_in_text',
      'leading_content',
      'missing_blank_line',
      'missing_index',
    ]);
    expect(warnings.find((w) => w.code === 'missing_index')?.position).toBe(4);
  });

  it('does not mistake a numeric dialogue line for an index', () => {
    const { entries } = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nHow many?\n42\nReally?\n');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('How many?\n42\nReally?');
  });

  it('handles a file without a trailing newline and with CR-only line endings', () => {
    const { entries } = parseSrt(
      '1\r00:00:01,000 --> 00:00:02,000\rHello\r\r2\r00:00:03,000 --> 00:00:04,000\rBye',
    );
    expect(entries.map((e) => e.text)).toEqual(['Hello', 'Bye']);
  });

  it('keeps an entry whose text is empty', () => {
    const { entries } = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\n\n2\n00:00:03,000 --> 00:00:04,000\nHi\n',
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]?.text).toBe('');
  });

  it('throws on input that is not SRT', () => {
    expect(() => parseSrt('')).toThrow(SrtParseError);
    expect(() => parseSrt('<html><body>Status: translating…</body></html>')).toThrow(SrtParseError);
    expect(() => parseSrt('1\n00:99:00,000 --> 00:00:02,000\nBad minutes\n')).toThrow(
      SrtParseError,
    );
  });
});

describe('serializeSrt', () => {
  it('reproduces a clean file byte for byte', () => {
    for (const name of [
      'basic-movie.srt',
      'formatting.srt',
      'long-episode.srt',
      'cyrillic-source.srt',
    ]) {
      const source = fixtureText(name);
      const { entries, format } = parseSrt(source);
      expect(serializeSrt(entries, format), name).toBe(source);
    }
  });

  it('restores BOM and CRLF and never renumbers indexes', () => {
    const { entries, format } = parseSrt(fixtureText('messy.srt'));
    const out = serializeSrt(entries, format);
    expect(out.startsWith('﻿1\r\n00:00:01,000 --> 00:00:03,000\r\nFirst line.\r\n\r\n2\r\n')).toBe(
      true,
    );
    expect(out).not.toMatch(/[^\r]\n/);
    const again = parseSrt(out);
    expect(again.warnings).toEqual([]);
    expect(again.entries).toEqual(entries);
  });

  it('is stable: parse → serialize → parse yields identical entries', () => {
    for (const name of ['basic-movie.srt', 'formatting.srt', 'messy.srt', 'long-episode.srt']) {
      const first = parseSrt(fixtureText(name));
      const second = parseSrt(serializeSrt(first.entries, first.format));
      expect(second.entries, name).toEqual(first.entries);
    }
  });

  it('defaults to UTF-8 without BOM and LF, and handles an empty list', () => {
    const entry: SubtitleEntry = { index: 5, startMs: 1000, endMs: 2000, text: 'Hi\nthere' };
    expect(serializeSrt([entry])).toBe('5\n00:00:01,000 --> 00:00:02,000\nHi\nthere\n');
    expect(serializeSrt([])).toBe('');
  });

  it('never emits a blank line inside a cue', () => {
    const entry: SubtitleEntry = { index: 1, startMs: 0, endMs: 1000, text: 'a\n\nb  \n' };
    expect(serializeSrt([entry])).toBe('1\n00:00:00,000 --> 00:00:01,000\na\nb\n');
  });
});

describe('validateSrt', () => {
  const e = (index: number, startMs: number, endMs: number, text = 'x'): SubtitleEntry => ({
    index,
    startMs,
    endMs,
    text,
  });
  const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

  it('accepts all clean fixtures', () => {
    for (const name of ['basic-movie.srt', 'formatting.srt', 'long-episode.srt']) {
      const result = validateSrt(parseSrt(fixtureText(name)).entries);
      expect(result, name).toEqual({ valid: true, errors: [], warnings: [] });
    }
  });

  it('reports structural errors', () => {
    expect(codes(validateSrt([]).errors)).toEqual(['no_entries']);
    expect(codes(validateSrt([e(1, 2000, 1000)]).errors)).toEqual(['negative_duration']);
    expect(codes(validateSrt([e(1, 0, 1000), e(1, 2000, 3000)]).errors)).toEqual([
      'duplicate_index',
    ]);
    expect(codes(validateSrt([e(1, 0, 1000, 'a\n\nb')]).errors)).toEqual(['blank_line_in_text']);
    expect(codes(validateSrt([e(1, Number.NaN, 1000)]).errors)).toEqual(['invalid_time']);
    expect(validateSrt([e(1, 2000, 1000)]).valid).toBe(false);
  });

  it('reports harmless irregularities as warnings only', () => {
    const result = validateSrt([
      e(1, 0, 1000),
      e(3, 500, 1500),
      e(4, 100, 100),
      e(5, 5000, 6000, '  '),
    ]);
    expect(result.valid).toBe(true);
    expect(codes(result.warnings)).toEqual([
      'non_sequential_index',
      'overlap',
      'zero_duration',
      'out_of_order',
      'empty_text',
    ]);
    expect(result.warnings[0]?.position).toBe(2);
  });
});

describe('decodeSubtitleBytes', () => {
  it('decodes UTF-8 with and without BOM', () => {
    expect(decodeSubtitleBytes(fixtureBytes('basic-movie.srt')).encoding).toBe('utf-8');
    const messy = decodeSubtitleBytes(fixtureBytes('messy.srt'));
    expect(messy.encoding).toBe('utf-8');
    expect(parseSrt(messy.text).format.bom).toBe(true);
  });

  it('falls back to a legacy code page when the bytes are not UTF-8', () => {
    const decoded = decodeSubtitleBytes(fixtureBytes('legacy-cp1250.srt'), 'windows-1250');
    expect(decoded.encoding).toBe('windows-1250');
    const { entries } = parseSrt(decoded.text);
    expect(entries.map((x) => x.text)).toEqual([
      'Što se događa, Željko?',
      'Čekaj, ćud je ženska smiješna.',
    ]);
  });

  it('decodes UTF-16 with a byte-order mark', () => {
    const text = '1\n00:00:01,000 --> 00:00:02,000\nЗдраво\n';
    const le = new Uint8Array([0xff, 0xfe, ...Buffer.from(text, 'utf16le')]);
    const decoded = decodeSubtitleBytes(le);
    expect(decoded.encoding).toBe('utf-16le');
    expect(parseSrt(decoded.text).entries[0]?.text).toBe('Здраво');
  });
});
