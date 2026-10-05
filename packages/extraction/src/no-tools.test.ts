import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeExtractor } from './claude.ts';
import type { ExtractionInput } from './extractor.ts';
import { MODELS, type ClaudeModelId, type ModelId, type OpenAIModelId } from './models.ts';
import { OpenAIExtractor } from './openai.ts';
import type { ExtractorOptions } from './variant.ts';

/**
 * Receipts are untrusted input (NFR-SEC-07, GAP-15): a model that reads one is given no tools,
 * so nothing printed on a receipt can make it act, only be read. These tests hold every request
 * a reader can build to that, as it leaves for the provider, so adding a tool fails CI.
 */

/**
 * Every addition a request can be built with. `Required` makes a new option fail to typecheck
 * here until it is added, so each new kind of request is checked too.
 */
const EVERY_ADDITION = {
  fieldSources: true,
  journeys: true,
} as const satisfies Required<ExtractorOptions>;

/** Each addition on, off and left out, in every combination. */
const ALL_OPTIONS: ExtractorOptions[] = (
  Object.keys(EVERY_ADDITION) as (keyof ExtractorOptions)[]
).reduce<ExtractorOptions[]>(
  (combos, key) => combos.flatMap((c) => [c, { ...c, [key]: false }, { ...c, [key]: true }]),
  [{}],
);

const INPUTS: readonly ExtractionInput[] = [
  { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' },
  { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mediaType: 'application/pdf' },
];

const ids = (Object.keys(MODELS) as ModelId[]).sort();
const CLAUDE = ids.filter((id): id is ClaudeModelId => MODELS[id].provider === 'anthropic');
const OPENAI = ids.filter((id): id is OpenAIModelId => MODELS[id].provider === 'openai');

/** Anything in a request by which a model could be offered something to call or run. */
const TOOL_KEYS =
  /^(tools|tool_choice|tool_config|tool_resources|functions|function_call|parallel_tool_calls|mcp_servers|container)$/;
const TOOL_TYPES = /tool|function|mcp|computer|bash|text_editor|web_search|web_fetch|code_/;

/** Every key, and every block type, anywhere in a request, with where it was found. */
function toolsIn(node: unknown, path = '$'): string[] {
  if (Array.isArray(node)) return node.flatMap((v, i) => toolsIn(v, `${path}[${i}]`));
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([key, value]) => [
    ...(TOOL_KEYS.test(key) ? [`${path}.${key}`] : []),
    ...(key === 'type' && typeof value === 'string' && TOOL_TYPES.test(value)
      ? [`${path}.type = ${value}`]
      : []),
    ...toolsIn(value, `${path}.${key}`),
  ]);
}

const urlOf = (url: string | URL | Request) =>
  typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

/**
 * The body Anthropic would receive, from the real client: the request after the SDK has made
 * it, not only what the extractor passed in.
 */
async function claudeBody(model: ClaudeModelId, options: ExtractorOptions, input: ExtractionInput) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
  const client = new Anthropic({
    apiKey: ['sk', 'ant', 'test'].join('-'),
    authToken: null,
    credentials: null,
    maxRetries: 0,
    fetch,
  });
  await new ClaudeExtractor(client, model, options).extract(input);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  return { url: urlOf(url), body: JSON.parse(init?.body as string) as Record<string, unknown> };
}

/** The body OpenAI would receive. */
async function openaiBody(model: OpenAIModelId, options: ExtractorOptions, input: ExtractionInput) {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValue(Response.json({ status: 'completed', output: [], usage: {} }));
  await new OpenAIExtractor(['sk', 'proj', 'test'].join('-'), model, {
    fetch,
    ...options,
  }).extract(input);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  return { url: urlOf(url), body: JSON.parse(init?.body as string) as Record<string, unknown> };
}

const cases = <M extends ModelId>(models: readonly M[]) =>
  models.flatMap((model) =>
    ALL_OPTIONS.flatMap((options) =>
      INPUTS.map(
        (input) => [model, JSON.stringify(options), input.mediaType, options, input] as const,
      ),
    ),
  );

describe('a request to read a receipt (NFR-SEC-07)', () => {
  it('is built for every addition, on, off and left out', () => {
    expect(ALL_OPTIONS).toHaveLength(9);
    expect(ALL_OPTIONS).toContainEqual({ fieldSources: true, journeys: true });
    expect(ALL_OPTIONS).toContainEqual({});
    expect(CLAUDE.length).toBeGreaterThan(0);
    expect(OPENAI.length).toBeGreaterThan(0);
  });

  it.each(cases(CLAUDE))(
    'offers Claude no tools: %s with %s, a %s',
    async (model, _label, _type, options, input) => {
      const { url, body } = await claudeBody(model, options, input);
      expect(url).toMatch(/\/v1\/messages$/);
      expect(toolsIn(body)).toEqual([]);
      expect(
        Object.keys(body).filter(
          (k) => !['model', 'max_tokens', 'system', 'messages', 'output_config'].includes(k),
        ),
      ).toEqual([]);
      // One turn, the person's: the document and the ask, and no tool's result.
      const messages = body.messages as { role: string; content: { type: string }[] }[];
      expect(messages.map((m) => m.role)).toEqual(['user']);
      expect(messages[0]!.content.map((c) => c.type)).toEqual([
        input.mediaType === 'application/pdf' ? 'document' : 'image',
        'text',
      ]);
    },
  );

  it.each(cases(OPENAI))(
    'offers OpenAI no tools: %s with %s, a %s',
    async (model, _label, _type, options, input) => {
      const { url, body } = await openaiBody(model, options, input);
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(toolsIn(body)).toEqual([]);
      expect(
        Object.keys(body).filter(
          (k) =>
            ![
              'model',
              'instructions',
              'input',
              'text',
              'reasoning',
              'max_output_tokens',
              'store',
            ].includes(k),
        ),
      ).toEqual([]);
      const turns = body.input as { role: string; content: { type: string }[] }[];
      expect(turns.map((m) => m.role)).toEqual(['user']);
      expect(turns[0]!.content.map((c) => c.type)).toEqual([
        input.mediaType === 'application/pdf' ? 'input_file' : 'input_image',
        'input_text',
      ]);
      // The answer can only be data in our schema.
      expect(body.text).toMatchObject({ format: { type: 'json_schema', strict: true } });
    },
  );

  it('finds a tool wherever one is added, so the checks above can fail', () => {
    expect(toolsIn({ model: 'm', tools: [] })).toEqual(['$.tools']);
    expect(toolsIn({ tool_choice: { type: 'auto' } })).toEqual(['$.tool_choice']);
    expect(toolsIn({ functions: [{ name: 'f' }], function_call: 'auto' })).toEqual([
      '$.functions',
      '$.function_call',
    ]);
    expect(toolsIn({ mcp_servers: [] })).toEqual(['$.mcp_servers']);
    expect(
      toolsIn({ messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] }),
    ).toEqual(['$.messages[0].content[0].type = tool_result']);
    expect(toolsIn({ input: [{ type: 'function_call_output' }] })).toEqual([
      '$.input[0].type = function_call_output',
    ]);
    expect(toolsIn({ text: { format: { type: 'json_schema' } } })).toEqual([]);
  });
});
