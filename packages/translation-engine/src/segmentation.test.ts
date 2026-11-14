import { describe, expect, it } from 'vitest';
import { parseSrt, type SubtitleEntry } from '@asc/subtitle-parser';
import {
  adaptSegmentation,
  DEFAULT_SEGMENTATION,
  planSegments,
  resolveSegmentation,
  type PlannedSegment,
} from './index.js';
import { fixtureText } from './test-fixtures.js';

/** `count` back-to-back entries with no pauses, `chars` characters each. */
function uniform(count: number, chars = 20): SubtitleEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    index: i + 1,
    startMs: i * 2000,
    endMs: i * 2000 + 1900,
    text: 'x'.repeat(chars),
  }));
}
const sizes = (segments: PlannedSegment[]) => segments.map((s) => s.end - s.start);

function expectContiguous(segments: PlannedSegment[], total: number) {
  expect(segments[0]?.start).toBe(0);
  expect(segments[segments.length - 1]?.end).toBe(total);
  segments.forEach((s, i) => {
    expect(s.index).toBe(i);
    expect(s.end).toBeGreaterThan(s.start);
    if (i > 0) expect(s.start).toBe(segments[i - 1]?.end);
  });
}

describe('planSegments', () => {
  const long = parseSrt(fixtureText('long-episode.srt')).entries;

  it('uses the 30–60 entry range by default', () => {
    expect(DEFAULT_SEGMENTATION).toMatchObject({ minEntries: 30, maxEntries: 60 });
  });

  it('covers every entry exactly once, in order', () => {
    const segments = planSegments(long);
    expectContiguous(segments, long.length);
    expect(sizes(segments).reduce((a, b) => a + b, 0)).toBe(130);
  });

  it('keeps segments within the configured size', () => {
    const segments = planSegments(long);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    for (const size of sizes(segments)) {
      expect(size).toBeGreaterThanOrEqual(30);
      expect(size).toBeLessThanOrEqual(60);
    }
  });

  it('cuts at scene changes when one is available', () => {
    // The fixture has a long pause after every 17th entry.
    const segments = planSegments(long);
    for (const s of segments.slice(0, -1)) {
      expect(s.end % 17, `cut after entry ${s.end}`).toBe(0);
      const gap = (long[s.end]?.startMs ?? 0) - (long[s.end - 1]?.endMs ?? 0);
      expect(gap).toBeGreaterThanOrEqual(DEFAULT_SEGMENTATION.sceneGapMs);
    }
  });

  it('is deterministic', () => {
    expect(planSegments(long)).toEqual(planSegments(long));
  });

  it('returns one segment for a short file', () => {
    expect(planSegments(uniform(12))).toEqual([
      { index: 0, start: 0, end: 12, contextStart: 0, contextEnd: 12 },
    ]);
    expect(planSegments([])).toEqual([]);
  });

  it('falls back to the target size when there is no scene change', () => {
    expect(sizes(planSegments(uniform(200)))).toEqual([40, 40, 40, 40, 40]);
  });

  it('avoids a tiny final segment', () => {
    expect(sizes(planSegments(uniform(61)))).toEqual([31, 30]);
    expect(sizes(planSegments(uniform(65)))).toEqual([35, 30]);
    expect(sizes(planSegments(uniform(60)))).toEqual([60]);
  });

  it('respects the character budget even below the minimum entry count', () => {
    const entries = uniform(100, 100);
    const segments = planSegments(entries, { maxChars: 1000 });
    expectContiguous(segments, 100);
    for (const size of sizes(segments)) expect(size).toBeLessThanOrEqual(10);
  });

  it('always makes progress when a single entry exceeds the budget', () => {
    const segments = planSegments(uniform(5, 500), { maxChars: 100 });
    expect(sizes(segments)).toEqual([1, 1, 1, 1, 1]);
  });

  it('adds overlapping context before and after each segment', () => {
    const segments = planSegments(uniform(200), { contextBefore: 6, contextAfter: 3 });
    expect(segments[0]).toMatchObject({ start: 0, end: 40, contextStart: 0, contextEnd: 43 });
    expect(segments[1]).toMatchObject({ start: 40, end: 80, contextStart: 34, contextEnd: 83 });
    expect(segments[4]).toMatchObject({ start: 160, end: 200, contextStart: 154, contextEnd: 200 });
  });

  it('honours custom sizes', () => {
    const segments = planSegments(uniform(100), {
      minEntries: 10,
      targetEntries: 20,
      maxEntries: 25,
    });
    expect(sizes(segments)).toEqual([20, 20, 20, 20, 20]);
  });
});

describe('segmentation options', () => {
  it('normalises inconsistent values', () => {
    const o = resolveSegmentation({ minEntries: 80, targetEntries: 5, maxEntries: 50 });
    expect(o).toMatchObject({ minEntries: 50, targetEntries: 50, maxEntries: 50 });
    expect(resolveSegmentation({ maxEntries: 0, contextBefore: -3 })).toMatchObject({
      maxEntries: 1,
      contextBefore: 0,
    });
  });

  it('shrinks the character budget to fit provider limits', () => {
    expect(adaptSegmentation({}, {}).maxChars).toBe(DEFAULT_SEGMENTATION.maxChars);
    expect(adaptSegmentation({}, { maxOutputTokens: 4096 }).maxChars).toBe(2048);
    expect(adaptSegmentation({}, { maxOutputTokens: 64_000, maxInputTokens: 3000 }).maxChars).toBe(
      3000,
    );
    expect(adaptSegmentation({}, { maxOutputTokens: 100 }).maxChars).toBe(400);
    expect(adaptSegmentation({ maxChars: 1000 }, { maxOutputTokens: 64_000 }).maxChars).toBe(1000);
  });

  it('produces smaller segments for a small model', () => {
    const long = parseSrt(fixtureText('long-episode.srt')).entries;
    const small = planSegments(long, adaptSegmentation({}, { maxOutputTokens: 1024 }));
    const normal = planSegments(long);
    expect(small.length).toBeGreaterThan(normal.length);
    for (const s of small) {
      const chars = long.slice(s.start, s.end).reduce((n, e) => n + e.text.length, 0);
      expect(chars).toBeLessThanOrEqual(512);
    }
  });
});
