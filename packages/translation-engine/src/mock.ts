import { setTimeout as sleep } from 'node:timers/promises';
import type { LanguageDefinition, ScriptCode } from './languages.js';
import type {
  SegmentTranslationRequest,
  SegmentTranslationResponse,
  SegmentTranslator,
  TranslationItem,
} from './translator.js';

/**
 * Deterministic stand-in for an AI provider. Used by automated tests and by
 * development runs so that no real API credits are ever spent by accident.
 *
 * It "translates" by rewriting letters into the target script while leaving
 * markup, punctuation, digits and line breaks untouched — enough to exercise
 * every structural guarantee of the engine with predictable output.
 */

const LATIN_PSEUDO: Record<string, string> = { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú' };
const CYRILLIC = 'абцдефгхијклмнопкрстуввкиз'; // a..z
const SAMPLE_ALPHABETS: Partial<Record<ScriptCode, string>> = {
  Grek: 'αβγδεζηθικλμνξοπρστυφχψω',
  Arab: 'ابتثجحخدذرزسشصضطظعغفقكلمنهوي',
  Hebr: 'אבגדהוזחטיכלמנסעפצקרשת',
  Hans: '的一是不了人我在有他这为之大来以个中上们',
  Hant: '的一是不了人我在有他這為之大來以個中上們',
  Jpan: 'あいうえおかきくけこさしすせそたちつてとなにぬねの',
  Kore: '가나다라마바사아자차카타파하거너더러머버서어저처',
  Deva: 'अआइईउऊएऐओऔकखगघचछजझटठडढणतथद',
  Thai: 'กขคงจฉชซญดตถทนบปผฝพฟภมยรลว',
};

const TAG_SPLIT_RE = /(<\/?[a-zA-Z][^<>]*>|\{\\[^{}]*\})/;

/** Pseudo-translate one subtitle text into the target language's script. */
export function mockTranslateText(text: string, target: LanguageDefinition): string {
  return text
    .split(TAG_SPLIT_RE)
    .map((part, i) => (i % 2 === 1 ? part : rewriteLetters(part, target.script)))
    .join('');
}

function rewriteLetters(text: string, script: ScriptCode): string {
  return text.replace(/[a-zA-Z]/g, (ch) => {
    const lower = ch.toLowerCase();
    const upper = ch !== lower;
    const position = lower.charCodeAt(0) - 97;
    if (script === 'Latn') {
      const mapped = LATIN_PSEUDO[lower] ?? lower;
      return upper ? mapped.toUpperCase() : mapped;
    }
    if (script === 'Cyrl') {
      const mapped = CYRILLIC[position] ?? lower;
      return upper ? mapped.toUpperCase() : mapped;
    }
    const alphabet = [...(SAMPLE_ALPHABETS[script] ?? '')];
    return alphabet[position % alphabet.length] ?? ch;
  });
}

/** Ways the mock can misbehave, to test validation, retries and failure handling. */
export type MockFault =
  | 'missing_entry'
  | 'extra_entry'
  | 'duplicate_entry'
  | 'empty_translation'
  | 'drop_tags'
  | 'commentary'
  | 'cyrillic_output'
  | 'untranslated'
  | 'error';

export interface MockTranslatorOptions {
  /** Artificial latency per call, to simulate a slow provider. */
  delayMs?: number;
  /** Decide per call whether (and how) to misbehave. Default: never. */
  fault?: (request: SegmentTranslationRequest) => MockFault | undefined;
  /** Replace the built-in pseudo-translation. */
  translate?: (text: string, request: SegmentTranslationRequest) => string;
}

export interface MockTranslator extends SegmentTranslator {
  /** Every request received, in order (for assertions). */
  readonly calls: SegmentTranslationRequest[];
}

export const MOCK_PROVIDER = 'mock';
export const MOCK_MODEL = 'mock-pseudo-1';

export function createMockTranslator(options: MockTranslatorOptions = {}): MockTranslator {
  const calls: SegmentTranslationRequest[] = [];
  return {
    calls,
    async translateSegment(request, callOptions = {}): Promise<SegmentTranslationResponse> {
      calls.push(request);
      if (options.delayMs) {
        await sleep(
          options.delayMs,
          undefined,
          callOptions.signal ? { signal: callOptions.signal } : {},
        );
      }
      callOptions.signal?.throwIfAborted();

      const fault = options.fault?.(request);
      if (fault === 'error') throw new Error('Mock provider failure');

      const translate = (text: string) =>
        options.translate
          ? options.translate(text, request)
          : mockTranslateText(text, request.targetLanguage);
      let items: TranslationItem[] = request.items.map((i) => ({
        id: i.id,
        text: translate(i.text),
      }));
      const first = items[0];

      switch (fault) {
        case 'missing_entry':
          items = items.slice(0, -1);
          break;
        case 'extra_entry':
          items.push({ id: 999_999, text: 'extra' });
          break;
        case 'duplicate_entry':
          if (first) items.push({ ...first });
          break;
        case 'empty_translation':
          if (first) items[0] = { id: first.id, text: '   ' };
          break;
        case 'drop_tags':
          items = items.map((i) => ({
            id: i.id,
            text: i.text.replace(/<[^<>]*>|\{\\[^{}]*\}/g, ''),
          }));
          break;
        case 'commentary':
          if (first) items[0] = { id: first.id, text: `Here is the translation: ${first.text}` };
          break;
        case 'cyrillic_output':
          items = request.items.map((i) => ({
            id: i.id,
            text: i.text
              .split(TAG_SPLIT_RE)
              .map((part, n) => (n % 2 === 1 ? part : rewriteLetters(part, 'Cyrl')))
              .join(''),
          }));
          break;
        case 'untranslated':
          items = request.items.map((i) => ({ ...i }));
          break;
        default:
          break;
      }

      const chars = (list: { text: string }[]) => list.reduce((n, i) => n + i.text.length, 0);
      return {
        items,
        provider: MOCK_PROVIDER,
        model: MOCK_MODEL,
        usage: {
          inputTokens: Math.ceil(
            (chars(request.items) + chars(request.contextBefore) + chars(request.contextAfter)) / 4,
          ),
          outputTokens: Math.ceil(chars(items) / 4),
        },
      };
    },
  };
}
