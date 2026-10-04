import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeExtractor } from './claude.ts';
import { PROMPT_VERSION } from './prompt.ts';
import type { ReceiptExtraction } from './schema.ts';

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

function stubClient(response: Record<string, unknown>) {
  const parse = vi.fn().mockResolvedValue({
    usage: { input_tokens: 2_000, output_tokens: 500 },
    ...response,
  });
  return { client: { messages: { parse } } as unknown as Anthropic, parse };
}

const jpeg = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' as const };

describe('ClaudeExtractor', () => {
  it('sends the image, the schema and the tier effort, and prices the call', async () => {
    const { client, parse } = stubClient({ stop_reason: 'end_turn', parsed_output: parsed });
    const run = await new ClaudeExtractor(client, 'claude-opus-5-5').extract(jpeg);
    expect(run).toMatchObject({
      outcome: 'extracted',
      extraction: parsed,
      model: 'claude-opus-5-5',
      promptVersion: PROMPT_VERSION,
      costNanoUsd: 18_000_000n,
    });
    const request = parse.mock.calls[0]?.[0] as {
      model: string;
      output_config: { effort?: string; format: unknown };
      messages: { content: { type: string; source?: { media_type: string } }[] }[];
    };
    expect(request.model).toBe('claude-opus-5-5');
    expect(request.output_config.effort).toBe('low');
    expect(request.output_config.format).toBeDefined();
    expect(request.messages[0]?.content[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/jpeg' },
    });
  });

  it('sends PDFs as documents and omits effort for Haiku', async () => {
    const { client, parse } = stubClient({ stop_reason: 'end_turn', parsed_output: parsed });
    await new ClaudeExtractor(client, 'claude-haiku-4-5').extract({
      bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      mediaType: 'application/pdf',
    });
    const request = parse.mock.calls[0]?.[0] as {
      output_config: Record<string, unknown>;
      messages: { content: { type: string }[] }[];
    };
    expect(request.output_config).not.toHaveProperty('effort');
    expect(request.messages[0]?.content[0]?.type).toBe('document');
  });

  it.each([
    [{ stop_reason: 'refusal', parsed_output: null }, 'refused'],
    [{ stop_reason: 'max_tokens', parsed_output: null }, 'truncated'],
    [{ stop_reason: 'end_turn', parsed_output: null }, 'invalid'],
  ])('reports %o as %s with no extraction', async (response, outcome) => {
    const { client } = stubClient(response);
    const run = await new ClaudeExtractor(client, 'claude-sonnet-5-5').extract(jpeg);
    expect(run.outcome).toBe(outcome);
    expect(run.extraction).toBeNull();
  });
});
