/**
 * JSON Schema of the answer every provider is asked to produce. Passing it to
 * each provider's structured-output feature makes malformed replies rare; the
 * engine's tolerant parser and validation remain the actual safety net.
 */
export const TRANSLATION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          text: { type: 'string' },
        },
        required: ['id', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
} as const;

export const TRANSLATION_OUTPUT_SCHEMA_NAME = 'subtitle_translations';
