import { money, newId, type CardTransaction, type MemberRole } from '@expensewise/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  bringBackCardTransaction,
  cardTransactionsOfExpenses,
  confirmCardStatement,
  deleteCardStatement,
  fileCardStatement,
  listCardStatements,
  matchableExpenses,
  matchCardTransactions,
  matchCardTransactionTo,
  missingReceipts,
  recordCardList,
  setAsideCardTransaction,
  settleCardStatement,
  unmatchCardTransaction,
  type StatementReading,
} from '../src/card-statements.ts';
import { classifyExpense, listCatalog, seedStarterCatalog } from '../src/categories.ts';
import { isOwnRecordsRefusal, withMember, withOrg } from '../src/client.ts';
import { setExpensePaidBy, setTypeCompanyPays } from '../src/company-paid.ts';
import type { ReceiptOffer } from '../src/expenses.ts';
import { fileReceipt, settleReceipt } from '../src/receipts.ts';
import { auditEvents, expenses, members, outboxEvents, receipts } from '../src/schema.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

type Org = Awaited<ReturnType<typeof seedOrg>>;
type Who = { orgId: string; memberId: string; role: MemberRole; userId: string };
const self = (org: Org): Who => ({ ...org, role: 'owner' });
let files = 0x97_0000;
const sha = () => (++files).toString(16).padStart(64, 'a');

/** Files a receipt for the member and settles its reading, as the workflow does. */
async function expenseFrom(
  org: Org,
  offer: ReceiptOffer,
  memberId = org.memberId,
): Promise<string> {
  const receiptId = newId();
  const requestId = await withOrg(app.db, org.orgId, async (tx) => {
    const filed = await fileReceipt(
      tx,
      org.orgId,
      {
        id: receiptId,
        memberId,
        source: 'upload',
        storageKey: `orgs/${org.orgId}/receipts/${receiptId}`,
        contentType: 'application/pdf',
        byteSize: 4000,
        sha256: sha(),
      },
      org.userId,
    );
    if (filed.status !== 'filed') throw new Error('not filed');
    return filed.event.outboxId;
  });
  await withOrg(app.db, org.orgId, (tx) =>
    settleReceipt(tx, org.orgId, receiptId, {
      status: 'extracted',
      requestId,
      detail: {},
      values: offer,
    }),
  );
  return withOrg(app.db, org.orgId, async (tx) => {
    const [r] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
    return r!.expenseId!;
  });
}

const usd = (cents: number) => money(cents, 'USD');
const charge = (merchant: string, date: string, cents: number): CardTransaction => ({
  transactionDate: date,
  postedOn: null,
  merchant,
  amount: usd(cents),
  cardLastFour: '4417',
  reference: null,
});
const read = (
  transactions: CardTransaction[],
  over: Partial<StatementReading> = {},
): StatementReading => ({
  status: 'read',
  problem: null,
  cardLastFour: '4417',
  periodStart: '2026-08-29',
  periodEnd: '2026-09-28',
  currency: 'USD',
  charges: null,
  credits: null,
  transactions,
  model: 'claude-sonnet-5-5',
  version: 'statement-v1',
  costNanoUsd: 33_000_000,
  ...over,
});
const SEPTEMBER = [
  charge('DELTA AIR 0062345678901 ATLANTA GA', '2026-09-12', 40_220),
  charge('LYFT *RIDE SUN 8AM', '2026-09-27', 1840),
  charge('JUNIPER & RYE OMAHA', '2026-09-24', 8615),
  charge('DELTA AIR CREDIT', '2026-09-20', -2500),
];

async function statementFor(org: Org, memberId = org.memberId) {
  const id = newId();
  const filed = await withOrg(app.db, org.orgId, (tx) =>
    fileCardStatement(
      tx,
      org.orgId,
      {
        id,
        memberId,
        source: 'upload',
        storageKey: `orgs/${org.orgId}/statements/${id}`,
        contentType: 'application/pdf',
        byteSize: 52_000,
        sha256: sha(),
      },
      { type: 'user', id: org.userId },
    ),
  );
  if (filed.status !== 'filed') throw new Error('not filed');
  return { id, filed };
}

describe('bringing in a card statement (FR-CAP-10, US-CAP-07)', () => {
  it('files a statement once, keeps each transaction once, and matches what it can', async () => {
    const org = await seedOrg(app.db, 'card-statement');
    const delta = await expenseFrom(org, {
      merchant: 'Delta Air Lines',
      transactionDate: '2026-09-12',
      currency: 'USD',
      amountMinor: 40_220,
    });
    const lyft = await expenseFrom(org, {
      merchant: 'Lyft',
      transactionDate: '2026-09-28',
      currency: 'USD',
      amountMinor: 1840,
    });
    const { id, filed } = await statementFor(org);
    const event = await withOrg(app.db, org.orgId, (tx) =>
      tx.select().from(outboxEvents).where(eq(outboxEvents.id, filed.event.outboxId)),
    );
    expect(event[0]).toMatchObject({ topic: 'card_statement.filed', payload: { statementId: id } });

    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        settleCardStatement(tx, org.orgId, id, read(SEPTEMBER)),
      ),
    ).toEqual({ added: 4, matched: 2 });
    // Settling it again changes nothing.
    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        settleCardStatement(tx, org.orgId, id, read(SEPTEMBER)),
      ),
    ).toBeUndefined();

    const mine = await withMember(app.db, self(org), (tx) => listCardStatements(tx, org.memberId));
    expect(mine.statements[0]).toMatchObject({
      id,
      status: 'read',
      added: 4,
      cardLastFour: '4417',
    });
    const byMerchant = Object.fromEntries(mine.transactions.map((t) => [t.merchant, t]));
    expect(byMerchant['DELTA AIR 0062345678901 ATLANTA GA']).toMatchObject({
      expenseId: delta,
      matchedBy: 'auto',
    });
    expect(byMerchant['LYFT *RIDE SUN 8AM']).toMatchObject({ expenseId: lyft, matchedBy: 'auto' });
    // The dinner has no receipt yet; the credit is never a missing receipt.
    const missing = await withMember(app.db, self(org), (tx) => missingReceipts(tx, org.memberId));
    expect(missing.map((t) => t.merchant)).toEqual(['JUNIPER & RYE OMAHA']);
    expect(
      (await withMember(app.db, self(org), (tx) => cardTransactionsOfExpenses(tx, [delta])))[0],
    ).toMatchObject({ amountMinor: 40_220, merchant: 'DELTA AIR 0062345678901 ATLANTA GA' });

    // October's statement lists the dinner again: it is kept once, and a receipt read later
    // matches it.
    const { id: october } = await statementFor(org);
    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        settleCardStatement(
          tx,
          org.orgId,
          october,
          read([SEPTEMBER[2]!, charge('HILTON OMAHA', '2026-10-01', 41_260)]),
        ),
      ),
    ).toEqual({ added: 1, matched: 0 });
    const dinner = await expenseFrom(org, {
      merchant: 'Juniper & Rye',
      transactionDate: '2026-09-24',
      currency: 'USD',
      amountMinor: 8615,
    });
    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        matchCardTransactions(tx, org.orgId, org.memberId, { type: 'system', id: 'test' }),
      ),
    ).toBe(1);
    expect(
      (await withMember(app.db, self(org), (tx) => cardTransactionsOfExpenses(tx, [dinner])))[0],
    ).toMatchObject({ merchant: 'JUNIPER & RYE OMAHA' });
    const actions = await withOrg(app.db, org.orgId, (tx) =>
      tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.entityId, id))
        .orderBy(auditEvents.sequence),
    );
    expect(actions.map((a) => a.action)).toEqual(['card_statement.filed', 'card_statement.read']);
  });

  it('holds a statement that needs a look, matching nothing until the person confirms it', async () => {
    const org = await seedOrg(app.db, 'card-statement-look');
    const lyft = await expenseFrom(org, {
      merchant: 'Lyft',
      transactionDate: '2026-09-27',
      currency: 'USD',
      amountMinor: 1840,
    });
    const { id } = await statementFor(org);
    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        settleCardStatement(
          tx,
          org.orgId,
          id,
          read(SEPTEMBER, {
            status: 'needs_look',
            problem: 'Its charges come to $500.75, but it prints $520.75.',
          }),
        ),
      ),
    ).toEqual({ added: 4, matched: 0 });
    expect(await withMember(app.db, self(org), (tx) => missingReceipts(tx, org.memberId))).toEqual(
      [],
    );
    expect(
      await withMember(app.db, self(org), (tx) =>
        confirmCardStatement(tx, org.orgId, id, org.userId),
      ),
    ).toEqual({ status: 'changed' });
    expect(
      await withMember(app.db, self(org), (tx) =>
        confirmCardStatement(tx, org.orgId, id, org.userId),
      ),
    ).toEqual({ status: 'not_waiting' });
    expect(
      (await withMember(app.db, self(org), (tx) => cardTransactionsOfExpenses(tx, [lyft])))[0],
    ).toMatchObject({ matchedBy: 'auto' });
  });

  it('brings in a downloaded list with no model, once', async () => {
    const org = await seedOrg(app.db, 'card-list');
    await expenseFrom(org, {
      merchant: 'Delta Air Lines',
      transactionDate: '2026-09-12',
      currency: 'USD',
      amountMinor: 40_220,
    });
    const hash = sha();
    const input = {
      id: newId(),
      memberId: org.memberId,
      byteSize: 400,
      sha256: hash,
      currency: 'USD',
      transactions: SEPTEMBER,
    };
    const first = await withMember(app.db, self(org), (tx) =>
      recordCardList(tx, org.orgId, input, org.userId),
    );
    expect(first).toMatchObject({ status: 'filed', added: 4, matched: 1 });
    expect(
      await withMember(app.db, self(org), (tx) =>
        recordCardList(tx, org.orgId, { ...input, id: newId() }, org.userId),
      ),
    ).toEqual({ status: 'exists', statementId: input.id });
  });
});

describe('a missing receipt, set aside or matched by hand (US-CAP-07 AC3, AC7)', () => {
  it('sets one aside with a reason, brings it back, and matches one by hand to a nearby expense', async () => {
    const org = await seedOrg(app.db, 'card-set-aside');
    const { id } = await statementFor(org);
    await withOrg(app.db, org.orgId, (tx) =>
      settleCardStatement(tx, org.orgId, id, read(SEPTEMBER)),
    );
    const [dinner, , lyft] = await withMember(app.db, self(org), (tx) =>
      missingReceipts(tx, org.memberId),
    ).then((m) => [
      m.find((t) => t.merchant.startsWith('JUNIPER'))!,
      null,
      m.find((t) => t.merchant.startsWith('LYFT'))!,
    ]);
    const inOrg = <T>(work: Parameters<typeof withMember<T>>[2]) =>
      withMember(app.db, self(org), work);
    expect(
      await inOrg((tx) =>
        setAsideCardTransaction(tx, org.orgId, dinner!.id, { reason: 'other' }, org.userId),
      ),
    ).toEqual({ status: 'invalid', problem: 'note_needed' });
    expect(
      await inOrg((tx) =>
        setAsideCardTransaction(
          tx,
          org.orgId,
          dinner!.id,
          { reason: 'personal', note: 'Dinner with family' },
          org.userId,
        ),
      ),
    ).toEqual({ status: 'changed' });
    expect(
      (await inOrg((tx) => missingReceipts(tx, org.memberId))).map((t) => t.merchant),
    ).not.toContain('JUNIPER & RYE OMAHA');
    expect(
      await inOrg((tx) => bringBackCardTransaction(tx, org.orgId, dinner!.id, org.userId)),
    ).toEqual({
      status: 'changed',
    });

    // The ride's receipt shows $16.00 before the tip the card charged: a person matches it.
    const ride = await expenseFrom(org, {
      merchant: 'Lyft',
      transactionDate: '2026-09-27',
      currency: 'USD',
      amountMinor: 1600,
    });
    expect(
      (await inOrg((tx) => matchableExpenses(tx, org.memberId, '2026-09-27'))).map((e) => e.id),
    ).toContain(ride);
    expect(
      await inOrg((tx) => matchCardTransactionTo(tx, org.orgId, lyft!.id, ride, org.userId)),
    ).toEqual({
      status: 'changed',
    });
    expect(
      await inOrg((tx) =>
        setAsideCardTransaction(tx, org.orgId, lyft!.id, { reason: 'personal' }, org.userId),
      ),
    ).toEqual({ status: 'matched' });
    // Another charge can pay for it too, such as a tip the card charged apart (AC12), and is
    // offered with what the ride's charges already come to.
    expect(
      (await inOrg((tx) => matchableExpenses(tx, org.memberId, '2026-09-27'))).find(
        (e) => e.id === ride,
      ),
    ).toMatchObject({ chargedMinor: 1840 });
    expect(
      await inOrg((tx) => matchCardTransactionTo(tx, org.orgId, dinner!.id, ride, org.userId)),
    ).toEqual({
      status: 'changed',
    });
    expect(
      (await inOrg((tx) => cardTransactionsOfExpenses(tx, [ride]))).map((t) => t.id).sort(),
    ).toEqual([lyft!.id, dinner!.id].sort());
    await inOrg((tx) => unmatchCardTransaction(tx, org.orgId, dinner!.id, org.userId));
    expect(
      await inOrg((tx) => unmatchCardTransaction(tx, org.orgId, lyft!.id, org.userId)),
    ).toEqual({
      status: 'changed',
    });
    await inOrg((tx) => matchCardTransactionTo(tx, org.orgId, lyft!.id, ride, org.userId));

    // Deleting the ride's receipt deletes its expense, and the ride is a missing receipt again.
    const [receipt] = await withOrg(app.db, org.orgId, (tx) =>
      tx.select({ id: receipts.id }).from(receipts).where(eq(receipts.expenseId, ride)),
    );
    await inOrg((tx) => tx.execute(sql`select * from delete_receipt(${receipt!.id}::uuid)`));
    expect((await inOrg((tx) => missingReceipts(tx, org.memberId))).map((t) => t.id)).toContain(
      lyft!.id,
    );
  });

  it('matches a ride and its tip, charged apart, to the one receipt on its own, and the company pays it (AC13)', async () => {
    const org = await seedOrg(app.db, 'card-pair');
    const ride = await expenseFrom(org, {
      merchant: 'Uber',
      transactionDate: '2026-09-29',
      currency: 'USD',
      amountMinor: 2411,
    });
    const { id } = await statementFor(org);
    await withOrg(app.db, org.orgId, (tx) =>
      settleCardStatement(
        tx,
        org.orgId,
        id,
        read([
          charge('UBER *TRIP HELP.UBER.COM, CA', '2026-09-29', 2111),
          charge('UBER *TRIP HELP.UBER.COM, CA', '2026-09-29', 300),
        ]),
      ),
    );
    const paid = await withMember(app.db, self(org), (tx) =>
      cardTransactionsOfExpenses(tx, [ride]),
    );
    expect(paid.map((t) => [t.amountMinor, t.matchedBy]).sort()).toEqual([
      [2111, 'auto'],
      [300, 'auto'],
    ]);
    expect(await withMember(app.db, self(org), (tx) => missingReceipts(tx, org.memberId))).toEqual(
      [],
    );
    const [expense] = await withOrg(app.db, org.orgId, (tx) =>
      tx.select({ companyPaid: expenses.companyPaid }).from(expenses).where(eq(expenses.id, ride)),
    );
    expect(expense?.companyPaid).toBe(true);
    // Letting the tip go leaves the ride's charge, so the company still pays it.
    await withMember(app.db, self(org), (tx) =>
      unmatchCardTransaction(
        tx,
        org.orgId,
        paid.find((t) => t.amountMinor === 300)!.id,
        org.userId,
      ),
    );
    const [after] = await withOrg(app.db, org.orgId, (tx) =>
      tx.select({ companyPaid: expenses.companyPaid }).from(expenses).where(eq(expenses.id, ride)),
    );
    expect(after?.companyPaid).toBe(true);
  });

  it('keeps each member’s statements to them, and deletes one with its transactions', async () => {
    const org = await seedOrg(app.db, 'card-own');
    const sam = await addMember(org, 'sam', 'member');
    const finance = await addMember(org, 'fin', 'finance_admin');
    const { id } = await statementFor(org, sam.memberId);
    await withOrg(app.db, org.orgId, (tx) =>
      settleCardStatement(tx, org.orgId, id, read(SEPTEMBER)),
    );
    const other = await addMember(org, 'alex', 'member');
    expect(
      (await withMember(app.db, other, (tx) => listCardStatements(tx, sam.memberId))).transactions,
    ).toEqual([]);
    const seen = await withMember(app.db, finance, (tx) => listCardStatements(tx, sam.memberId));
    expect(seen.transactions).toHaveLength(4);
    const refused = await withMember(app.db, finance, (tx) =>
      setAsideCardTransaction(
        tx,
        org.orgId,
        seen.transactions[0]!.id,
        { reason: 'personal' },
        finance.userId,
      ),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isOwnRecordsRefusal(refused)).toBe(true);
    expect(
      await withMember(app.db, sam, (tx) => deleteCardStatement(tx, org.orgId, id, sam.userId)),
    ).toEqual({
      storageKey: `orgs/${org.orgId}/statements/${id}`,
    });
    const left = await owner.db.execute<{ n: number }>(
      sql`select count(*) as n from card_transactions where statement_id = ${id}::uuid`,
    );
    expect(Number(left.rows[0]?.n)).toBe(0);
  });
});

/** A member of `org` with `role`, added by the system as an accepted invite would. */
async function addMember(org: Org, name: string, role: MemberRole): Promise<Who> {
  const memberId = newId();
  await withOrg(app.db, org.orgId, (tx) =>
    tx.insert(members).values({
      id: memberId,
      orgId: org.orgId,
      userId: `user_${memberId}`,
      email: `${name}@example.com`,
      displayName: name,
      role,
    }),
  );
  return { orgId: org.orgId, memberId, role, userId: `user_${memberId}` };
}

describe('a corporate card billed to the company (FR-INT-25, FR-INT-26, US-CAP-08)', () => {
  /** Who paid each expense, as `company`, `claimant`, with `, pinned` when set by hand. */
  const payers = (org: Org, ids: readonly string[]) =>
    withOrg(app.db, org.orgId, async (tx) => {
      const rows = await tx
        .select({ id: expenses.id, paid: expenses.companyPaid, pinned: expenses.companyPaidPinned })
        .from(expenses);
      return ids.map((id) => {
        const r = rows.find((e) => e.id === id)!;
        return `${r.paid ? 'company' : 'claimant'}${r.pinned ? ', pinned' : ''}`;
      });
    });

  it('marks the expense a charge paid for as the company’s, keeps a person’s choice, and hands it back when let go', async () => {
    const org = await seedOrg(app.db, 'card-company-pays');
    const inOrg = <T>(work: Parameters<typeof withMember<T>>[2]) =>
      withMember(app.db, self(org), work);
    const fare = await expenseFrom(org, {
      merchant: 'Delta',
      transactionDate: '2026-09-12',
      currency: 'USD',
      amountMinor: 40_220,
    });
    const { id } = await statementFor(org);
    await withOrg(app.db, org.orgId, (tx) =>
      settleCardStatement(tx, org.orgId, id, read(SEPTEMBER)),
    );
    // Matched on its own: the company's card paid it, so it is never claimed (AC1).
    expect(await payers(org, [fare])).toEqual(['company']);
    const switched = await withOrg(app.db, org.orgId, (tx) =>
      tx
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          sql`${auditEvents.action} = 'expense.paid_by_set' AND ${auditEvents.entityId} = ${fare}`,
        ),
    );
    expect(switched.map((e) => e.payload)).toEqual([
      expect.objectContaining({ byCard: true, after: { paidBy: 'company', pinned: false } }),
    ]);

    const [delta] = (await inOrg((tx) => listCardStatements(tx, org.memberId))).transactions.filter(
      (t) => t.expenseId === fare,
    );
    // Let go, it goes back to its type's policy, and the charge is a missing receipt (AC4).
    await inOrg((tx) => unmatchCardTransaction(tx, org.orgId, delta!.id, org.userId));
    expect(await payers(org, [fare])).toEqual(['claimant']);
    await inOrg((tx) => matchCardTransactionTo(tx, org.orgId, delta!.id, fare, org.userId));
    expect(await payers(org, [fare])).toEqual(['company']);

    // A person's choice stands while the charge pays for it, and handing it back follows it (AC3).
    await inOrg((tx) => setExpensePaidBy(tx, org.orgId, fare, { paidBy: 'claimant' }, org.userId));
    await inOrg((tx) => unmatchCardTransaction(tx, org.orgId, delta!.id, org.userId));
    await inOrg((tx) => matchCardTransactionTo(tx, org.orgId, delta!.id, fare, org.userId));
    expect(await payers(org, [fare])).toEqual(['claimant, pinned']);
    await inOrg((tx) => setExpensePaidBy(tx, org.orgId, fare, { byPolicy: true }, org.userId));
    expect(await payers(org, [fare])).toEqual(['company']);

    // Deleting the statement takes its charges, and the expense goes back to its type's policy.
    await inOrg((tx) => deleteCardStatement(tx, org.orgId, id, org.userId));
    expect(await payers(org, [fare])).toEqual(['claimant']);
  });

  it('keeps a card’s expense the company’s whatever its type’s policy, and never changes a submitted claim', async () => {
    const org = await seedOrg(app.db, 'card-company-policy');
    await withOrg(app.db, org.orgId, (tx) => seedStarterCatalog(tx, org.orgId));
    const catalog = await withOrg(app.db, org.orgId, (tx) => listCatalog(tx));
    const type = catalog.types.find((t) => t.name === 'Airfare')!;
    const airfare = {
      typeId: type.id,
      categoryId: catalog.categories.find((c) => c.typeIds.includes(type.id))!.id,
    };
    const inOrg = <T>(work: Parameters<typeof withMember<T>>[2]) =>
      withMember(app.db, self(org), work);
    const fare = await expenseFrom(org, {
      merchant: 'Delta',
      transactionDate: '2026-09-12',
      currency: 'USD',
      amountMinor: 40_220,
    });
    const ride = await expenseFrom(org, {
      merchant: 'Lyft',
      transactionDate: '2026-09-27',
      currency: 'USD',
      amountMinor: 1840,
    });
    // The ride's report went in before the statement came: its claim stays as submitted.
    await withOrg(app.db, org.orgId, (tx) =>
      tx
        .update(expenses)
        .set({ status: 'submitted' })
        .where(sql`${expenses.id} = ${ride}`),
    );
    const { id } = await statementFor(org);
    await withOrg(app.db, org.orgId, (tx) =>
      settleCardStatement(tx, org.orgId, id, read(SEPTEMBER)),
    );
    expect(await payers(org, [fare, ride])).toEqual(['company', 'claimant']);

    // Typed as airfare, and the company paying no airfare, it is still the card's.
    await inOrg((tx) => classifyExpense(tx, org.orgId, fare, airfare, org.userId));
    const by = { memberId: org.memberId, userId: org.userId };
    await withOrg(app.db, org.orgId, (tx) =>
      setTypeCompanyPays(tx, org.orgId, airfare.typeId, true, by),
    );
    await withOrg(app.db, org.orgId, (tx) =>
      setTypeCompanyPays(tx, org.orgId, airfare.typeId, false, by),
    );
    expect(await payers(org, [fare])).toEqual(['company']);
  });

  it('matches a charge only to an expense with its receipt, so a matched charge is always documented', async () => {
    const org = await seedOrg(app.db, 'card-receipt-needed');
    const inOrg = <T>(work: Parameters<typeof withMember<T>>[2]) =>
      withMember(app.db, self(org), work);
    // An expense with no receipt, as a drive or one typed in has none.
    const typedIn = newId();
    await withOrg(app.db, org.orgId, (tx) =>
      tx.insert(expenses).values({
        id: typedIn,
        orgId: org.orgId,
        memberId: org.memberId,
        status: 'ready',
        source: 'manual',
        merchant: 'Lyft',
        transactionDate: '2026-09-27',
        amountMinor: 1840,
        currency: 'USD',
      }),
    );
    const { id } = await statementFor(org);
    await withOrg(app.db, org.orgId, (tx) =>
      settleCardStatement(tx, org.orgId, id, read(SEPTEMBER)),
    );
    const lyft = (await inOrg((tx) => missingReceipts(tx, org.memberId))).find((t) =>
      t.merchant.startsWith('LYFT'),
    )!;
    // Not matched on its own, not offered, and refused by hand: it stays a missing receipt.
    expect(lyft).toBeDefined();
    expect(
      (await inOrg((tx) => matchableExpenses(tx, org.memberId, '2026-09-27'))).map((e) => e.id),
    ).not.toContain(typedIn);
    expect(
      await inOrg((tx) => matchCardTransactionTo(tx, org.orgId, lyft.id, typedIn, org.userId)),
    ).toEqual({ status: 'not_matchable' });
    expect((await inOrg((tx) => missingReceipts(tx, org.memberId))).map((t) => t.id)).toContain(
      lyft.id,
    );
  });
});
