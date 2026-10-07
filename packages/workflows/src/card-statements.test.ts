import { createHash } from 'node:crypto';
import type { CardStatementRecord, StatementReading } from '@expensewise/db';
import type { StatementExtraction, StatementReader, StatementRun } from '@expensewise/extraction';
import { InngestTestEngine } from '@inngest/test';
import { describe, expect, it } from 'vitest';
import {
  asReading,
  cardStatementReadingFunction,
  readStatement,
  STATEMENT_MODEL,
  type StatementReadingPorts,
} from './card-statements.ts';
import { createWorkflowClient } from './client.ts';
import type { KeyProblem } from './receipts.ts';

const client = createWorkflowClient({ isDev: true });
const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const STATEMENT = '0192f7a0-0000-7000-8000-0000000000c7';
const PDF = new TextEncoder().encode('%PDF-1.7\nU.S. Bank statement');

/** U.S. Bank's September statement, as the model reads it: its totals make its lines. */
const september: StatementExtraction = {
  cardStatement: true,
  issuer: 'U.S. Bank',
  cardLastFour: '4417',
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
      reference: null,
      cardLastFour: null,
    },
    {
      transactionDate: '2026-09-27',
      postedDate: null,
      description: 'LYFT *RIDE SUN 8AM',
      amount: '18.40',
      reference: null,
      cardLastFour: null,
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

const statement = (over: Partial<CardStatementRecord> = {}): CardStatementRecord => ({
  id: STATEMENT,
  memberId: 'member-riley',
  source: 'upload',
  storageKey: `orgs/${ORG}/statements/${STATEMENT}`,
  contentType: 'application/pdf',
  byteSize: PDF.byteLength,
  sha256: createHash('sha256').update(PDF).digest('hex'),
  status: 'reading',
  problem: null,
  cardLastFour: null,
  periodStart: null,
  periodEnd: null,
  currency: null,
  chargesMinor: null,
  creditsMinor: null,
  added: 0,
  readAt: null,
  createdAt: new Date('2026-10-07T15:00:00Z'),
  ...over,
});

/** A member's uploaded statement, and what the model answers, or why it can't be asked. */
function world(
  answer: StatementExtraction | StatementRun['outcome'] | KeyProblem = september,
  options: { record?: CardStatementRecord; file?: Uint8Array | null } = {},
) {
  const settled: StatementReading[] = [];
  let calls = 0;
  const reader = {
    model: STATEMENT_MODEL,
    read: (): Promise<StatementRun> => {
      calls += 1;
      const outcome =
        typeof answer === 'string' ? (answer as StatementRun['outcome']) : 'extracted';
      return Promise.resolve({
        outcome,
        statement: typeof answer === 'string' ? null : answer,
        model: STATEMENT_MODEL,
        version: 'statement-v1',
        latencyMs: 9000,
        usage: { inputTokens: 12_000, outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0 },
        costNanoUsd: 33_000_000n,
      });
    },
  } as unknown as StatementReader;
  const ports: StatementReadingPorts = {
    loadStatement: () => Promise.resolve(options.record ?? statement()),
    fetchFile: () => Promise.resolve(options.file === undefined ? PDF : options.file),
    reader: () =>
      Promise.resolve(answer === 'no_key' || answer === 'unreadable_key' ? answer : reader),
    homeCurrency: () => Promise.resolve('USD'),
    settle: (_org, _id, reading) => {
      settled.push(reading);
      return Promise.resolve({ added: reading.transactions.length, matched: 0 });
    },
  };
  return { ports, settled, calls: () => calls };
}

describe('reading a card statement (FR-CAP-10, US-CAP-07)', () => {
  it('keeps each transaction with its date, merchant, amount and card, when its totals add up', async () => {
    const w = world();
    const reading = await readStatement(w.ports, ORG, STATEMENT);
    expect(reading).toMatchObject({
      status: 'read',
      problem: null,
      cardLastFour: '4417',
      currency: 'USD',
      model: STATEMENT_MODEL,
      version: 'statement-v1',
      costNanoUsd: 33_000_000,
    });
    // A step's result is plain JSON; the database gets money back.
    expect(JSON.parse(JSON.stringify(reading))).toEqual(reading);
    const kept = asReading(reading!);
    expect(kept.charges).toEqual({ amountMinor: 42_060, currency: 'USD' });
    expect(
      kept.transactions.map((t) => [t.merchant, t.amount.amountMinor, t.cardLastFour]),
    ).toEqual([
      ['DELTA AIR 0062345678901 ATLANTA GA', 40_220, '4417'],
      ['LYFT *RIDE SUN 8AM', 1840, '4417'],
      ['DELTA AIR CREDIT', -2500, '4417'],
    ]);
  });

  it('holds a statement whose lines miss its printed totals for a look (AC5)', async () => {
    const short = {
      ...september,
      transactions: september.transactions.slice(0, 1).concat(september.transactions[2]!),
    };
    const reading = await readStatement(world(short).ports, ORG, STATEMENT);
    expect(reading).toMatchObject({
      status: 'needs_look',
      problem: 'Its charges come to $402.20, but it prints $420.60.',
    });
    expect(reading?.transactions).toHaveLength(2);
  });

  it('holds it for a look when a line couldn’t be read, rather than guess it', async () => {
    const odd = {
      ...september,
      transactions: [
        { ...september.transactions[0]!, amount: 'four hundred' },
        ...september.transactions.slice(1),
      ],
    };
    expect(await readStatement(world(odd).ports, ORG, STATEMENT)).toMatchObject({
      status: 'needs_look',
      problem: 'A line couldn’t be read, so the transactions may be incomplete.',
    });
  });

  it('says what to do when there is no key, and asks no model', async () => {
    const w = world('no_key');
    expect(await readStatement(w.ports, ORG, STATEMENT)).toMatchObject({
      status: 'failed',
      problem: 'Add your Anthropic key in Settings › AI keys, then bring the statement in again.',
      transactions: [],
    });
    expect(w.calls()).toBe(0);
  });

  it('turns away a hotel folio emailed as a “statement”, and says how to send it as a receipt', async () => {
    const folio = { ...september, cardStatement: false, transactions: [] };
    expect(
      await readStatement(
        world(folio, { record: statement({ source: 'email' }) }).ports,
        ORG,
        STATEMENT,
      ),
    ).toMatchObject({
      status: 'failed',
      problem:
        'It isn’t a card statement. If it’s a receipt, forward it again without “statement” in the subject.',
    });
  });

  it('asks for the downloaded list when a statement is too long to read in one go, and tries once', async () => {
    for (const outcome of ['timed_out', 'truncated'] as const) {
      const w = world(outcome);
      expect(await readStatement(w.ports, ORG, STATEMENT)).toMatchObject({
        status: 'failed',
        problem: 'It is too long to read in one go. Bring in a downloaded list instead.',
      });
      expect(w.calls()).toBe(1);
    }
  });

  it('reads nothing when the stored file isn’t the one uploaded, or isn’t a PDF', async () => {
    const changed = world(september, {
      file: new TextEncoder().encode('%PDF-1.7\nsomething else'),
    });
    expect(await readStatement(changed.ports, ORG, STATEMENT)).toMatchObject({
      status: 'failed',
      problem: 'The file changed after it was uploaded. Bring it in again.',
    });
    const csv = new TextEncoder().encode('Date,Amount\n');
    const notPdf = world(september, {
      file: csv,
      record: statement({
        byteSize: csv.byteLength,
        sha256: createHash('sha256').update(csv).digest('hex'),
      }),
    });
    expect(await readStatement(notPdf.ports, ORG, STATEMENT)).toMatchObject({ status: 'failed' });
    expect(changed.calls() + notPdf.calls()).toBe(0);
  });

  it('leaves a statement already settled alone', async () => {
    const w = world(september, { record: statement({ status: 'read' }) });
    expect(await readStatement(w.ports, ORG, STATEMENT)).toBeUndefined();
    expect(w.calls()).toBe(0);
  });
});

describe('the statement event', () => {
  it('reads the statement once, then keeps and matches its transactions', async () => {
    const w = world();
    const t = new InngestTestEngine({
      function: cardStatementReadingFunction(client, () => w.ports),
      events: [{ name: 'card_statement.filed', data: { orgId: ORG, statementId: STATEMENT } }],
    });
    const { result } = await t.execute();
    expect(result).toEqual({ status: 'read', transactions: 3 });
    expect(w.settled).toHaveLength(1);
    expect(w.settled[0]?.transactions[0]?.amount).toEqual({ amountMinor: 40_220, currency: 'USD' });
  });
});
