import { createHash } from 'node:crypto';
import {
  CARD_STATEMENT_FILED,
  type CardStatementRecord,
  type StatementReading,
} from '@expensewise/db';
import {
  checkStatement,
  format,
  money,
  type CardTransaction,
  type CurrencyCode,
} from '@expensewise/domain';
import {
  normalizeStatement,
  type ClaudeModelId,
  type StatementReader,
} from '@expensewise/extraction';
import { NonRetriableError, type Inngest } from 'inngest';
import type { KeyProblem } from './receipts.ts';

/*
 * Reads a card statement PDF a member brought in, keeps its transactions and matches them to
 * the member's expenses (FR-CAP-10, FR-INT-24, ADR-0046, #97).
 */

/**
 * The model that reads statements: one model, with the organization's Anthropic key. A
 * statement is long and its lines are what matter, so it gets the mid tier, not the smallest.
 */
export const STATEMENT_MODEL: ClaudeModelId = 'claude-sonnet-5-5';

/** What reading a statement needs from the database, storage and the provider. */
export interface StatementReadingPorts {
  loadStatement(orgId: string, statementId: string): Promise<CardStatementRecord | undefined>;
  fetchFile(storageKey: string): Promise<Uint8Array | null>;
  reader(orgId: string): Promise<StatementReader | KeyProblem>;
  /** The organization's home currency, for a statement that prints none. */
  homeCurrency(orgId: string): Promise<CurrencyCode>;
  settle(orgId: string, statementId: string, reading: StatementReading): Promise<unknown>;
}

/** A reading as a step returns it: plain JSON, money as minor units and a currency. */
type Settlement = Omit<StatementReading, 'charges' | 'credits' | 'transactions'> & {
  readonly charges: { amountMinor: number; currency: string } | null;
  readonly credits: { amountMinor: number; currency: string } | null;
  readonly transactions: (Omit<CardTransaction, 'amount'> & {
    amount: { amountMinor: number; currency: string };
  })[];
};

const failed = (problem: string, extra: Partial<Settlement> = {}): Settlement => ({
  status: 'failed',
  problem,
  cardLastFour: null,
  periodStart: null,
  periodEnd: null,
  currency: null,
  charges: null,
  credits: null,
  transactions: [],
  model: null,
  version: null,
  costNanoUsd: null,
  ...extra,
});

/** What a person reads about a key that can't read, as receipts say it (FR-INT-16). */
const KEY_TEXT: Record<KeyProblem, string> = {
  no_key: 'Add your Anthropic key in Settings › AI keys, then bring the statement in again.',
  unreadable_key: 'Your Anthropic key can’t be read. Save it again in Settings › AI keys.',
};

/**
 * Reads one statement: checks its file is the one uploaded, has the model read it, and works
 * out whether it can be matched at once (US-CAP-07 AC5). Lines that don't read, or that don't
 * make the totals the statement prints, hold it for a look; nothing read, or no file, fails it,
 * saying why. Never throws for what retrying can't fix.
 */
export async function readStatement(
  ports: StatementReadingPorts,
  orgId: string,
  statementId: string,
): Promise<Settlement | undefined> {
  const statement = await ports.loadStatement(orgId, statementId);
  if (!statement || statement.status !== 'reading' || !statement.storageKey) return undefined;
  const bytes = await ports.fetchFile(statement.storageKey);
  if (!bytes) return failed('The file wasn’t uploaded. Bring it in again.');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== statement.byteSize || sha256 !== statement.sha256) {
    return failed('The file changed after it was uploaded. Bring it in again.');
  }
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') {
    return failed('It isn’t a PDF. Bring in the statement’s PDF, or a downloaded list.');
  }
  const reader = await ports.reader(orgId);
  if (typeof reader === 'string') return failed(KEY_TEXT[reader]);
  const run = await reader.read(bytes);
  const audit = {
    model: run.model,
    version: run.version,
    costNanoUsd: Number(run.costNanoUsd),
  };
  if (run.outcome !== 'extracted' || !run.statement) {
    return failed(
      run.outcome === 'truncated' || run.outcome === 'timed_out'
        ? 'It is too long to read in one go. Bring in a downloaded list instead.'
        : 'It couldn’t be read as a card statement.',
      audit,
    );
  }
  if (!run.statement.cardStatement) {
    return failed(
      statement.source === 'email'
        ? 'It isn’t a card statement. If it’s a receipt, forward it again without “statement” in the subject.'
        : 'It isn’t a card statement.',
      audit,
    );
  }
  const read = normalizeStatement(run.statement, await ports.homeCurrency(orgId));
  const check = checkStatement(read.currency, read.transactions, read);
  const problem =
    read.transactions.length === 0
      ? 'No transactions were read from it.'
      : read.problems.length > 0
        ? `${read.problems.length === 1 ? 'A line' : `${read.problems.length} lines`} couldn’t be read, so the transactions may be incomplete.`
        : !check.addsUp
          ? `Its ${check.problem} come to ${format(check.comesTo)}, but it prints ${format(check.against)}.`
          : null;
  const plain = (m: { amountMinor: number; currency: string } | null) =>
    m ? { amountMinor: m.amountMinor, currency: m.currency } : null;
  return {
    status: problem ? 'needs_look' : 'read',
    problem,
    cardLastFour: read.cardLastFour,
    periodStart: read.periodStart,
    periodEnd: read.periodEnd,
    currency: read.currency,
    charges: plain(read.charges),
    credits: plain(read.credits),
    transactions: read.transactions.map((t) => ({ ...t, amount: plain(t.amount)! })),
    ...audit,
  };
}

/** A step's reading as the database keeps it. */
export function asReading(s: Settlement): StatementReading {
  const back = (m: { amountMinor: number; currency: string } | null) =>
    m ? money(m.amountMinor, m.currency) : null;
  return {
    ...s,
    charges: back(s.charges),
    credits: back(s.credits),
    transactions: s.transactions.map((t) => ({ ...t, amount: back(t.amount)! })),
  };
}

function statementRequest(data: unknown): { orgId: string; statementId: string } {
  const { orgId, statementId } = (data ?? {}) as Record<string, unknown>;
  if (typeof orgId !== 'string' || typeof statementId !== 'string') {
    throw new NonRetriableError('The event is missing orgId or statementId');
  }
  return { orgId, statementId };
}

/**
 * Reads a card statement after it is uploaded or emailed: read it once with the model, then keep
 * its transactions and match them, in steps, so a retry after the model answered never pays for
 * it twice. If the run itself fails, the statement is settled as not read, so it never stays
 * "reading".
 */
export function cardStatementReadingFunction(client: Inngest, ports: () => StatementReadingPorts) {
  return client.createFunction(
    {
      id: 'card-statement-reading',
      name: 'Read a card statement',
      triggers: [{ event: CARD_STATEMENT_FILED }],
      retries: 3,
      onFailure: async ({ event, step }) => {
        const { orgId, statementId } = statementRequest(event.data.event.data);
        await step.run('settle after failure', () =>
          ports().settle(
            orgId,
            statementId,
            asReading(failed('It couldn’t be read. Try again, or bring in a downloaded list.')),
          ),
        );
      },
    },
    async ({ event, step }) => {
      const { orgId, statementId } = statementRequest(event.data);
      const reading = await step.run('read the statement', () =>
        readStatement(ports(), orgId, statementId),
      );
      if (!reading) return { status: 'already settled' };
      return step.run('keep and match its transactions', async () => {
        await ports().settle(orgId, statementId, asReading(reading));
        return { status: reading.status, transactions: reading.transactions.length };
      });
    },
  );
}
