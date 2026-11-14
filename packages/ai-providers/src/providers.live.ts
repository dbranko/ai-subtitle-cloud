/**
 * LIVE integration test — calls the real provider APIs and spends real credits
 * (a 12-line subtitle per configured provider: a few cents at most).
 *
 *   pnpm test:live
 *
 * Uses the keys from `.env` / the environment. Providers without a key are
 * skipped. Not included in `pnpm test`.
 */
import { describe, expect, it } from 'vitest';
import { AI_PROVIDER_IDS, loadConfig } from '@asc/config';
import { parseSrt } from '@asc/subtitle-parser';
import {
  containsCyrillic,
  measureScript,
  stripTags,
  translateSubtitle,
} from '@asc/translation-engine';
import {
  createProviderManagerFromConfig,
  resolveTargets,
  segmentationFromConfig,
} from './index.js';
import { fixtureText } from './test-fixtures.js';

const config = loadConfig();
const srt = fixtureText('basic-movie.srt');
const source = parseSrt(srt).entries;

describe('live providers', () => {
  it('has at least one provider key configured', () => {
    expect(
      Object.keys(config.ai.apiKeys),
      'Set ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY in .env to run the live test.',
    ).not.toHaveLength(0);
  });

  describe.each(AI_PROVIDER_IDS)('%s', (provider) => {
    const configured = config.ai.apiKeys[provider] !== undefined;
    const model = resolveTargets(config, { provider }).primary.model;

    it.skipIf(!configured).each(['sr-Latn', 'sr-Cyrl'])(
      `translates English → %s with ${model}`,
      async (target) => {
        const manager = createProviderManagerFromConfig(
          config,
          { provider, fallbackProvider: null },
          {
            onEvent: (e) => {
              if (e.type === 'attempt_failed')
                console.warn(`  ${e.provider} ${e.kind}: ${e.message}`);
            },
          },
        );
        const result = await translateSubtitle(
          {
            srt,
            sourceLanguage: 'en',
            targetLanguage: target,
            mediaContext: { type: 'movie', title: 'Lost Again' },
          },
          manager.translator,
          { segmentation: segmentationFromConfig(config) },
        );

        expect(result.entries).toHaveLength(source.length);
        result.entries.forEach((entry, i) => {
          expect(entry.index).toBe(source[i]?.index);
          expect(entry.startMs).toBe(source[i]?.startMs);
          expect(entry.endMs).toBe(source[i]?.endMs);
          expect(entry.text.trim()).not.toBe('');
          expect(entry.text).not.toBe(source[i]?.text);
        });
        const text = result.entries.map((e) => stripTags(e.text)).join('\n');
        if (target === 'sr-Latn') expect(containsCyrillic(text)).toBe(false);
        else expect(measureScript(text, 'Cyrl').ratio).toBeGreaterThan(0.9);
        expect(result.stats.usage.outputTokens).toBeGreaterThan(0);

        const { stats, metadata } = result;
        const cost = stats.costUsd === null ? 'unknown' : `$${stats.costUsd.toFixed(4)}`;
        console.log(
          `\n[${provider}] ${metadata.models.map((m) => m.model).join(', ')} → ${target}: ` +
            `${stats.attempts} request(s), ${stats.usage.inputTokens} in / ` +
            `${stats.usage.outputTokens} out tokens, cost ${cost}, ${stats.translationMs} ms\n` +
            result.entries
              .slice(0, 4)
              .map((e) => `    ${e.text.replace(/\n/g, ' / ')}`)
              .join('\n'),
        );
      },
    );
  });
});
