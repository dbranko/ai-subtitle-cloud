import { describe, expect, it } from 'vitest';
import {
  buildSegmentPrompt,
  createLlmTranslator,
  parseTranslationResponse,
  resolveTargetLanguage,
  TranslationResponseError,
  type LlmRequest,
  type SegmentTranslationRequest,
} from './index.js';

const request = (
  overrides: Partial<SegmentTranslationRequest> = {},
): SegmentTranslationRequest => ({
  segmentIndex: 1,
  segmentCount: 4,
  targetLanguage: resolveTargetLanguage('sr-Latn'),
  profile: 'natural',
  contextBefore: [{ id: 40, text: 'Where is he?', translation: 'Gde je on?' }],
  contextAfter: [{ id: 43, text: 'Fine.' }],
  items: [
    { id: 41, text: '<i>I told you.</i>' },
    { id: 42, text: 'Line one\nLine two' },
  ],
  attempt: 1,
  previousIssues: [],
  ...overrides,
});

describe('buildSegmentPrompt', () => {
  it('states languages, script and quality rules in the system prompt', () => {
    const { system } = buildSegmentPrompt(request());
    expect(system).toContain('into Serbian (Latin) (Srpski (latinica))');
    expect(system).toContain('the source language (detect it)');
    expect(system).toContain('LATIN script');
    expect(system).toContain('Never use Cyrillic');
    expect(system).toMatch(/meaning of each line, not word by word/);
    expect(system).toMatch(/do not translate personal names/);
    expect(system).toMatch(/humor, idioms/);
    expect(system).toMatch(/do not expand, explain or add/);
    expect(system).toMatch(/formatting tags exactly/);
    expect(system).toMatch(/single JSON object and nothing else/);
    expect(system).toContain('Style: natural');
  });

  it('names the source language and the Cyrillic script when given', () => {
    const { system } = buildSegmentPrompt(
      request({
        sourceLanguage: resolveTargetLanguage('en'),
        targetLanguage: resolveTargetLanguage('sr-Cyrl'),
        profile: 'cinematic',
      }),
    );
    expect(system).toContain('from English into Serbian (Cyrillic)');
    expect(system).toContain('CYRILLIC script');
    expect(system).toContain('Style: cinematic');
  });

  it('includes custom instructions', () => {
    const { system } = buildSegmentPrompt(
      request({ profile: 'custom', customInstructions: 'Use informal "ti" everywhere.' }),
    );
    expect(system).toContain(
      'Additional instructions from the owner: Use informal "ti" everywhere.',
    );
    expect(system).not.toContain('Style:');
  });

  it('sends items as JSON and marks context as not to be returned', () => {
    const { user } = buildSegmentPrompt(
      request({
        mediaContext: { type: 'series', title: 'Harbor Lights', year: 1987, season: 2, episode: 5 },
      }),
    );
    expect(user).toContain('Media: Harbor Lights (1987), TV series, season 2, episode 5');
    expect(user).toContain('Part 2 of 4.');
    expect(user).toContain('{"id":40,"text":"Where is he?","translation":"Gde je on?"}');
    expect(user).toContain(
      'Following subtitles — context only, do NOT return them:\n[{"id":43,"text":"Fine."}]',
    );
    expect(user).toContain(
      'Translate these 2 subtitles:\n{"translate":[{"id":41,"text":"<i>I told you.</i>"},{"id":42,"text":"Line one\\nLine two"}]}',
    );
    expect(user).not.toContain('rejected');
  });

  it('never sends timestamps or index metadata', () => {
    const { system, user } = buildSegmentPrompt(request());
    expect(system + user).not.toMatch(/-->/);
    expect(system + user).not.toMatch(/\d\d:\d\d:\d\d/);
  });

  it('feeds validation problems back on a retry', () => {
    const { user } = buildSegmentPrompt(
      request({ attempt: 2, previousIssues: ['id 42 is missing.'] }),
    );
    expect(user).toContain('Your previous answer for this part was rejected');
    expect(user).toContain('- id 42 is missing.');
  });
});

describe('parseTranslationResponse', () => {
  const expected = [
    { id: 1, text: 'Zdravo' },
    { id: 2, text: 'Prvi red\nDrugi red' },
  ];
  const json = '{"translations":[{"id":1,"text":"Zdravo"},{"id":2,"text":"Prvi red\\nDrugi red"}]}';

  it('parses the requested JSON object', () => {
    expect(parseTranslationResponse(json)).toEqual({ items: expected, extraneousText: false });
  });

  it('accepts a markdown code fence', () => {
    expect(parseTranslationResponse('```json\n' + json + '\n```')).toEqual({
      items: expected,
      extraneousText: false,
    });
  });

  it('accepts a bare array and string ids', () => {
    expect(parseTranslationResponse('[{"id":"1","text":"Zdravo"}]').items).toEqual([
      { id: 1, text: 'Zdravo' },
    ]);
  });

  it('extracts the JSON but flags commentary around it', () => {
    const chatty = `Sure! Here is the translation:\n${json}\nLet me know if you need anything else.`;
    expect(parseTranslationResponse(chatty)).toEqual({ items: expected, extraneousText: true });
    const fenced = 'Here you go:\n```json\n' + json + '\n```';
    expect(parseTranslationResponse(fenced).extraneousText).toBe(true);
  });

  it('keeps braces and brackets that are part of subtitle text', () => {
    const tricky = '{"translations":[{"id":7,"text":"{\\\\an8}[vrata lupaju]"}]}';
    expect(parseTranslationResponse(tricky).items).toEqual([
      { id: 7, text: '{\\an8}[vrata lupaju]' },
    ]);
  });

  it.each([
    ['empty', ''],
    ['prose only', 'I cannot translate this.'],
    ['truncated JSON', '{"translations":[{"id":1,"text":"Zdr'],
    ['wrong shape', '{"result":"ok"}'],
    ['item without text', '{"translations":[{"id":1}]}'],
    ['item without id', '{"translations":[{"text":"x"}]}'],
    ['non-integer id', '{"translations":[{"id":1.5,"text":"x"}]}'],
    ['non-object item', '{"translations":["x"]}'],
  ])('rejects invalid output: %s', (_name, raw) => {
    expect(() => parseTranslationResponse(raw)).toThrow(TranslationResponseError);
  });
});

describe('createLlmTranslator', () => {
  it('builds the prompt, calls the client and parses its reply', async () => {
    const seen: LlmRequest[] = [];
    const translator = createLlmTranslator({
      complete: (req) => {
        seen.push(req);
        return Promise.resolve({
          text: '{"translations":[{"id":41,"text":"<i>Rekao sam ti.</i>"},{"id":42,"text":"Prvi\\nDrugi"}]}',
          usage: { inputTokens: 120, outputTokens: 30 },
          provider: 'test',
          model: 'test-1',
        });
      },
    });
    const response = await translator.translateSegment(request());
    expect(seen).toHaveLength(1);
    expect(seen[0]?.system).toContain('professional subtitle translator');
    expect(seen[0]?.user).toContain('"translate"');
    expect(response).toEqual({
      items: [
        { id: 41, text: '<i>Rekao sam ti.</i>' },
        { id: 42, text: 'Prvi\nDrugi' },
      ],
      usage: { inputTokens: 120, outputTokens: 30 },
      provider: 'test',
      model: 'test-1',
    });
  });

  it('passes the abort signal through and surfaces unparseable replies', async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const translator = createLlmTranslator({
      complete: (req) => {
        received = req.signal;
        return Promise.resolve({ text: 'Sorry, I cannot help with that.' });
      },
    });
    await expect(
      translator.translateSegment(request(), { signal: controller.signal }),
    ).rejects.toThrow(TranslationResponseError);
    expect(received).toBe(controller.signal);
  });
});
