import { createHash } from 'node:crypto';
import type { CardStatementRecord, StatementReading } from '@expensewise/db';
import type {
  ModelId,
  StatementExtraction,
  StatementReader,
  StatementRun,
} from '@expensewise/extraction';
import { InngestTestEngine } from '@inngest/test';
import { describe, expect, it } from 'vitest';
import {
  asReading,
  cardStatementReadingFunction,
  noReadingProblem,
  readStatement,
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

/** The primary in these tests: an OpenAI model, as an organization may choose (Q8). */
const PRIMARY: ModelId = 'gpt-5.6-luna';
const SONNET: ModelId = 'claude-sonnet-5-5';

/** What Anthropic answers an account with no credit: a 400 that retrying never fixes. */
const noCredit = () =>
  Object.assign(new Error('400 credit balance too low'), {
    status: 400,
    error: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message:
          'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
      },
    },
  });

type Answer = StatementExtraction | StatementRun['outcome'] | KeyProblem | Error;

/**
 * A member's uploaded statement, the models its organization reads with, in order, and what
 * each answers, or why it can't be asked.
 */
function world(
  answer: Answer = september,
  options: {
    record?: CardStatementRecord;
    file?: Uint8Array | null;
    order?: ModelId[];
    answers?: Partial<Record<ModelId, Answer>>;
  } = {},
) {
  const settled: StatementReading[] = [];
  const calls: ModelId[] = [];
  const answerOf = (model: ModelId) => options.answers?.[model] ?? answer;
  const reader = (model: ModelId) =>
    ({
      model,
      read: (): Promise<StatementRun> => {
        calls.push(model);
        const given = answerOf(model);
        if (given instanceof Error) return Promise.reject(given);
        const outcome =
          typeof given === 'string' ? (given as StatementRun['outcome']) : 'extracted';
        return Promise.resolve({
          outcome,
          statement: typeof given === 'string' ? null : given,
          model,
          version: 'statement-v1',
          latencyMs: 9000,
          usage: {
            inputTokens: 12_000,
            outputTokens: 900,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          costNanoUsd: 33_000_000n,
        });
      },
    }) as StatementReader;
  const ports: StatementReadingPorts = {
    loadStatement: () => Promise.resolve(options.record ?? statement()),
    fetchFile: () => Promise.resolve(options.file === undefined ? PDF : options.file),
    readingOrder: () => Promise.resolve(options.order ?? [PRIMARY]),
    reader: (_org, model) => {
      const given = answerOf(model);
      return Promise.resolve(
        given === 'no_key' || given === 'unreadable_key' ? given : reader(model),
      );
    },
    homeCurrency: () => Promise.resolve('USD'),
    settle: (_org, _id, reading) => {
      settled.push(reading);
      return Promise.resolve({ added: reading.transactions.length, matched: 0 });
    },
  };
  return { ports, settled, calls };
}

/** The primary's reading, settled: the statement read, held, or turned away. */
async function settlementOf(ports: StatementReadingPorts) {
  const result = await readStatement(ports, ORG, STATEMENT, PRIMARY);
  if (!result || !('status' in result)) throw new Error('Expected the statement settled');
  return result;
}

const run = (w: ReturnType<typeof world>) =>
  new InngestTestEngine({
    function: cardStatementReadingFunction(client, () => w.ports),
    events: [{ name: 'card_statement.filed', data: { orgId: ORG, statementId: STATEMENT } }],
  }).execute();

describe('reading a card statement (FR-CAP-10, US-CAP-07)', () => {
  it('keeps each transaction with its date, merchant, amount and card, when its totals add up', async () => {
    const reading = await settlementOf(world().ports);
    expect(reading).toMatchObject({
      status: 'read',
      problem: null,
      cardLastFour: '4417',
      currency: 'USD',
      model: PRIMARY,
      version: 'statement-v1',
      costNanoUsd: 33_000_000,
    });
    // A step's result is plain JSON; the database gets money back.
    expect(JSON.parse(JSON.stringify(reading))).toEqual(reading);
    const kept = asReading(reading);
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
    const reading = await settlementOf(world(short).ports);
    expect(reading).toMatchObject({
      status: 'needs_look',
      problem: 'Its charges come to $402.20, but it prints $420.60.',
    });
    expect(reading.transactions).toHaveLength(2);
  });

  it('holds it for a look when a line couldn’t be read, rather than guess it', async () => {
    const odd = {
      ...september,
      transactions: [
        { ...september.transactions[0]!, amount: 'four hundred' },
        ...september.transactions.slice(1),
      ],
    };
    expect(await readStatement(world(odd).ports, ORG, STATEMENT, PRIMARY)).toMatchObject({
      status: 'needs_look',
      problem: 'A line couldn’t be read, so the transactions may be incomplete.',
    });
  });

  it('says a model whose key is missing or unreadable read nothing, and asks it nothing', async () => {
    const w = world('no_key');
    expect(await readStatement(w.ports, ORG, STATEMENT, SONNET)).toEqual({
      noReading: 'There is no Anthropic key in Settings › AI keys.',
      tooLong: false,
      costNanoUsd: 0,
    });
    expect(await readStatement(world('unreadable_key').ports, ORG, STATEMENT, PRIMARY)).toEqual({
      noReading: 'The OpenAI key can’t be read. Save it again in Settings › AI keys.',
      tooLong: false,
      costNanoUsd: 0,
    });
    expect(w.calls).toEqual([]);
  });

  it('turns away a hotel folio emailed as a “statement”, and says how to send it as a receipt', async () => {
    const folio = { ...september, cardStatement: false, transactions: [] };
    expect(
      await readStatement(
        world(folio, { record: statement({ source: 'email' }) }).ports,
        ORG,
        STATEMENT,
        PRIMARY,
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
      const result = await run(w);
      expect(w.settled[0]).toMatchObject({
        status: 'failed',
        problem: 'It is too long to read in one go. Bring in a downloaded list instead.',
      });
      expect(result.result).toEqual({ status: 'failed', transactions: 0 });
      expect(w.calls).toEqual([PRIMARY]);
    }
  });

  it('reads nothing when the stored file isn’t the one uploaded, or isn’t a PDF', async () => {
    const changed = world(september, {
      file: new TextEncoder().encode('%PDF-1.7\nsomething else'),
    });
    expect(await readStatement(changed.ports, ORG, STATEMENT, PRIMARY)).toMatchObject({
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
    expect(await readStatement(notPdf.ports, ORG, STATEMENT, PRIMARY)).toMatchObject({
      status: 'failed',
    });
    expect([...changed.calls, ...notPdf.calls]).toEqual([]);
  });

  it('leaves a statement already settled alone', async () => {
    const w = world(september, { record: statement({ status: 'read' }) });
    expect(await readStatement(w.ports, ORG, STATEMENT, PRIMARY)).toBeUndefined();
    expect(w.calls).toEqual([]);
  });
});

describe('the statement event, read with the organization’s models (FR-INT-16, US-READ-17 AC13)', () => {
  it('reads the statement once with the primary, whichever provider it is, then keeps and matches its transactions', async () => {
    const w = world(september, { order: [PRIMARY, SONNET] });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'read', transactions: 3 });
    expect(w.calls).toEqual([PRIMARY]);
    expect(w.settled).toHaveLength(1);
    expect(w.settled[0]).toMatchObject({ model: PRIMARY });
    expect(w.settled[0]?.transactions[0]?.amount).toEqual({ amountMinor: 40_220, currency: 'USD' });
  });

  it('hands it to the next back-up when the primary’s provider turns it down for good, such as no credit, and asks it once', async () => {
    const w = world(september, { order: [SONNET, PRIMARY], answers: { [SONNET]: noCredit() } });
    const { result } = await run(w);
    expect(result).toEqual({ status: 'read', transactions: 3 });
    expect(w.calls).toEqual([SONNET, PRIMARY]);
    expect(w.settled[0]).toMatchObject({ status: 'read', problem: null, model: PRIMARY });
  });

  it('says what each model’s provider answered when none can read it, and asks for the list (US-CAP-07 AC10)', async () => {
    const w = world(noCredit(), { order: [SONNET], answers: {} });
    await run(w);
    expect(w.settled[0]).toMatchObject({
      status: 'failed',
      problem:
        'No model could read it. Sonnet 5.5: Anthropic answered “Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.” Change the models in Settings › AI models, or bring in a downloaded list.',
      model: SONNET,
    });
    // Turned down for good: not asked again.
    expect(w.calls).toEqual([SONNET]);
  });

  it('says no model can read it when none is on, or none has its provider’s key, and asks none (US-CAP-07 AC10)', async () => {
    const w = world(september, { order: [] });
    await run(w);
    expect(w.settled[0]).toMatchObject({
      status: 'failed',
      problem: noReadingProblem([]),
      transactions: [],
    });
    expect(noReadingProblem([])).toContain('Settings › AI models');
    expect(w.calls).toEqual([]);
  });
});
