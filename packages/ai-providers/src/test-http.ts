/**
 * Test transport: serves canned HTTP responses to the real provider SDKs, in
 * each provider's actual wire format. No network, no API credits.
 */
import { mockTranslateText, resolveTargetLanguage } from '@asc/translation-engine';
import type { FetchLike } from './types.js';

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface FakeHttp {
  fetch: FetchLike;
  calls: RecordedCall[];
}

type Handler = (call: RecordedCall, index: number) => Response | Promise<Response>;

export function fakeHttp(handler: Handler): FakeHttp {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input, init);
    const text = await request.text();
    const call: RecordedCall = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
    };
    calls.push(call);
    init?.signal?.throwIfAborted();
    return handler(call, calls.length - 1);
  };
  return { fetch, calls };
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

// ---- Anthropic (Messages API, server-sent events) ---------------------------

export interface AnthropicReply {
  text?: string;
  model?: string;
  stopReason?: string;
  stopDetails?: Record<string, unknown>;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

export function anthropicStream(reply: AnthropicReply = {}): Response {
  const events: [string, unknown][] = [
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: reply.model ?? 'claude-opus-5-5',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: reply.inputTokens ?? 100,
            output_tokens: 1,
            cache_read_input_tokens: reply.cacheReadTokens ?? 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ],
  ];
  if (reply.text !== undefined) {
    events.push(
      [
        'content_block_start',
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ],
      [
        'content_block_delta',
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.text } },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    );
  }
  events.push(
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: {
          stop_reason: reply.stopReason ?? 'end_turn',
          stop_sequence: null,
          ...(reply.stopDetails ? { stop_details: reply.stopDetails } : {}),
        },
        usage: { output_tokens: reply.outputTokens ?? 50 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  );
  const body = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function anthropicError(
  status: number,
  type: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(
    status,
    { type: 'error', error: { type, message: `simulated ${type}` } },
    headers,
  );
}

// ---- OpenAI (Responses API) -------------------------------------------------

export interface OpenAiReply {
  text?: string;
  model?: string;
  status?: string;
  incompleteReason?: string;
  refusal?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

export function openAiResponse(reply: OpenAiReply = {}): Response {
  const content = reply.refusal
    ? [{ type: 'refusal', refusal: 'I cannot help with that.' }]
    : [{ type: 'output_text', text: reply.text ?? '', annotations: [] }];
  return jsonResponse(200, {
    id: 'resp_test',
    object: 'response',
    created_at: 1,
    status: reply.status ?? 'completed',
    model: reply.model ?? 'gpt-6.1-sol',
    incomplete_details: reply.incompleteReason ? { reason: reply.incompleteReason } : null,
    error: null,
    output: [{ type: 'message', id: 'msg_test', role: 'assistant', status: 'completed', content }],
    usage: {
      input_tokens: reply.inputTokens ?? 100,
      output_tokens: reply.outputTokens ?? 50,
      total_tokens: (reply.inputTokens ?? 100) + (reply.outputTokens ?? 50),
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  });
}

export function openAiError(
  status: number,
  code: string,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(
    status,
    { error: { message: `simulated ${code}`, type: code, code } },
    headers,
  );
}

// ---- Gemini (generateContent) -----------------------------------------------

export interface GeminiReply {
  text?: string;
  finishReason?: string;
  blockReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  thoughtsTokens?: number;
  modelVersion?: string;
}

export function geminiResponse(reply: GeminiReply = {}): Response {
  return jsonResponse(200, {
    ...(reply.blockReason
      ? { promptFeedback: { blockReason: reply.blockReason } }
      : {
          candidates: [
            {
              content: {
                role: 'model',
                parts: reply.text === undefined ? [] : [{ text: reply.text }],
              },
              finishReason: reply.finishReason ?? 'STOP',
            },
          ],
        }),
    usageMetadata: {
      promptTokenCount: reply.inputTokens ?? 100,
      candidatesTokenCount: reply.outputTokens ?? 50,
      thoughtsTokenCount: reply.thoughtsTokens ?? 0,
    },
    modelVersion: reply.modelVersion ?? 'gemini-3.8-flash',
  });
}

export function geminiError(status: number, message: string, grpcStatus = 'UNKNOWN'): Response {
  return jsonResponse(status, { error: { code: status, message, status: grpcStatus } });
}

// ---- A fake model that really "translates" ----------------------------------

/**
 * Read the `{"translate":[…]}` payload out of an engine prompt and answer with
 * the mock pseudo-translation, as the JSON document a real model would return.
 */
export function translateFromPrompt(userPrompt: string, targetLanguage: string): string {
  const start = userPrompt.lastIndexOf('{"translate":');
  const payload = JSON.parse(userPrompt.slice(start)) as {
    translate: { id: number; text: string }[];
  };
  const target = resolveTargetLanguage(targetLanguage);
  return JSON.stringify({
    translations: payload.translate.map((i) => ({
      id: i.id,
      text: mockTranslateText(i.text, target),
    })),
  });
}
