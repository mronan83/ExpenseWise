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
 * The requests every organization is sent, with no addition and with source lines alone, taken
 * with these inputs (Sonnet 5.5 and GPT-5.6 Luna, a three-byte JPEG): the request each provider
 * is handed, serialized. Any change to what an organization with neither addition is asked
 * shows here, and is made on purpose, with its versions: these are the requests of #92
 * (extract-v5 and receipt-v5, extract-v6 and receipt-v6), which read every line each time it
 * is printed and a credit as a line of its own, taken from the code of PR #61. Before it, from
 * PR #58 to PR #60, they were ccabc890…, 45bf80cb…, 488fe2ec… and 2a57735d…, as extract-v3 and
 * extract-v4.
 */
const BEFORE = {
  claude: {
    plain: '86a796aac41ea21553262dff45d19aa0dc4947b1a0e597499d220e4cf947d64b',
    sources: 'a8600045e55b60b17c09fac8a1c76486886d659d11ad03bc33259226ecc0114d',
  },
  openai: {
    plain: '33b85d2a18852fb36edb61c240feea55e149c878fcd81906b37c100c9530bb10',
    sources: '64e1c60e818f2793bd030917ff670766083257a69bb953c793539b3a0ef5a6d7',
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
    expect(claude.run).toMatchObject({ promptVersion: 'extract-v5', schemaVersion: 'receipt-v5' });
    // Each addition switched off adds nothing: the same bytes as with none asked.
    const off = await claudeRequest({ fieldSources: false, journeys: false });
    expect(off.sent).toBe(claude.sent);
    const openai = await openaiRequest({ fieldSources: false, journeys: false });
    expect(sha256(openai.sent)).toBe(BEFORE.openai.plain);
    expect(openai.run).toMatchObject({ promptVersion: 'extract-v5', schemaVersion: 'receipt-v5' });
    expect((await openaiRequest({})).sent).toBe(openai.sent);
    expect(claude.sent).not.toContain('rail_ticket');
    expect(openai.sent).not.toContain('journey');
  });

  it('is unchanged with only source lines asked for, still receipt-v6', async () => {
    const claude = await claudeRequest({ fieldSources: true });
    expect(sha256(claude.sent)).toBe(BEFORE.claude.sources);
    expect(claude.run).toMatchObject({ promptVersion: 'extract-v6', schemaVersion: 'receipt-v6' });
    // Journeys switched off adds nothing to it either.
    expect((await claudeRequest({ fieldSources: true, journeys: false })).sent).toBe(claude.sent);
    const openai = await openaiRequest({ fieldSources: true });
    expect(sha256(openai.sent)).toBe(BEFORE.openai.sources);
    expect(openai.run.schemaVersion).toBe('receipt-v6');
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
      promptVersion: 'extract-v5+journeys-v1',
      schemaVersion: 'receipt-v5+journeys-v1',
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
      schemaVersion: 'receipt-v5+journeys-v1',
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
      'extract-v6+journeys-v1',
      'receipt-v6+journeys-v1',
    ]);
    expect(Object.keys(both.schema.shape).slice(-3)).toEqual(['sources', 'journey', 'stay']);
    // Made once: the same options ask the same request.
    expect(variantOf({ journeys: true, fieldSources: true })).toBe(both);
    const openai = await openaiRequest({ fieldSources: true, journeys: true });
    expect(openai.run.schemaVersion).toBe('receipt-v6+journeys-v1');
    expect(openai.body.text.format.schema.properties).toHaveProperty('sources');
    expect(openai.body.text.format.schema.properties).toHaveProperty('stay');
    const claude = await claudeRequest({ fieldSources: true, journeys: true });
    expect(claude.request.system).toBe(both.system);
    expect(claude.request).not.toHaveProperty('tools');
  });
});
