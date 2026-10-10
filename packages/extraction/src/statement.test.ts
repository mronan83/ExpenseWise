import type Anthropic from '@anthropic-ai/sdk';
import { APIConnectionTimeoutError } from '@anthropic-ai/sdk';
import { money } from '@expensewise/domain';
import { describe, expect, it, vi } from 'vitest';
import { ProviderHttpError } from './openai.ts';
import {
  ClaudeStatementReader,
  normalizeStatement,
  OpenAIStatementReader,
  STATEMENT_PROMPT,
  type StatementExtraction,
} from './statement.ts';
import {
  csvRows,
  listAmount,
  listDate,
  readStatementList,
  STATEMENT_ROWS_MAX,
} from './statement-list.ts';

const usd = (cents: number) => money(cents, 'USD');
const KEY = ['sk', 'proj', 'test'].join('-');

/** A U.S. Bank corporate card statement for September, as Claude would read it. */
const september: StatementExtraction = {
  cardStatement: true,
  issuer: 'U.S. Bank',
  cardLastFour: 'XXXX-XXXX-XXXX-4417',
  periodStart: '2026-08-29',
  periodEnd: '2026-09-28',
  currency: 'USD',
  charges: '420.60',
  credits: '25.00',
  transactions: [
    {
      transactionDate: '2026-09-12',
      postedDate: '2026-09-14',
      description: 'DELTA AIR 0062345678901 ATLANTA GA',
      amount: '402.20',
      reference: '24692166255100012345678',
      cardLastFour: null,
    },
    {
      transactionDate: '2026-09-27',
      postedDate: null,
      description: 'LYFT *RIDE SUN 8AM',
      amount: '18.40',
      reference: null,
      cardLastFour: '4417',
    },
    {
      transactionDate: '2026-09-20',
      postedDate: null,
      description: 'DELTA AIR CREDIT',
      amount: '-25.00',
      reference: null,
      cardLastFour: null,
    },
  ],
};

describe('reading a card statement (FR-CAP-10, statement-v1)', () => {
  it('turns what was read into minor units, the card’s last four digits on each transaction', () => {
    const read = normalizeStatement(september, 'USD');
    expect(read).toMatchObject({
      currency: 'USD',
      cardLastFour: '4417',
      periodStart: '2026-08-29',
      periodEnd: '2026-09-28',
      charges: usd(42_060),
      credits: usd(2500),
      problems: [],
    });
    expect(
      read.transactions.map((t) => [t.transactionDate, t.amount.amountMinor, t.cardLastFour]),
    ).toEqual([
      ['2026-09-12', 40_220, '4417'],
      ['2026-09-27', 1840, '4417'],
      ['2026-09-20', -2500, '4417'],
    ]);
  });

  it('leaves out a line whose date or amount doesn’t read, and names it, rather than guess', () => {
    const read = normalizeStatement(
      {
        ...september,
        currency: null,
        transactions: [
          { ...september.transactions[0]!, amount: '402.205' },
          { ...september.transactions[1]!, transactionDate: '09/27' },
          september.transactions[2]!,
        ],
      },
      'USD',
    );
    expect(read.transactions).toHaveLength(1);
    expect(read.problems).toEqual(['transactions[0].amount', 'transactions[1].transactionDate']);
  });

  it('asks Claude with its own instructions and structure, and offers no tools', async () => {
    const parse = vi.fn().mockResolvedValue({
      usage: { input_tokens: 12_000, output_tokens: 900 },
      stop_reason: 'end_turn',
      parsed_output: september,
    });
    const client = { messages: { parse } } as unknown as Anthropic;
    const run = await new ClaudeStatementReader(client, 'claude-sonnet-5-5').read(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
    expect(run).toMatchObject({
      outcome: 'extracted',
      statement: september,
      version: 'statement-v1',
    });
    const request = parse.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request.system).toBe(STATEMENT_PROMPT);
    expect(request).not.toHaveProperty('tools');
    expect(request).not.toHaveProperty('tool_choice');
    expect(JSON.stringify(request)).toContain('application/pdf');
    expect(run.costNanoUsd).toBe(12_000n * 2_000n + 900n * 10_000n);
  });

  it('says a statement timed out rather than throw, so it isn’t paid for again', async () => {
    const parse = vi.fn().mockRejectedValue(new APIConnectionTimeoutError());
    const client = { messages: { parse } } as unknown as Anthropic;
    const run = await new ClaudeStatementReader(client, 'claude-sonnet-5-5').read(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
    expect(run).toMatchObject({ outcome: 'timed_out', statement: null });
    // Anything else is thrown, for the step to try again.
    parse.mockRejectedValue(new Error('Overloaded'));
    await expect(
      new ClaudeStatementReader(client, 'claude-sonnet-5-5').read(new Uint8Array([0x25])),
    ).rejects.toThrow('Overloaded');
  });

  it('asks an OpenAI model with the same instructions and structure, offers no tools and stores nothing', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status: 'completed',
        output: [
          {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify(september) }],
          },
        ],
        usage: { input_tokens: 12_000, output_tokens: 900 },
      }),
    );
    const run = await new OpenAIStatementReader(KEY, 'gpt-5.6-luna', { fetch }).read(
      new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    );
    expect(run).toMatchObject({
      outcome: 'extracted',
      statement: september,
      model: 'gpt-5.6-luna',
      version: 'statement-v1',
    });
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(body.instructions).toBe(STATEMENT_PROMPT);
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty('tools');
    expect(JSON.stringify(body.input)).toContain('data:application/pdf;base64,');
    expect(run.costNanoUsd).toBeGreaterThan(0n);
  });

  it('throws what OpenAI answered when it refuses for good, such as no credit, without the key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          error: {
            message: `You exceeded your current quota (key ${KEY}).`,
            code: 'insufficient_quota',
          },
        },
        { status: 429 },
      ),
    );
    const error = await new OpenAIStatementReader(KEY, 'gpt-5.6-luna', { fetch })
      .read(new Uint8Array([0x25]))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderHttpError);
    expect(error).toMatchObject({ status: 429, code: 'insufficient_quota' });
    expect((error as ProviderHttpError).providerMessage).not.toContain(KEY);
  });
});

describe('a downloaded transaction list, read with no model (US-CAP-07 AC6)', () => {
  it('reads quoted CSV fields, commas and quotes inside them', () => {
    expect(csvRows('a,"b, c","d ""e"""\r\n\r\n1,2,3\n')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['1', '2', '3'],
    ]);
  });

  it('reads a date and an amount however a bank prints them', () => {
    expect(['09/30/2026', '9/3/26', '2026-09-30', '31/02/2026'].map(listDate)).toEqual([
      '2026-09-30',
      '2026-09-03',
      '2026-09-30',
      null,
    ]);
    expect(['$1,234.56', '-12.34', '(12.34)', '12.34 CR', 'n/a'].map(listAmount)).toEqual([
      '1234.56',
      '-12.34',
      '-12.34',
      '-12.34',
      null,
    ]);
  });

  it('finds the columns by their names, after any lines above the header', () => {
    const list = [
      'Account: XXXX4417,,,,',
      'Transaction Date,Posting Date,Merchant Name,Amount,Card Number',
      '09/12/2026,09/14/2026,"DELTA AIR 0062345678901 ATLANTA GA",402.20,XXXXXXXXXXXX4417',
      '09/27/2026,09/28/2026,LYFT *RIDE SUN 8AM,18.40,XXXXXXXXXXXX4417',
      '09/20/2026,09/21/2026,DELTA AIR CREDIT,-25.00,XXXXXXXXXXXX4417',
      '09/25/2026,09/25/2026,PAYMENT - THANK YOU,-1000.00,XXXXXXXXXXXX4417',
      'not a date,,BAD ROW,1.00,',
    ].join('\n');
    const read = readStatementList(list, 'USD');
    if (!read.ok) throw new Error(read.problem);
    expect(read.skipped).toBe(2);
    expect(
      read.transactions.map((t) => [
        t.transactionDate,
        t.postedOn,
        t.merchant,
        t.amount.amountMinor,
        t.cardLastFour,
      ]),
    ).toEqual([
      ['2026-09-12', '2026-09-14', 'DELTA AIR 0062345678901 ATLANTA GA', 40_220, '4417'],
      ['2026-09-27', '2026-09-28', 'LYFT *RIDE SUN 8AM', 1840, '4417'],
      ['2026-09-20', '2026-09-21', 'DELTA AIR CREDIT', -2500, '4417'],
    ]);
  });

  it('reads charges printed as negative, and debit and credit columns, the same way', () => {
    const negative = readStatementList(
      'Date,Description,Amount\n2026-09-12,DELTA AIR,-402.20\n2026-09-27,LYFT,-18.40\n2026-09-20,REFUND,25.00',
      'USD',
    );
    const split = readStatementList(
      'Trans Date\tDescription\tDebit\tCredit\n09/12/2026\tDELTA AIR\t402.20\t\n09/20/2026\tREFUND\t\t25.00',
      'USD',
    );
    if (!negative.ok || !split.ok) throw new Error('should read');
    expect(negative.transactions.map((t) => t.amount.amountMinor)).toEqual([40_220, 1840, -2500]);
    expect(split.transactions.map((t) => t.amount.amountMinor)).toEqual([40_220, -2500]);
  });

  it('says plainly when a file isn’t a transaction list', () => {
    expect(readStatementList('', 'USD')).toEqual({ ok: false, problem: 'empty' });
    expect(readStatementList('Name,Email\nRiley,r@example.com', 'USD')).toEqual({
      ok: false,
      problem: 'no_columns',
    });
    expect(readStatementList('Date,Description,Amount\nsoon,X,1.00', 'USD')).toEqual({
      ok: false,
      problem: 'no_rows',
    });
    const row = '2026-09-12,LYFT,1.00';
    const full = ['Date,Description,Amount', ...Array<string>(STATEMENT_ROWS_MAX).fill(row)];
    expect(readStatementList(full.join('\n'), 'USD')).toMatchObject({ ok: true });
    expect(readStatementList([...full, row].join('\n'), 'USD')).toEqual({
      ok: false,
      problem: 'too_many_rows',
    });
  });
});
