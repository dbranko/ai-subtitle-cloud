import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  allowedTransitions,
  assertTransition,
  canTransition,
  computePercentage,
  computeTranslationKey,
  estimateRemainingSeconds,
  InvalidTransitionError,
  isTerminal,
  JOB_STATES,
  PROCESSING_STATES,
  STAGE_WEIGHTS,
  TERMINAL_STATES,
  type JobState,
} from './index.js';

describe('job states', () => {
  it('defines exactly the required states', () => {
    expect(JOB_STATES).toEqual([
      'queued',
      'locating_source',
      'downloading_source',
      'parsing',
      'preparing_context',
      'translating',
      'validating',
      'saving',
      'completed',
      'failed',
      'cancelled',
    ]);
    expect(TERMINAL_STATES).toEqual(['completed', 'failed', 'cancelled']);
    expect([...ACTIVE_STATES, ...TERMINAL_STATES].sort()).toEqual([...JOB_STATES].sort());
  });

  it('allows the normal pipeline, step by step', () => {
    const pipeline: JobState[] = [
      'queued',
      'locating_source',
      'downloading_source',
      'parsing',
      'preparing_context',
      'translating',
      'validating',
      'saving',
      'completed',
    ];
    for (let i = 0; i < pipeline.length - 1; i++) {
      expect(
        canTransition(pipeline[i]!, pipeline[i + 1]!),
        `${pipeline[i]} → ${pipeline[i + 1]}`,
      ).toBe(true);
    }
  });

  it('rejects skipping stages and moving backwards', () => {
    const illegal: [JobState, JobState][] = [
      ['queued', 'translating'],
      ['queued', 'completed'],
      ['locating_source', 'parsing'],
      ['parsing', 'translating'],
      ['translating', 'saving'],
      ['translating', 'completed'],
      ['validating', 'completed'],
      ['saving', 'translating'],
      ['translating', 'parsing'],
    ];
    for (const [from, to] of illegal) {
      expect(canTransition(from, to), `${from} → ${to}`).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(InvalidTransitionError);
    }
  });

  it('lets every processing state fail, be cancelled, or return to the queue', () => {
    for (const state of PROCESSING_STATES) {
      for (const to of ['failed', 'cancelled', 'queued'] as const) {
        expect(canTransition(state, to), `${state} → ${to}`).toBe(true);
      }
    }
    expect(canTransition('queued', 'cancelled')).toBe(true);
  });

  it('makes completed and cancelled final, and failed retryable only by re-queueing', () => {
    expect(allowedTransitions('completed')).toEqual([]);
    expect(allowedTransitions('cancelled')).toEqual([]);
    expect(allowedTransitions('failed')).toEqual(['queued']);
    for (const state of JOB_STATES) {
      expect(canTransition('completed', state)).toBe(false);
      expect(canTransition('cancelled', state)).toBe(false);
      expect(canTransition(state, state)).toBe(false);
    }
    expect(isTerminal('failed')).toBe(true);
    expect(isTerminal('translating')).toBe(false);
  });

  it('allows validation to send segments back for re-translation', () => {
    expect(canTransition('validating', 'translating')).toBe(true);
  });
});

describe('computePercentage', () => {
  const at = (state: JobState, completedSegments = 0, totalSegments = 0, previous = 0) =>
    computePercentage({ state, completedSegments, totalSegments }, previous);

  it('uses weights that add up to 100', () => {
    expect(Object.values(STAGE_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
    expect(STAGE_WEIGHTS).toEqual({
      discovery: 5,
      downloadAndParsing: 10,
      context: 10,
      translation: 65,
      validation: 7,
      saving: 3,
    });
  });

  it('credits a stage only when it has finished', () => {
    expect(at('queued')).toBe(0);
    expect(at('locating_source')).toBe(0);
    expect(at('downloading_source')).toBe(5);
    expect(at('parsing')).toBe(10);
    expect(at('preparing_context')).toBe(15);
    expect(at('translating', 0, 4)).toBe(25);
    expect(at('validating', 4, 4)).toBe(90);
    expect(at('saving', 4, 4)).toBe(97);
    expect(at('completed', 4, 4)).toBe(100);
  });

  it('advances translation strictly by accepted segments', () => {
    expect(at('translating', 1, 4)).toBe(41.3);
    expect(at('translating', 2, 4)).toBe(57.5);
    expect(at('translating', 3, 4)).toBe(73.8);
    expect(at('translating', 4, 4)).toBe(90);
    expect(at('translating', 1, 3)).toBe(46.7);
    expect(at('translating', 0, 0)).toBe(25);
  });

  it('never reports 100 before completion', () => {
    for (const state of JOB_STATES.filter((s) => s !== 'completed')) {
      expect(at(state, 10, 10, 100)).toBeLessThan(100);
    }
    expect(at('saving', 10, 10)).toBe(97);
  });

  it('recalculates safely when the number of segments changes', () => {
    expect(at('translating', 2, 4)).toBe(57.5);
    expect(at('translating', 2, 8)).toBe(41.3);
    expect(at('translating', 9, 4)).toBe(90);
    expect(at('translating', -1, 4)).toBe(25);
  });

  it('keeps the credit of accepted segments while a resumed job passes the early stages', () => {
    expect(at('queued', 2, 4)).toBe(57.5);
    expect(at('parsing', 2, 4)).toBe(57.5);
    expect(at('preparing_context', 0, 4)).toBe(15);
  });

  it('freezes the percentage of failed and cancelled jobs', () => {
    expect(at('failed', 2, 4, 57.5)).toBe(57.5);
    expect(at('cancelled', 2, 4, 41.3)).toBe(41.3);
    expect(at('failed', 4, 4, 100)).toBe(99);
  });
});

describe('estimateRemainingSeconds', () => {
  it('gives no estimate before two segments were measured', () => {
    expect(estimateRemainingSeconds([], 100)).toBeNull();
    expect(estimateRemainingSeconds([{ entries: 40, durationMs: 20_000 }], 100)).toBeNull();
  });

  it('estimates from measured time per entry', () => {
    const steady = [
      { entries: 40, durationMs: 20_000 },
      { entries: 40, durationMs: 20_000 },
    ];
    expect(estimateRemainingSeconds(steady, 80)).toBe(40);
    expect(estimateRemainingSeconds(steady, 0)).toBe(0);
  });

  it('weights recent segments more, so a slowdown shows up quickly', () => {
    const slowing = [
      { entries: 40, durationMs: 20_000 },
      { entries: 40, durationMs: 20_000 },
      { entries: 40, durationMs: 60_000 },
    ];
    // 0.5 s/entry, 0.5, then 1.5 → weighted 1.0 s/entry.
    expect(estimateRemainingSeconds(slowing, 40)).toBe(40);
  });

  it('accounts for segments of different sizes and ignores unusable samples', () => {
    const mixed = [
      { entries: 20, durationMs: 10_000 },
      { entries: 0, durationMs: 5000 },
      { entries: 60, durationMs: 30_000 },
    ];
    expect(estimateRemainingSeconds(mixed, 50)).toBe(25);
  });
});

describe('computeTranslationKey', () => {
  const base = {
    sourceHash: 'abc',
    targetLanguage: 'sr-Latn',
    targetScript: 'Latn',
    profile: 'natural',
  };

  it('is stable for equivalent requests', () => {
    expect(computeTranslationKey(base)).toBe(computeTranslationKey({ ...base }));
    expect(computeTranslationKey({ ...base, customInstructions: '  ' })).toBe(
      computeTranslationKey(base),
    );
  });

  it('changes with anything that changes the translation', () => {
    const key = computeTranslationKey(base);
    expect(computeTranslationKey({ ...base, sourceHash: 'abd' })).not.toBe(key);
    expect(
      computeTranslationKey({ ...base, targetLanguage: 'sr-Cyrl', targetScript: 'Cyrl' }),
    ).not.toBe(key);
    expect(computeTranslationKey({ ...base, profile: 'literal' })).not.toBe(key);
    expect(computeTranslationKey({ ...base, customInstructions: 'Be formal.' })).not.toBe(key);
  });
});
