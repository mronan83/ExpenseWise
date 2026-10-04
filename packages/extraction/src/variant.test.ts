import type Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ClaudeExtractor } from './claude.ts';
import { OpenAIExtractor, strictJsonSchema } from './openai.ts';
import {
  JOURNEYS_INSTRUCTIONS,
  SOURCES_INSTRUCTIONS,
  SOURCES_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from './prompt.ts';
import { JOURNEY_DOCUMENT_TYPES, type ReceiptExtraction } from './schema.ts';
import { EXTRACTION_VARIANTS, variantOf, type ExtractorOptions } from './variant.ts';

const jpeg = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' as const };
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * The requests as they were sent before journeys and stays could be asked for, taken from the
 * code of PR #58 with these inputs (Sonnet 5.5 and GPT-5.6 Luna, a three-byte JPEG): the
 * request each provider is handed, serialized. Any change to what an organization with
 * neither addition is asked shows here.
 */
const BEFORE = {
  claude: {
    plain: 'ccabc890fff6444bd6496f370c5b2a3ad600f635721b2b95e1318eee7f747d9b',
    sources: '45bf80cbdb5059a9dd35fadd2e2b7caa51207ad38e5932f993b56db7d7625529',
  },
  openai: {
    plain: '488fe2ec3b8ea274b4c29ded45272c95f0fc45d1e0fa9ed446d1880db8a7631f',
    sources: '2a57735de8df4d22f0c70b1751994ee21722318ab2c005b92362f50ad0b0a0a1',
  },
};

async function claudeRequest(options: ExtractorOptions, answer: unknown = null) {
  const parse = vi.fn().mockResolvedValue({
    usage: { input_tokens: 1, output_tokens: 1 },
    stop_reason: 'end_turn',
    parsed_output: answer,
  });
  const client = { messages: { parse } } as unknown as Anthropic;
  const run = await new ClaudeExtractor(client, 'claude-sonnet-5-5', options).extract(jpeg);
  const request = parse.mock.calls[0]?.[0] as {
    system: string;
    output_config: { format: { schema: Record<string, unknown> } };
  };
  return { run, request, sent: JSON.stringify(request) };
}

async function openaiRequest(options: ExtractorOptions, answer?: unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
    Response.json({
      status: 'completed',
      output: answer
        ? [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }]
        : [],
      usage: {},
    }),
  );
  const run = await new OpenAIExtractor('sk-test', 'gpt-5.6-luna', { fetch, ...options }).extract(
    jpeg,
  );
  const sent = fetch.mock.calls[0]?.[1]?.body as string;
  const body = JSON.parse(sent) as {
    instructions: string;
    text: { format: { schema: { properties: Record<string, unknown> } } };
  };
  return { run, body, sent };
}

const ride: ReceiptExtraction = {
  documentType: 'ride_receipt',
  merchant: { name: 'Lyft', confidence: 'high' },
  date: { value: '2026-09-30', confidence: 'high' },
  currency: { code: 'USD', confidence: 'high' },
  total: { value: '24.60', confidence: 'high' },
  subtotal: null,
  fees: [],
  taxes: [],
  tip: null,
  cardLastFour: null,
  time: null,
  address: null,
  lineItems: [],
  journey: {
    from: { value: 'Hilton Omaha', confidence: 'high' },
    to: { value: '1520 Harney St', confidence: 'high' },
  },
  stay: null,
};

describe('a request with neither addition', () => {
  it('is byte for byte the request sent before, to Claude and to OpenAI', async () => {
    const claude = await claudeRequest({});
    expect(sha256(claude.sent)).toBe(BEFORE.claude.plain);
    expect(claude.run).toMatchObject({ promptVersion: 'extract-v3', schemaVersion: 'receipt-v3' });
    const openai = await openaiRequest({ fieldSources: false, journeys: false });
    expect(sha256(openai.sent)).toBe(BEFORE.openai.plain);
    expect(openai.run).toMatchObject({ promptVersion: 'extract-v3', schemaVersion: 'receipt-v3' });
    expect(claude.sent).not.toContain('rail_ticket');
    expect(openai.sent).not.toContain('journey');
  });

  it('is unchanged with only source lines asked for, still receipt-v4', async () => {
    const claude = await claudeRequest({ fieldSources: true });
    expect(sha256(claude.sent)).toBe(BEFORE.claude.sources);
    expect(claude.run).toMatchObject({ promptVersion: 'extract-v4', schemaVersion: 'receipt-v4' });
    const openai = await openaiRequest({ fieldSources: true });
    expect(sha256(openai.sent)).toBe(BEFORE.openai.sources);
    expect(openai.run.schemaVersion).toBe('receipt-v4');
  });
});

describe('journeys and stays, asked for (FR-INT-20, FR-INT-21)', () => {
  it('add their instructions and structure, and their version to the base’s', async () => {
    const claude = await claudeRequest({ journeys: true }, ride);
    expect(claude.request.system).toBe(`${SYSTEM_PROMPT}\n${JOURNEYS_INSTRUCTIONS}`);
    expect(claude.request.output_config.format.schema).toEqual(
      zodOutputFormat(variantOf({ journeys: true }).schema).schema,
    );
    expect(claude.run).toMatchObject({
      outcome: 'extracted',
      extraction: ride,
      promptVersion: 'extract-v3+journeys-v1',
      schemaVersion: 'receipt-v3+journeys-v1',
    });
    const openai = await openaiRequest({ journeys: true }, ride);
    expect(openai.body.instructions).toBe(`${SYSTEM_PROMPT}\n${JOURNEYS_INSTRUCTIONS}`);
    expect(Object.keys(openai.body.text.format.schema.properties)).toEqual([
      ...Object.keys(EXTRACTION_VARIANTS.plain.schema.shape),
      'journey',
      'stay',
    ]);
    expect(openai.body.text.format.schema).toEqual(
      strictJsonSchema(z.toJSONSchema(variantOf({ journeys: true }).schema)),
    );
    expect(openai.run).toMatchObject({
      outcome: 'extracted',
      extraction: ride,
      schemaVersion: 'receipt-v3+journeys-v1',
    });
  });

  it('offer a rail ticket as a kind of document only where they are asked for', () => {
    const asked = variantOf({ journeys: true }).schema.shape.documentType as z.ZodEnum;
    expect(asked.options).toEqual([...JOURNEY_DOCUMENT_TYPES]);
    expect(asked.options).toContain('rail_ticket');
    const plain = EXTRACTION_VARIANTS.plain.schema.shape.documentType;
    expect(plain.options).not.toContain('rail_ticket');
    // The kind of document keeps its place, first.
    expect(Object.keys(variantOf({ journeys: true }).schema.shape)[0]).toBe('documentType');
  });

  it('compose with source lines, each addition independent of the other', async () => {
    const both = variantOf({ fieldSources: true, journeys: true });
    expect(both.system).toBe(`${SOURCES_SYSTEM_PROMPT}\n${JOURNEYS_INSTRUCTIONS}`);
    expect(both.system).toBe(`${SYSTEM_PROMPT}\n${SOURCES_INSTRUCTIONS}\n${JOURNEYS_INSTRUCTIONS}`);
    expect([both.promptVersion, both.schemaVersion]).toEqual([
      'extract-v4+journeys-v1',
      'receipt-v4+journeys-v1',
    ]);
    expect(Object.keys(both.schema.shape).slice(-3)).toEqual(['sources', 'journey', 'stay']);
    // Made once: the same options ask the same request.
    expect(variantOf({ journeys: true, fieldSources: true })).toBe(both);
    const openai = await openaiRequest({ fieldSources: true, journeys: true });
    expect(openai.run.schemaVersion).toBe('receipt-v4+journeys-v1');
    expect(openai.body.text.format.schema.properties).toHaveProperty('sources');
    expect(openai.body.text.format.schema.properties).toHaveProperty('stay');
    const claude = await claudeRequest({ fieldSources: true, journeys: true });
    expect(claude.request.system).toBe(both.system);
    expect(claude.request).not.toHaveProperty('tools');
  });
});
