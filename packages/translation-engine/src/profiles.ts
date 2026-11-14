export const TRANSLATION_PROFILES = [
  'natural',
  'literal',
  'cinematic',
  'concise',
  'custom',
] as const;
export type TranslationProfileId = (typeof TRANSLATION_PROFILES)[number];

export interface TranslationProfile {
  id: TranslationProfileId;
  name: string;
  description: string;
  /** Style instruction inserted into the prompt. Empty for `custom` (the owner supplies it). */
  instruction: string;
}

const PROFILES: Record<TranslationProfileId, TranslationProfile> = {
  natural: {
    id: 'natural',
    name: 'Natural',
    description: 'Fluent, idiomatic everyday speech. Recommended default.',
    instruction:
      'Style: natural. Write the way native speakers actually talk. Prefer idiomatic ' +
      'equivalents over word-for-word renderings, while keeping the full meaning and tone.',
  },
  literal: {
    id: 'literal',
    name: 'Literal',
    description: 'Stays close to the original wording and sentence structure.',
    instruction:
      'Style: literal. Stay as close to the original wording and sentence structure as the ' +
      'target language allows without becoming ungrammatical. Do not embellish or reinterpret.',
  },
  cinematic: {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Expressive; preserves mood, rhythm and each character’s voice.',
    instruction:
      'Style: cinematic. Preserve the mood, rhythm and dramatic weight of each line and give ' +
      'every character a consistent, distinctive voice (register, slang, formality).',
  },
  concise: {
    id: 'concise',
    name: 'Concise',
    description: 'Shortest faithful wording, for fast dialogue and easy reading.',
    instruction:
      'Style: concise. Use the shortest wording that keeps the meaning. Drop filler words and ' +
      'redundant repetitions so every subtitle can be read comfortably in its display time.',
  },
  custom: {
    id: 'custom',
    name: 'Custom',
    description: 'Follows the owner’s own style instructions.',
    instruction: '',
  },
};

export function isTranslationProfileId(value: string): value is TranslationProfileId {
  return (TRANSLATION_PROFILES as readonly string[]).includes(value);
}

export function getProfile(id: TranslationProfileId): TranslationProfile {
  return PROFILES[id];
}

export function listProfiles(): TranslationProfile[] {
  return TRANSLATION_PROFILES.map((id) => PROFILES[id]);
}
