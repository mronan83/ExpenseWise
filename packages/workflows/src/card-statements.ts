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
  MODELS,
  normalizeStatement,
  type ModelId,
  type StatementReader,
} from '@expensewise/extraction';
import { NonRetriableError, type Inngest } from 'inngest';
import { permanentFailure, stepFailure, type KeyProblem } from './receipts.ts';

/*
 * Reads a card statement PDF a member brought in, keeps its transactions and matches them to
 * the member's expenses (FR-CAP-10, FR-INT-24, ADR-0046, #97), with the organization's own
 * models: its primary, then each back-up that is on, as a receipt is read (FR-INT-16,
 * ADR-0050).
 */

/** What reading a statement needs from the database, storage and the providers. */
export interface StatementReadingPorts {
  loadStatement(orgId: string, statementId: string): Promise<CardStatementRecord | undefined>;
  fetchFile(storageKey: string): Promise<Uint8Array | null>;
  /**
   * The models that read, in the order tried: the primary, then each back-up that is on, less
   * any whose provider the organization has no key for. Read when each statement is read, so a
   * change in Settings applies to the next one.
   */
  readingOrder(orgId: string): Promise<readonly ModelId[]>;
  reader(orgId: string, model: ModelId): Promise<StatementReader | KeyProblem>;
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

/**
 * A model that gave no reading, and why, in words for the person: the next model that is on
 * reads it instead. tooLong: it timed out or ran out of room, as any model would.
 */
export interface NoReading {
  readonly noReading: string;
  readonly tooLong: boolean;
  readonly costNanoUsd: number;
}

const PROVIDER_NAME = { anthropic: 'Anthropic', openai: 'OpenAI' } as const;

/** Why a model with a key problem gave no reading (FR-INT-16). */
const keyText = (model: ModelId, problem: KeyProblem) => {
  const provider = PROVIDER_NAME[MODELS[model].provider];
  return problem === 'no_key'
    ? `There is no ${provider} key in Settings › AI keys.`
    : `The ${provider} key can’t be read. Save it again in Settings › AI keys.`;
};

/** What the provider said when it turned the request down for good, such as no credit. */
const refusedText = (model: ModelId, permanent: string) => {
  const provider = PROVIDER_NAME[MODELS[model].provider];
  const [code, ...rest] = permanent.split(': ');
  const said = rest.join(': ').trim();
  return code === 'key_rejected'
    ? `${provider} turned the key down: “${said}”`
    : `${provider} answered “${said}”`;
};

const sentence = (text: string) => (/[.”]$/.test(text) ? text : `${text}.`);

/**
 * Why no model read it, naming each one tried and what stopped it, or that none is on. Every
 * model too long for it asks for the downloaded list, as before.
 */
export function noReadingProblem(tried: readonly (NoReading & { model: ModelId })[]): string {
  if (tried.length === 0) {
    return 'No AI model can read it. Switch one on in Settings › AI models, with its provider’s key in Settings › AI keys, or bring in a downloaded list.';
  }
  if (tried.every((t) => t.tooLong)) {
    return 'It is too long to read in one go. Bring in a downloaded list instead.';
  }
  const each = tried.map((t) => `${MODELS[t.model].label}: ${sentence(t.noReading)}`).join(' ');
  return `No model could read it. ${each} Change the models in Settings › AI models, or bring in a downloaded list.`;
}

/**
 * Reads one statement with one model: checks its file is the one uploaded, has the model read
 * it, and works out whether it can be matched at once (US-CAP-07 AC5). Lines that don't read,
 * or that don't make the totals the statement prints, hold it for a look; no file, or a file
 * that isn't a statement, fails it, saying why. A model that gives no reading, from a key
 * problem, a provider that turns it down for good or an answer that doesn't fit, says why, so
 * the next model can read it. Throws only what retrying might fix, such as an outage.
 */
export async function readStatement(
  ports: StatementReadingPorts,
  orgId: string,
  statementId: string,
  model: ModelId,
): Promise<Settlement | NoReading | undefined> {
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
  const reader = await ports.reader(orgId, model);
  if (typeof reader === 'string') {
    return { noReading: keyText(model, reader), tooLong: false, costNanoUsd: 0 };
  }
  let run;
  try {
    run = await reader.read(bytes);
  } catch (error) {
    const permanent = permanentFailure(error);
    if (!permanent) throw error;
    return { noReading: refusedText(model, permanent), tooLong: false, costNanoUsd: 0 };
  }
  const audit = {
    model: run.model,
    version: run.version,
    costNanoUsd: Number(run.costNanoUsd),
  };
  if (run.outcome !== 'extracted' || !run.statement) {
    const tooLong = run.outcome === 'truncated' || run.outcome === 'timed_out';
    return {
      noReading: tooLong
        ? 'It was too long to read in one go.'
        : run.outcome === 'refused'
          ? 'It declined to read it.'
          : 'Its answer didn’t fit a card statement.',
      tooLong,
      costNanoUsd: audit.costNanoUsd,
    };
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
 * Reads a card statement after it is uploaded or emailed: the primary reads it, and each
 * back-up that is on only when the models before it gave no reading, each in a step of its
 * own, so a retry after a model answered never pays for it twice; then its transactions are
 * kept and matched. A model whose step runs out of retries, such as in an outage, hands it to
 * the next. If the run itself fails, the statement is settled as not read, so it never stays
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
      const order = await step.run('choose the models', () => ports().readingOrder(orgId));
      const tried: (NoReading & { model: ModelId })[] = [];
      let reading: Settlement | undefined;
      for (const model of order) {
        const { label } = MODELS[model];
        const result = await step
          .run(`read with ${label}`, () => readStatement(ports(), orgId, statementId, model))
          .catch((error: unknown) => ({
            noReading: `It wasn’t available: ${stepFailure(error)}`.slice(0, 200),
            tooLong: false,
            costNanoUsd: 0,
          }));
        if (!result) return { status: 'already settled' };
        if ('status' in result) {
          reading = result;
          break;
        }
        tried.push({ ...result, model });
      }
      // What every model tried cost, the one that read it included.
      const spent = tried.reduce((total, t) => total + t.costNanoUsd, 0);
      const last = tried.at(-1);
      reading = reading
        ? { ...reading, costNanoUsd: (reading.costNanoUsd ?? 0) + spent }
        : failed(noReadingProblem(tried), last ? { model: last.model, costNanoUsd: spent } : {});
      const settlement = reading;
      return step.run('keep and match its transactions', async () => {
        await ports().settle(orgId, statementId, asReading(settlement));
        return { status: settlement.status, transactions: settlement.transactions.length };
      });
    },
  );
}
