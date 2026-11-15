/**
 * Phase 7 robustness: the parser receives files from the internet and from
 * uploads. Whatever arrives, it must either parse or reject the file with
 * `SrtParseError` — never crash with another error, never hang — and anything
 * it accepts must survive a serialize → parse round trip unchanged.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeSubtitleBytes, parseSrt, serializeSrt, SrtParseError } from './index.js';

const DIR = new URL('../../../fixtures/subtitles/', import.meta.url);
const FIXTURES = readdirSync(DIR)
  .filter((f) => f.endsWith('.srt'))
  .map((f) => decodeSubtitleBytes(readFileSync(new URL(f, DIR))).text);

/** Small deterministic PRNG (mulberry32), so a failure can be reproduced from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  return { next, int, pick };
}

const NASTY = [
  '\u0000',
  '﻿',
  '\r',
  '\r\n',
  '\n\n\n',
  '-->',
  ' --> ',
  '00:00:00,000 --> 00:00:00,000',
  '99:99:99,999 --> 00:00:01,000',
  '-1',
  '<i>',
  '</i>',
  '{\\an8}',
  '{\\',
  '<font color="',
  '‮',
  '𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
  'ћирилица',
  '\t',
  '9'.repeat(400),
  ':'.repeat(200),
  ',000 --> '.repeat(100),
];

function mutate(text: string, r: ReturnType<typeof rng>): string {
  let lines = text.split('\n');
  const steps = 1 + r.int(6);
  for (let s = 0; s < steps; s++) {
    const i = r.int(Math.max(1, lines.length));
    switch (r.int(7)) {
      case 0:
        lines.splice(i, 1);
        break;
      case 1:
        lines.splice(i, 0, lines[r.int(lines.length)] ?? '');
        break;
      case 2:
        lines.splice(i, 0, r.pick(NASTY));
        break;
      case 3: {
        const line = lines[i] ?? '';
        const at = r.int(line.length + 1);
        lines[i] = line.slice(0, at) + r.pick(NASTY) + line.slice(at + r.int(4));
        break;
      }
      case 4:
        lines = lines.slice(0, r.int(lines.length + 1));
        break;
      case 5:
        lines[i] = (lines[i] ?? '').replace(/\d/g, () => String(r.int(10)));
        break;
      default:
        lines[i] = (lines[i] ?? '').repeat(1 + r.int(50));
    }
  }
  return lines.join(r.next() < 0.3 ? '\r\n' : '\n');
}

function check(input: string): void {
  const started = performance.now();
  let parsed;
  try {
    parsed = parseSrt(input);
  } catch (err) {
    if (!(err instanceof SrtParseError)) throw err;
    return;
  } finally {
    expect(performance.now() - started).toBeLessThan(500);
  }
  // Serializing is canonical: doing it again on its own output changes nothing.
  const once = serializeSrt(parsed.entries);
  expect(serializeSrt(parseSrt(once).entries)).toBe(once);
}

describe('parser fuzzing', () => {
  it('handles 3000 mutated real subtitle files: parse or SrtParseError, nothing else', () => {
    for (let seed = 1; seed <= 3000; seed++) {
      const r = rng(seed);
      const input = mutate(r.pick(FIXTURES), r);
      try {
        check(input);
      } catch (err) {
        throw new Error(`seed ${seed}: ${(err as Error).message}`, { cause: err });
      }
    }
  });

  it('handles random bytes in any encoding', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const r = rng(seed);
      const bytes = new Uint8Array(r.int(2000));
      for (let i = 0; i < bytes.length; i++) bytes[i] = r.int(256);
      if (seed % 3 === 0) bytes.set([0xef, 0xbb, 0xbf]);
      if (seed % 5 === 0) bytes.set([0xff, 0xfe]);
      const { text } = decodeSubtitleBytes(bytes);
      try {
        check(text);
      } catch (err) {
        throw new Error(`seed ${seed}: ${(err as Error).message}`, { cause: err });
      }
    }
  });

  it('does not take a number too long to be an index for an index (found by fuzzing)', () => {
    const parsed = parseSrt(
      '1\n00:00:01,000 --> 00:00:02,000\nA\n33333333333333333333\n00:00:03,000 --> 00:00:04,000\nB\n',
    );
    expect(parsed.entries.map((e) => [e.index, e.text])).toEqual([
      [1, 'A\n33333333333333333333'],
      [2, 'B'],
    ]);
    check(serializeSrt(parsed.entries));
  });

  it('stays fast on inputs built to trigger slow regular expressions', () => {
    const inputs = [
      `1\n${'0'.repeat(50_000)} --> 00:00:01,000\nx\n`,
      `1\n00:00:00,000 --> ${'0:'.repeat(20_000)}\nx\n`,
      `1\n00:00:00,000 --> 00:00:01,000\n${'<i'.repeat(20_000)}\n`,
      `1\n00:00:00,000 --> 00:00:01,000\n${'{\\'.repeat(20_000)}\n`,
      '\n'.repeat(200_000),
      ' \n'.repeat(100_000),
      `${'1\n00:00:00,000 --> 00:00:01,000\n'.repeat(5_000)}`,
    ];
    for (const input of inputs) check(input);
  });
});
