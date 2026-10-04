import { newId, type ExpenseValues } from '@expensewise/domain';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import {
  checkUncheckedReceipts,
  deleteDuplicateReceipt,
  keepBothReceipts,
  listOpenDuplicatePairs,
  mergeDuplicateReceipt,
} from '../src/duplicates.ts';
import type { ReceiptOffer } from '../src/expenses.ts';
import { homeSnapshot } from '../src/home.ts';
import {
  confirmReceipt,
  fileReceipt,
  recordExtractionRun,
  requestReceiptReading,
  settleReceipt,
} from '../src/receipts.ts';
import {
  auditEvents,
  expenses,
  extractionRuns,
  receiptDuplicates,
  receiptReviews,
  receipts,
} from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await Promise.all([app.pool.end(), owner.pool.end()]);
});

type Org = Awaited<ReturnType<typeof seedOrg>>;
let files = 0;
const UBER: ExpenseValues = {
  merchant: 'Uber',
  transactionDate: '2026-10-02',
  currency: 'USD',
  amountMinor: 3142,
};

/** Files a receipt and settles its reading, as the workflow does; returns its id. */
async function readReceipt(
  org: Org,
  values: ReceiptOffer | null = UBER,
  status: 'extracted' | 'needs_review' | 'failed' = 'extracted',
): Promise<string> {
  const id = newId();
  const filed = await withOrg(app.db, org.orgId, (tx) =>
    fileReceipt(
      tx,
      org.orgId,
      {
        id,
        memberId: org.memberId,
        source: 'email',
        storageKey: `orgs/${org.orgId}/receipts/${id}`,
        contentType: 'application/pdf',
        byteSize: 2000,
        sha256: (++files).toString(16).padStart(64, '0'),
      },
      org.userId,
    ),
  );
  if (filed.status !== 'filed') throw new Error('not filed');
  await withOrg(app.db, org.orgId, async (tx) => {
    await recordExtractionRun(tx, org.orgId, {
      receiptId: id,
      requestId: filed.event.outboxId,
      extractor: 'claude',
      model: 'claude-haiku-4-5',
      promptVersion: 'extract-v2',
      schemaVersion: 'receipt-v2',
      outcome: 'confident',
      output: { documentType: 'ride_receipt' },
      fieldConfidence: { total: 'high' },
      error: null,
      latencyMs: 900,
      inputTokens: 1000,
      outputTokens: 200,
      costMicroUsd: 3000,
    });
    await settleReceipt(tx, org.orgId, id, {
      status,
      requestId: filed.event.outboxId,
      detail: {},
      values,
    });
  });
  return id;
}

const state = (org: Org, receiptId: string) =>
  withOrg(app.db, org.orgId, async (tx) => {
    const [receipt] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
    const [expense] = receipt?.expenseId
      ? await tx.select().from(expenses).where(eq(expenses.id, receipt.expenseId))
      : [];
    const pairs = await tx
      .select()
      .from(receiptDuplicates)
      .where(eq(receiptDuplicates.receiptId, receiptId));
    return { receipt, expense, pairs };
  });

const actions = (org: Org, entityId: string) =>
  withOrg(app.db, org.orgId, async (tx) =>
    (
      await tx
        .select({ action: auditEvents.action, payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.entityId, entityId))
    ).map((a) => a.action),
  );

/** How sure the check was when it held a receipt, as its audit event says. */
const heldAs = (org: Org, receiptId: string) =>
  withOrg(app.db, org.orgId, async (tx) => {
    const [event] = await tx
      .select({ payload: auditEvents.payload })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityId, receiptId),
          eq(auditEvents.action, 'receipt.possible_duplicate'),
        ),
      );
    return (event?.payload as { kind?: string } | undefined)?.kind ?? null;
  });

/** A dinner's itemized bill, in Houston; the card slip with the tip comes a few minutes on. */
const DINNER: ReceiptOffer = {
  merchant: 'Pappas Bros. Steakhouse',
  transactionDate: '2026-09-23',
  currency: 'USD',
  amountMinor: 9310,
  details: {
    time: '19:58',
    timeZone: 'America/Chicago',
    address: '1200 McKinney St, Houston, TX 77010',
    city: 'Houston',
    region: 'TX',
    country: 'US',
  },
};
const at = (time: string, amountMinor = DINNER.amountMinor): ReceiptOffer => ({
  ...DINNER,
  amountMinor,
  details: { ...DINNER.details!, time },
});

describe('matching on when and where (FR-INT-18, ADR-0031)', () => {
  it('holds an exact copy: the same time, place and total', async () => {
    const acme = await seedOrg(app.db, 'dup-exact');
    await readReceipt(acme, DINNER);
    const copy = await readReceipt(acme, DINNER);
    expect((await state(acme, copy)).receipt?.status).toBe('needs_review');
    expect(await heldAs(acme, copy)).toBe('exact');
  });

  it('holds the slip with a tip, minutes later and with another total, as possible', async () => {
    const acme = await seedOrg(app.db, 'dup-tip');
    const bill = await readReceipt(acme, DINNER);
    const slip = await readReceipt(acme, at('20:03', 10810));
    expect((await state(acme, slip)).pairs).toMatchObject([{ otherReceiptId: bill }]);
    expect(await heldAs(acme, slip)).toBe('possible');
    const [pair] = await withOrg(app.db, acme.orgId, (tx) => listOpenDuplicatePairs(tx, [slip]));
    expect(pair?.self).toMatchObject({ time: '20:03', city: 'Houston', country: 'US' });
  });

  it('keeps apart two purchases at the same place hours apart, even with the same total', async () => {
    const acme = await seedOrg(app.db, 'dup-hours');
    await readReceipt(acme, at('08:10'));
    const later = await readReceipt(acme, at('15:30'));
    expect((await state(acme, later)).receipt?.status).toBe('extracted');
    expect((await state(acme, later)).pairs).toEqual([]);
  });
});

describe('finding a possible duplicate when a receipt is read', () => {
  it('holds a later copy of a purchase for a look, and leaves it out of Home’s totals', async () => {
    const acme = await seedOrg(app.db, 'dup-hold');
    const first = await readReceipt(acme);
    const copy = await readReceipt(acme, { ...UBER, merchant: 'Uber Technologies Inc.' });

    expect((await state(acme, first)).receipt?.status).toBe('extracted');
    const held = await state(acme, copy);
    expect(held.receipt?.status).toBe('needs_review');
    expect(held.expense?.status).toBe('needs_review');
    expect(held.pairs).toMatchObject([
      { otherReceiptId: first, state: 'open', settledStatus: 'extracted' },
    ]);
    expect(await actions(acme, copy)).toContain('receipt.possible_duplicate');

    const pairs = await withOrg(app.db, acme.orgId, (tx) => listOpenDuplicatePairs(tx, [first]));
    expect(pairs).toMatchObject([
      {
        receiptId: first,
        otherReceiptId: copy,
        heldReceiptId: copy,
        self: { receiptId: first, merchant: UBER.merchant, amountMinor: UBER.amountMinor },
        other: {
          receiptId: copy,
          merchant: 'Uber Technologies Inc.',
          expenseStatus: 'needs_review',
        },
      },
    ]);

    const home = await withOrg(app.db, acme.orgId, (tx) =>
      homeSnapshot(tx, acme.memberId, '2026-10-03'),
    );
    expect(home.monthExpenses.reduce((n, t) => n + t.count, 0)).toBe(1);
  });

  it('leaves alone a different total, merchant, another member’s receipt, or one nothing could read', async () => {
    const acme = await seedOrg(app.db, 'dup-different');
    await readReceipt(acme);
    for (const values of [
      { ...UBER, amountMinor: 3143 },
      { ...UBER, merchant: 'Lyft' },
      { ...UBER, transactionDate: '2026-10-05' },
    ]) {
      const id = await readReceipt(acme, values);
      expect((await state(acme, id)).receipt?.status).toBe('extracted');
    }
    const failed = await readReceipt(acme, null, 'failed');
    expect((await state(acme, failed)).pairs).toEqual([]);
    const globex = await seedOrg(app.db, 'dup-other-org');
    const theirs = await readReceipt(globex);
    expect((await state(globex, theirs)).receipt?.status).toBe('extracted');
  });

  it('keeps a copy held when it is read again, and refuses to confirm it until the person decides', async () => {
    const acme = await seedOrg(app.db, 'dup-read-again');
    await readReceipt(acme);
    const copy = await readReceipt(acme);
    const again = await withOrg(app.db, acme.orgId, (tx) =>
      requestReceiptReading(tx, acme.orgId, copy, acme.userId),
    );
    await withOrg(app.db, acme.orgId, (tx) =>
      settleReceipt(tx, acme.orgId, copy, {
        status: 'needs_review',
        requestId: again!.outboxId,
        detail: {},
        values: UBER,
      }),
    );
    const held = await state(acme, copy);
    expect(held.receipt?.status).toBe('needs_review');
    expect(held.pairs).toMatchObject([{ state: 'open', settledStatus: 'needs_review' }]);
    const confirmed = await withOrg(app.db, acme.orgId, (tx) =>
      confirmReceipt(
        tx,
        acme.orgId,
        copy,
        {
          memberId: acme.memberId,
          requestId: again!.outboxId,
          model: 'claude-haiku-4-5',
          merchant: 'Uber',
          transactionDate: '2026-10-02',
          currency: 'USD',
          totalMinor: 3142,
          taxMinor: null,
          tipMinor: null,
          corrections: [],
        },
        acme.userId,
      ),
    );
    expect(confirmed).toBe('duplicate');
  });
});

describe('deciding about a possible duplicate', () => {
  it('keeps both: the copy goes back to what it was read as, and the pair is never flagged again', async () => {
    const acme = await seedOrg(app.db, 'dup-keep');
    const first = await readReceipt(acme);
    const copy = await readReceipt(acme);
    const kept = await withOrg(app.db, acme.orgId, (tx) =>
      keepBothReceipts(tx, acme.orgId, first, copy, acme.userId),
    );
    expect(kept).toEqual({ status: 'kept_both' });
    const after = await state(acme, copy);
    expect(after.receipt?.status).toBe('extracted');
    expect(after.expense?.status).toBe('ready');
    expect(after.pairs).toMatchObject([{ state: 'dismissed' }]);
    expect(await actions(acme, copy)).toContain('receipt.not_a_duplicate');

    const again = await withOrg(app.db, acme.orgId, (tx) =>
      requestReceiptReading(tx, acme.orgId, copy, acme.userId),
    );
    await withOrg(app.db, acme.orgId, (tx) =>
      settleReceipt(tx, acme.orgId, copy, {
        status: 'extracted',
        requestId: again!.outboxId,
        detail: {},
        values: UBER,
      }),
    );
    expect((await state(acme, copy)).receipt?.status).toBe('extracted');
  });

  it('deletes a copy with its readings and expense, keeps a record of it, and returns its file', async () => {
    const acme = await seedOrg(app.db, 'dup-delete');
    const first = await readReceipt(acme);
    const copy = await readReceipt(acme);
    const third = await readReceipt(acme);
    const { expense } = await state(acme, copy);

    const result = await withOrg(app.db, acme.orgId, (tx) =>
      deleteDuplicateReceipt(tx, acme.orgId, copy, first, acme.userId),
    );
    expect(result).toEqual({
      status: 'deleted',
      kept: first,
      storageKey: `orgs/${acme.orgId}/receipts/${copy}`,
    });
    const gone = await state(acme, copy);
    expect(gone.receipt).toBeUndefined();
    await withOrg(app.db, acme.orgId, async (tx) => {
      expect(await tx.select().from(expenses).where(eq(expenses.id, expense!.id))).toEqual([]);
      expect(
        await tx.select().from(extractionRuns).where(eq(extractionRuns.receiptId, copy)),
      ).toEqual([]);
    });
    expect(await actions(acme, copy)).toContain('receipt.deleted');
    // The third copy was held against the first all along, and still is.
    expect((await state(acme, third)).pairs).toMatchObject([{ otherReceiptId: first }]);
  });

  it('re-pairs a third copy with the receipt kept when the one it pointed at is deleted', async () => {
    const acme = await seedOrg(app.db, 'dup-repair');
    const first = await readReceipt(acme);
    const second = await readReceipt(acme);
    const third = await readReceipt(acme);
    // Keep the second; delete the first, which both copies pointed at.
    await withOrg(app.db, acme.orgId, (tx) =>
      deleteDuplicateReceipt(tx, acme.orgId, first, second, acme.userId),
    );
    expect((await state(acme, second)).receipt?.status).toBe('extracted');
    const after = await state(acme, third);
    expect(after.receipt?.status).toBe('needs_review');
    expect(after.pairs).toMatchObject([{ otherReceiptId: second, state: 'open' }]);
  });

  it('merges a copy into the primary chosen, taking what it lacks and what was picked', async () => {
    const acme = await seedOrg(app.db, 'dup-merge');
    const first = await readReceipt(acme);
    const copy = await readReceipt(acme, {
      ...UBER,
      merchant: 'Uber Technologies',
      transactionDate: '2026-10-03',
    });
    await withOrg(app.db, acme.orgId, async (tx) => {
      const { expense } = await state(acme, copy);
      await tx
        .update(expenses)
        .set({ notes: 'Airport to office' })
        .where(eq(expenses.id, expense!.id));
    });

    // The copy is chosen as primary: it takes the first's date, and the first is deleted.
    const result = await withOrg(app.db, acme.orgId, (tx) =>
      mergeDuplicateReceipt(tx, acme.orgId, copy, first, ['date'], acme.userId),
    );
    expect(result).toMatchObject({ status: 'merged', kept: copy, taken: ['date'] });
    const after = await state(acme, copy);
    expect(after.receipt?.status).toBe('extracted');
    expect(after.expense).toMatchObject({
      status: 'ready',
      merchant: 'Uber Technologies',
      transactionDate: '2026-10-02',
      notes: 'Airport to office',
    });
    expect(after.expense?.editedAt).not.toBeNull();
    expect((await state(acme, first)).receipt).toBeUndefined();
    expect(await actions(acme, after.expense!.id)).toContain('expense.merged');
    expect(await actions(acme, first)).toContain('receipt.merged_away');
  });

  it('never deletes a submitted expense, and acts only on a pair that is open', async () => {
    const acme = await seedOrg(app.db, 'dup-locked');
    const first = await readReceipt(acme);
    const copy = await readReceipt(acme);
    const stranger = await readReceipt(acme, { ...UBER, merchant: 'Lyft' });
    expect(
      await withOrg(app.db, acme.orgId, (tx) =>
        deleteDuplicateReceipt(tx, acme.orgId, stranger, first, acme.userId),
      ),
    ).toEqual({ status: 'not_a_pair' });

    const { expense } = await state(acme, copy);
    await withOrg(app.db, acme.orgId, (tx) =>
      tx.update(expenses).set({ status: 'submitted' }).where(eq(expenses.id, expense!.id)),
    );
    expect(
      await withOrg(app.db, acme.orgId, (tx) =>
        deleteDuplicateReceipt(tx, acme.orgId, copy, first, acme.userId),
      ),
    ).toEqual({ status: 'locked' });
    // The database refuses too, whoever asks.
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) => tx.execute(sql`select * from delete_receipt(${copy})`)),
      /can't be deleted/,
    );
  });

  it('deletes nothing in another organization, and the app cannot delete receipts any other way', async () => {
    const acme = await seedOrg(app.db, 'dup-acme');
    const globex = await seedOrg(app.db, 'dup-globex');
    const theirs = await readReceipt(globex);
    const rows = await withOrg(app.db, acme.orgId, (tx) =>
      tx.execute(sql`select * from delete_receipt(${theirs})`),
    );
    expect(rows.rows).toEqual([]);
    expect((await state(globex, theirs)).receipt).toBeDefined();
    for (const table of [receipts, expenses, extractionRuns, receiptReviews]) {
      await expectDbError(
        withOrg(app.db, globex.orgId, (tx) => tx.delete(table)),
        /permission denied/,
      );
    }
  });
});

describe('checking receipts read before duplicates were looked for', () => {
  it('holds the later copies, once, and leaves the rest', async () => {
    const acme = await seedOrg(app.db, 'dup-sweep');
    const first = await readReceipt(acme);
    const copy = await readReceipt(acme);
    // As if both were read before the check existed.
    await owner.db
      .update(receipts)
      .set({ duplicatesCheckedAt: null, status: 'extracted' })
      .where(and(eq(receipts.orgId, acme.orgId)));
    await owner.db.delete(receiptDuplicates).where(eq(receiptDuplicates.orgId, acme.orgId));

    expect(await checkUncheckedReceipts(owner.db)).toBeGreaterThanOrEqual(1);
    expect((await state(acme, first)).receipt?.status).toBe('extracted');
    expect((await state(acme, copy)).pairs).toMatchObject([{ otherReceiptId: first }]);
    expect(await checkUncheckedReceipts(owner.db)).toBe(0);
  });
});
