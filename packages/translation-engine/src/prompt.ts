import { getProfile } from './profiles.js';
import type { MediaContext, SegmentTranslationRequest } from './translator.js';

export interface SegmentPrompt {
  system: string;
  user: string;
}

const RULES = [
  'Translate the meaning of each line, not word by word. Read the surrounding dialogue first.',
  'Keep character names, place names and brand names consistent; do not translate personal names.',
  'Use the same translation for a recurring term every time it appears.',
  'Preserve humor, idioms, sarcasm and cultural meaning with natural equivalents in the target language.',
  'Use natural, conversational language that people actually speak.',
  'Keep every subtitle short and readable; do not expand, explain or add information.',
  'Keep line breaks where they help readability: at most 2 lines per subtitle, ideally under 42 characters per line.',
  'Copy formatting tags exactly as they are (for example <i>, </i>, <b>, <font color="...">, {\\an8}) and keep them around the corresponding words.',
  'Keep speaker labels (for example "MARTHA:"), leading dialogue dashes ("- "), music symbols (♪) and bracket characters. Translate sound descriptions inside brackets, e.g. [door slams].',
  'Leave subtitles that contain no words (for example "...", "♪♪") unchanged.',
  'Never merge, split, reorder, skip or add subtitles: return exactly one translation for every id you are given.',
];

/** Build the system and user prompt for one segment. Pure function of the request. */
export function buildSegmentPrompt(request: SegmentTranslationRequest): SegmentPrompt {
  const { targetLanguage, sourceLanguage } = request;
  const from = sourceLanguage ? sourceLanguage.name : 'the source language (detect it)';
  const profile = getProfile(request.profile);
  const custom = request.customInstructions?.trim();

  const system = [
    `You are a professional subtitle translator for film and television. Translate subtitles from ${from} into ${targetLanguage.name} (${targetLanguage.nativeName}).`,
    '',
    'Rules:',
    ...RULES.map((rule, i) => `${i + 1}. ${rule}`),
    '',
    ...(targetLanguage.targetNote ? [`Target language: ${targetLanguage.targetNote}`, ''] : []),
    ...(profile.instruction ? [profile.instruction, ''] : []),
    ...(custom ? [`Additional instructions from the owner: ${custom}`, ''] : []),
    'Output format: reply with a single JSON object and nothing else — no explanations, no notes, no markdown.',
    '{"translations":[{"id":<number>,"text":"<translated subtitle>"}]}',
    'Use "\\n" inside "text" for a line break. Include every id from the "translate" list exactly once, and no other ids.',
  ].join('\n');

  const sections: string[] = [];
  const media = describeMedia(request.mediaContext);
  if (media) sections.push(`Media: ${media}`);
  sections.push(`Part ${request.segmentIndex + 1} of ${request.segmentCount}.`);

  if (request.contextBefore.length > 0) {
    sections.push(
      'Preceding subtitles — context only, already translated, do NOT return them:\n' +
        JSON.stringify(
          request.contextBefore.map((c) =>
            c.translation === undefined
              ? { id: c.id, text: c.text }
              : { id: c.id, text: c.text, translation: c.translation },
          ),
        ),
    );
  }
  if (request.contextAfter.length > 0) {
    sections.push(
      'Following subtitles — context only, do NOT return them:\n' +
        JSON.stringify(request.contextAfter.map((c) => ({ id: c.id, text: c.text }))),
    );
  }
  if (request.previousIssues.length > 0) {
    sections.push(
      'Your previous answer for this part was rejected. Fix these problems:\n' +
        request.previousIssues.map((issue) => `- ${issue}`).join('\n'),
    );
  }
  sections.push(
    `Translate these ${request.items.length} subtitles:\n` +
      JSON.stringify({ translate: request.items.map((i) => ({ id: i.id, text: i.text })) }),
  );

  return { system, user: sections.join('\n\n') };
}

function describeMedia(media: MediaContext | undefined): string {
  if (!media) return '';
  const parts: string[] = [];
  if (media.title) parts.push(media.year ? `${media.title} (${media.year})` : media.title);
  if (media.type) parts.push(media.type === 'series' ? 'TV series' : 'movie');
  if (media.season !== undefined && media.episode !== undefined) {
    parts.push(`season ${media.season}, episode ${media.episode}`);
  }
  if (media.episodeTitle) parts.push(`"${media.episodeTitle}"`);
  let text = parts.join(', ');
  if (media.synopsis?.trim()) text += `${text ? '. ' : ''}Synopsis: ${media.synopsis.trim()}`;
  return text;
}
