import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OpenAIExtractor, ProviderHttpError, strictJsonSchema } from './openai.ts';
import {
  PROMPT_VERSION,
  SOURCES_PROMPT_VERSION,
  SOURCES_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from './prompt.ts';
import {
  ReceiptExtractionSchema,
  SCHEMA_VERSION,
  SOURCES_SCHEMA_VERSION,
  sourcesOf,
  type ReceiptExtraction,
} from './schema.ts';

const parsed: ReceiptExtraction = {
  documentType: 'receipt',
  merchant: { name: 'Bayside Grill', confidence: 'high' },
  date: null,
  currency: null,
  total: { value: '10.00', confidence: 'high' },
  subtotal: null,
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [],
};

const usage = {
  input_tokens: 3_000,
  input_tokens_details: { cached_tokens: 1_000 },
  output_tokens: 500,
};

const message = (...content: Record<string, unknown>[]) => ({
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', role: 'assistant', content },
  ],
  usage,
});

function stubFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(Response.json(body, { status }));
}

const jpeg = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' as const };
const KEY = ['sk', 'proj', 'test'].join('-');

describe('OpenAIExtractor', () => {
  it('sends the image, the strict schema and the effort, stores nothing, and prices the call', async () => {
    const fetch = stubFetch(200, message({ type: 'output_text', text: JSON.stringify(parsed) }));
    const run = await new OpenAIExtractor(KEY, 'gpt-5.6-luna', { fetch }).extract(jpeg);
    expect(run).toMatchObject({
      outcome: 'extracted',
      extraction: parsed,
      model: 'gpt-5.6-luna',
      promptVersion: PROMPT_VERSION,
      // 2,000 uncached input at 200 + 1,000 cached at 20 + 500 output at 1,200 nano-dollars.
      usage: { inputTokens: 2_000, cacheReadTokens: 1_000, outputTokens: 500 },
      costNanoUsd: 1_020_000n,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://api.openai.com/v1/responses');
    expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init?.body as string) as {
      model: string;
      instructions: string;
      store: boolean;
      reasoning: { effort: string };
      text: { format: { type: string; strict: boolean; schema: Record<string, unknown> } };
      input: { content: Record<string, string>[] }[];
    };
    expect(body).toMatchObject({
      model: 'gpt-5.6-luna',
      instructions: SYSTEM_PROMPT,
      store: false,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(body.input[0]?.content[0]).toMatchObject({ type: 'input_image', detail: 'high' });
    expect(body.input[0]?.content[0]?.image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(body.text.format.schema).not.toHaveProperty('$schema');
  });

  it('sends PDFs as files', async () => {
    const fetch = stubFetch(200, message({ type: 'output_text', text: JSON.stringify(parsed) }));
    await new OpenAIExtractor(KEY, 'gpt-5.6-luna', { fetch }).extract({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      mediaType: 'application/pdf',
    });
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {
      input: { content: Record<string, string>[] }[];
    };
    expect(body.input[0]?.content[0]).toMatchObject({
      type: 'input_file',
      filename: 'receipt.pdf',
    });
    expect(body.input[0]?.content[0]?.file_data).toMatch(/^data:application\/pdf;base64,/);
  });

  it.each([
    ['a refusal', message({ type: 'refusal', refusal: 'I cannot help with that.' }), 'refused'],
    [
      'a filtered answer',
      { status: 'incomplete', incomplete_details: { reason: 'content_filter' }, output: [], usage },
      'refused',
    ],
    [
      'an answer cut off at the token limit',
      {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
        usage,
      },
      'truncated',
    ],
    ['text that is not JSON', message({ type: 'output_text', text: 'Sorry' }), 'invalid'],
    [
      'JSON that is not a receipt',
      message({ type: 'output_text', text: '{"merchant":"x"}' }),
      'invalid',
    ],
  ])('reports %s as %s with no extraction', async (_case, body, outcome) => {
    const fetch = stubFetch(200, body);
    const run = await new OpenAIExtractor(KEY, 'gpt-5.6-luna', { fetch }).extract(jpeg);
    expect(run.outcome).toBe(outcome);
    expect(run.extraction).toBeNull();
  });

  it("throws the provider's status, message and code, without the key", async () => {
    const fetch = stubFetch(429, {
      error: {
        message: `You exceeded your current quota for ${KEY}.`,
        type: 'insufficient_quota',
        code: 'insufficient_quota',
      },
    });
    const error = await new OpenAIExtractor(KEY, 'gpt-5.6-luna', { fetch })
      .extract(jpeg)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({
      status: 429,
      code: 'insufficient_quota',
      providerMessage: 'You exceeded your current quota for [key].',
    });
    expect(String((error as Error).message)).not.toContain(KEY);
  });
});

describe('strictJsonSchema', () => {
  it('closes every object, requires every property and drops $schema', () => {
    const schema = strictJsonSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        merchant: {
          anyOf: [{ type: 'object', properties: { name: { type: 'string' } } }, { type: 'null' }],
        },
        // A property named like a keyword is still a property.
        properties: { type: 'array', items: { type: 'object', properties: { a: {} } } },
      },
      required: ['merchant'],
    });
    expect(schema).toEqual({
      type: 'object',
      properties: {
        merchant: {
          anyOf: [
            {
              type: 'object',
              properties: { name: { type: 'string' } },
              additionalProperties: false,
              required: ['name'],
            },
            { type: 'null' },
          ],
        },
        properties: {
          type: 'array',
          items: {
            type: 'object',
            properties: { a: {} },
            additionalProperties: false,
            required: ['a'],
          },
        },
      },
      required: ['merchant', 'properties'],
      additionalProperties: false,
    });
  });

  it('asks for source lines in strict mode only when told to, and keeps them', async () => {
    const sources = {
      merchant: 'BAYSIDE GRILL',
      date: null,
      time: null,
      address: null,
      currency: null,
      total: 'TOTAL 10.00',
      subtotal: null,
      taxes: null,
      tip: null,
      fees: null,
      cardLastFour: null,
    };
    const answer = { ...parsed, sources };
    const fetch = stubFetch(200, message({ type: 'output_text', text: JSON.stringify(answer) }));
    const run = await new OpenAIExtractor(KEY, 'gpt-5.6-luna', {
      fetch,
      fieldSources: true,
    }).extract(jpeg);
    expect(run).toMatchObject({
      outcome: 'extracted',
      promptVersion: SOURCES_PROMPT_VERSION,
      schemaVersion: SOURCES_SCHEMA_VERSION,
    });
    expect(sourcesOf(run.extraction)).toEqual(sources);
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {
      instructions: string;
      tools?: unknown;
      text: { format: { schema: { properties: Record<string, { required?: string[] }> } } };
    };
    expect(body.instructions).toBe(SOURCES_SYSTEM_PROMPT);
    expect(body.text.format.schema.properties.sources?.required).toContain('total');
    expect(body).not.toHaveProperty('tools');
  });

  it('sends the receipt-v3 prompt and schema unchanged when source lines are not asked for', async () => {
    const fetch = stubFetch(200, message({ type: 'output_text', text: JSON.stringify(parsed) }));
    const run = await new OpenAIExtractor(KEY, 'gpt-5.6-luna', { fetch }).extract(jpeg);
    expect(run).toMatchObject({ promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION });
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {
      instructions: string;
      text: { format: { schema: unknown } };
    };
    expect(body.instructions).toBe(SYSTEM_PROMPT);
    expect(body.text.format.schema).toEqual(
      strictJsonSchema(z.toJSONSchema(ReceiptExtractionSchema)),
    );
  });
});
