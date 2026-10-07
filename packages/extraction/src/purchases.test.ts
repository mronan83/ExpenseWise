import type Anthropic from '@anthropic-ai/sdk';
import { checkLines, claimWithout, money } from '@expensewise/domain';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { readingChecks } from './checks.ts';
import { ClaudeExtractor } from './claude.ts';
import { itemizationOf } from './lines.ts';
import { normalizeExtraction } from './normalize.ts';
import { OpenAIExtractor, strictJsonSchema } from './openai.ts';
import {
  JOURNEYS_INSTRUCTIONS,
  PURCHASES_INSTRUCTIONS,
  SOURCES_INSTRUCTIONS,
  SYSTEM_PROMPT,
} from './prompt.ts';
import type { ReceiptExtraction } from './schema.ts';
import { EXTRACTION_VARIANTS, variantOf } from './variant.ts';

/*
 * Several purchases on one receipt (FR-INT-23, Q49, `receipts.purchases`): an airline receipt
 * that holds the ticket, bought Sep 12 on one card, and a seat upgrade bought Sep 30 on
 * another, each with its own taxes and fees.
 */

const high = <T extends object>(field: T) => ({ ...field, confidence: 'high' as const });
const usd = (cents: number) => money(cents, 'USD');

const airfare: ReceiptExtraction = {
  documentType: 'airline_ticket',
  merchant: high({ name: 'Example Air' }),
  // As the document prints it: the day of its last purchase, and that one's card.
  date: high({ value: '2026-09-30' }),
  currency: high({ code: 'USD' }),
  total: high({ value: '487.13' }),
  subtotal: null,
  taxes: [
    high({ label: 'US transportation tax', value: '27.00', purchase: 1 }),
    high({ label: 'US transportation tax', value: '5.93', purchase: 2 }),
  ],
  fees: [
    high({ label: 'September 11 security fee', value: '5.60', purchase: 1 }),
    high({ label: 'Passenger facility charge', value: '9.60', purchase: 1 }),
  ],
  tip: null,
  cardLastFour: high({ value: '9921' }),
  time: null,
  address: null,
  lineItems: [
    { description: 'Airfare', quantity: null, amount: '360.00', purchase: 1 },
    { description: 'Economy Plus', quantity: null, amount: '79.00', purchase: 2 },
  ],
  purchases: [
    {
      description: 'Ticket',
      date: high({ value: '2026-09-12' }),
      cardLastFour: high({ value: '4417' }),
      total: high({ value: '402.20' }),
    },
    {
      description: 'Seat upgrade',
      date: high({ value: '2026-09-30' }),
      cardLastFour: high({ value: '9921' }),
      total: high({ value: '84.93' }),
    },
  ],
};

const jpeg = { bytes: new Uint8Array([0xff, 0xd8, 0xff]), mediaType: 'image/jpeg' as const };

describe('asking for several purchases (FR-INT-23, purchases-v1)', () => {
  it('adds its instructions and structure, and its version to the base’s', async () => {
    const asked = variantOf({ purchases: true });
    expect(asked.system).toBe(`${SYSTEM_PROMPT}\n${PURCHASES_INSTRUCTIONS}`);
    expect([asked.promptVersion, asked.schemaVersion]).toEqual([
      'extract-v5+purchases-v1',
      'receipt-v5+purchases-v1',
    ]);
    // The lines, taxes and fees keep their places, each naming its purchase; purchases come last.
    expect(Object.keys(asked.schema.shape)).toEqual([
      ...Object.keys(EXTRACTION_VARIANTS.plain.schema.shape),
      'purchases',
    ]);

    const parse = vi.fn().mockResolvedValue({
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: 'end_turn',
      parsed_output: airfare,
    });
    const client = { messages: { parse } } as unknown as Anthropic;
    const claude = await new ClaudeExtractor(client, 'claude-sonnet-5-5', {
      purchases: true,
    }).extract(jpeg);
    expect(claude).toMatchObject({
      outcome: 'extracted',
      extraction: airfare,
      promptVersion: 'extract-v5+purchases-v1',
      schemaVersion: 'receipt-v5+purchases-v1',
    });

    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status: 'completed',
        output: [
          { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(airfare) }] },
        ],
        usage: {},
      }),
    );
    const openai = await new OpenAIExtractor('sk-test', 'gpt-5.6-luna', {
      fetch,
      purchases: true,
    }).extract(jpeg);
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as {
      text: { format: { schema: unknown } };
    };
    expect(body.text.format.schema).toEqual(strictJsonSchema(z.toJSONSchema(asked.schema)));
    expect(openai).toMatchObject({ outcome: 'extracted', extraction: airfare });
  });

  it('composes with source lines and journeys, each addition independent', () => {
    const all = variantOf({ fieldSources: true, journeys: true, purchases: true });
    expect(all.system).toBe(
      `${SYSTEM_PROMPT}\n${SOURCES_INSTRUCTIONS}\n${JOURNEYS_INSTRUCTIONS}\n${PURCHASES_INSTRUCTIONS}`,
    );
    expect([all.promptVersion, all.schemaVersion]).toEqual([
      'extract-v6+journeys-v2+purchases-v1',
      'receipt-v6+journeys-v2+purchases-v1',
    ]);
    expect(Object.keys(all.schema.shape).slice(-4)).toEqual([
      'sources',
      'journey',
      'stay',
      'purchases',
    ]);
    expect(variantOf({ purchases: true, journeys: true, fieldSources: true })).toBe(all);
  });
});

describe('a reading of several purchases (FR-INT-23, Q49)', () => {
  it('keeps each purchase’s lines together, each naming it, with its date, card and total', () => {
    const lines = itemizationOf(airfare)!;
    expect(lines.purchases).toEqual([
      { description: 'Ticket', date: '2026-09-12', cardLastFour: '4417', total: usd(40_220) },
      { description: 'Seat upgrade', date: '2026-09-30', cardLastFour: '9921', total: usd(8493) },
    ]);
    expect(lines.lines.map((l) => [l.purchase, l.kind, l.description])).toEqual([
      [1, 'item', 'Airfare'],
      [1, 'tax', 'US transportation tax'],
      [1, 'fee', 'September 11 security fee'],
      [1, 'fee', 'Passenger facility charge'],
      [2, 'item', 'Economy Plus'],
      [2, 'tax', 'US transportation tax'],
    ]);
    expect(checkLines(lines).addsUp).toBe(true);
    // Leaving the upgrade out takes off it and its own tax, never a share of the ticket's.
    expect(claimWithout(lines, new Set([5]))).toMatchObject({
      ok: true,
      value: { excluded: usd(8493), claimed: usd(40_220) },
    });
  });

  it('dates and cards the expense as the first purchase, the one the receipt is for', () => {
    const n = normalizeExtraction(airfare);
    expect(n.date).toEqual(high({ value: '2026-09-12' }));
    expect(n.cardLastFour).toEqual(high({ value: '4417' }));
    expect(n.purchases).toEqual({ count: 2, addUp: true });
    expect(readingChecks(n, new Date('2026-10-06T12:00:00Z'))).toEqual([]);
  });

  it('holds a reading for a look when a purchase’s taxes are read into another', () => {
    const mixed: ReceiptExtraction = {
      ...airfare,
      taxes: airfare.taxes.map((t) => ({ ...t, purchase: 1 })),
    };
    const lines = itemizationOf(mixed)!;
    expect(checkLines(lines)).toMatchObject({ addsUp: false, problem: 'purchase', purchase: 1 });
    const n = normalizeExtraction(mixed);
    expect(n.purchases).toEqual({ count: 2, addUp: false });
    expect(readingChecks(n, new Date('2026-10-06T12:00:00Z'))).toEqual(['sums']);
  });

  it('holds it too when the purchases don’t come to the receipt’s total', () => {
    const n = normalizeExtraction({ ...airfare, total: high({ value: '402.20' }) });
    expect(readingChecks(n, new Date('2026-10-06T12:00:00Z'))).toEqual(['sums']);
  });

  it('reads a receipt that lists one purchase, or none, exactly as before', () => {
    const plain: ReceiptExtraction = {
      ...airfare,
      total: high({ value: '402.20' }),
      date: high({ value: '2026-09-12' }),
      cardLastFour: high({ value: '4417' }),
      taxes: [airfare.taxes[0]!],
      lineItems: [airfare.lineItems[0]!],
    };
    const one = { ...plain, purchases: [airfare.purchases![0]!] };
    const none = { ...plain, purchases: [] };
    const { purchases: _, ...unasked } = plain;
    for (const reading of [one, none]) {
      expect(itemizationOf(reading)).toEqual(itemizationOf(unasked));
      expect(normalizeExtraction(reading)).toEqual(normalizeExtraction(unasked));
    }
    expect(itemizationOf(unasked)?.purchases).toBeUndefined();
    expect(itemizationOf(unasked)?.lines.every((l) => l.purchase === undefined)).toBe(true);
  });
});
