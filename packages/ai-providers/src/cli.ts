/**
 * Command-line translator: the engine + real providers without the dashboard.
 *
 *   pnpm translate movie.srt --to sr-Latn
 *   pnpm translate movie.srt --to hr --from en --provider openai --model gpt-6.1-terra
 *   pnpm translate movie.srt --to sr-Cyrl --mock        (no API call, no cost)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  AI_EFFORT_LEVELS,
  AI_PROVIDER_IDS,
  loadConfig,
  type AiEffort,
  type AiProviderId,
} from '@asc/config';
import { decodeSubtitleBytes } from '@asc/subtitle-parser';
import {
  createMockTranslator,
  findLanguage,
  isTranslationProfileId,
  resolveTargetLanguage,
  translateSubtitle,
  type SegmentTranslator,
} from '@asc/translation-engine';
import {
  createProviderManagerFromConfig,
  segmentationFromConfig,
  type ProviderManager,
} from './index.js';

const USAGE = `Usage: pnpm translate <file.srt> --to <language> [options]

  --to <id>          target language, e.g. sr-Latn, sr-Cyrl, hr, en, de (required)
  --from <id>        source language (default: detect)
  --provider <id>    ${AI_PROVIDER_IDS.join(' | ')} (default: AI_PROVIDER)
  --model <id>       model id (default: AI_MODEL or the provider's default)
  --profile <id>     natural | literal | cinematic | concise | custom
  --instructions <t> extra style instructions (required for --profile custom)
  --effort <level>   ${AI_EFFORT_LEVELS.join(' | ')}
  --title <text>     media title, given to the translator as context
  --out <file>       output path (default: <name>.<language>.srt next to the input)
  --mock             use the built-in mock translator: no API call, no cost
`;

function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid ${flag}: "${value}". Allowed: ${allowed.join(', ')}.`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      from: { type: 'string' },
      provider: { type: 'string' },
      model: { type: 'string' },
      profile: { type: 'string' },
      instructions: { type: 'string' },
      effort: { type: 'string' },
      title: { type: 'string' },
      out: { type: 'string' },
      mock: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const input = positionals[0];
  if (values.help || !input || !values.to) {
    process.stdout.write(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  // INIT_CWD is where the owner ran `pnpm translate`, so relative paths behave as typed.
  const cwd = process.env.INIT_CWD ?? process.cwd();
  const inputPath = resolve(cwd, input);
  const target = resolveTargetLanguage(values.to);
  const profile = values.profile ?? undefined;
  if (profile !== undefined && !isTranslationProfileId(profile)) {
    throw new Error(`Unknown profile "${profile}".`);
  }

  const config = loadConfig();
  const source = values.from ? findLanguage(values.from) : undefined;
  const { text, encoding } = decodeSubtitleBytes(
    readFileSync(inputPath),
    source?.legacyEncoding ?? 'windows-1252',
  );

  let translator: SegmentTranslator;
  let manager: ProviderManager | undefined;
  if (values.mock) {
    translator = createMockTranslator();
  } else {
    manager = createProviderManagerFromConfig(
      config,
      {
        provider: oneOf<AiProviderId>(values.provider, AI_PROVIDER_IDS, '--provider'),
        model: values.model,
        effort: oneOf<AiEffort>(values.effort, AI_EFFORT_LEVELS, '--effort'),
      },
      {
        onEvent: (e) => {
          if (e.type === 'attempt_failed') {
            const retry =
              e.retryInMs === undefined ? '' : `, retrying in ${Math.round(e.retryInMs / 1000)}s`;
            console.error(`  ! ${e.provider} ${e.kind}: ${e.message}${retry}`);
          } else if (e.type === 'fallback') {
            console.error(`  ! switching to ${e.to.provider} / ${e.to.model}`);
          }
        },
      },
    );
    translator = manager.translator;
  }

  const using = manager
    ? manager.targets.map((t) => `${t.provider} / ${t.model}`).join(', then ')
    : 'mock';
  console.error(`Translating ${basename(inputPath)} (${encoding}) → ${target.name} using ${using}`);

  const result = await translateSubtitle(
    {
      srt: text,
      targetLanguage: target.id,
      ...(values.from ? { sourceLanguage: values.from } : {}),
      profile:
        profile ??
        (isTranslationProfileId(config.ai.translationProfile)
          ? config.ai.translationProfile
          : 'natural'),
      ...(values.instructions ? { customInstructions: values.instructions } : {}),
      ...(values.title ? { mediaContext: { title: values.title } } : {}),
    },
    translator,
    {
      segmentation: segmentationFromConfig(config),
      onProgress: (e) => {
        if (e.type === 'planned') {
          console.error(`  ${e.totalEntries} subtitles in ${e.totalSegments} segment(s)`);
        } else if (e.type === 'segment_attempt_failed') {
          console.error(
            `  ! segment ${e.segmentIndex + 1} attempt ${e.attempt} rejected: ${e.issues[0]?.message ?? ''}`,
          );
        } else if (e.type === 'segment_completed') {
          const seconds = (e.result.durationMs / 1000).toFixed(1);
          console.error(
            `  segment ${e.completedSegments}/${e.totalSegments} done (${e.completedEntries}/${e.totalEntries} subtitles, ${seconds}s)`,
          );
        }
      },
    },
  );

  const outPath = values.out
    ? resolve(cwd, values.out)
    : join(dirname(inputPath), `${basename(inputPath, extname(inputPath))}.${target.id}.srt`);
  writeFileSync(outPath, result.srt, 'utf8');

  const { stats } = result;
  const cost =
    stats.costUsd === null ? 'unknown (no price configured)' : `$${stats.costUsd.toFixed(4)}`;
  console.error(
    `Done: ${stats.entries} subtitles, ${stats.attempts} request(s), ${stats.retries} retried, ` +
      `${stats.usage.inputTokens} in / ${stats.usage.outputTokens} out tokens, estimated cost ${cost}`,
  );
  for (const w of result.validation.warnings.slice(0, 5)) console.error(`  note: ${w.message}`);
  console.error(`Saved: ${outPath}`);
}

main().catch((err: unknown) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
