import {
  money,
  newId,
  type Itemization,
  type LineKind,
  type MemberRole,
} from '@expensewise/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { isOwnRecordsRefusal, withMember, withOrg } from '../src/client.ts';
import { listCatalog, seedStarterCatalog } from '../src/categories.ts';
import { editExpense, getExpense, type ReceiptOffer } from '../src/expenses.ts';
import {
  excludeLine,
  excludePurchase,
  includeLine,
  includePurchase,
  itemizationsOf,
  partsOf,
  reportCategories,
  splitExpense,
  unsplitExpense,
} from '../src/itemized.ts';
import { fileReceipt, requestReceiptReading, settleReceipt } from '../src/receipts.ts';
import { reportForExport } from '../src/report-export.ts';
import {
  auditEvents,
  expenseLines,
  expenseParts,
  expenses,
  members,
  receipts,
  reports,
} from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

const usd = (cents: number) => money(cents, 'USD');
const line = (kind: LineKind, description: string, cents: number) => ({
  kind,
  description,
  quantity: null,
  amount: usd(cents),
});

/** A hotel folio: the room, the minibar and room service, with its tax and a resort fee. */
const FOLIO: Itemization = {
  currency: 'USD',
  subtotal: usd(96_150),
  total: usd(110_400),
  lines: [
    line('item', 'Room, 3 nights', 89_700),
    line('item', 'Minibar', 1850),
    line('item', 'Room service', 4600),
    line('tax', 'Occupancy tax', 12_495),
    line('fee', 'Resort fee', 1755),
  ],
};
const STAY: ReceiptOffer = {
  merchant: 'Hotel Lindley',
  transactionDate: '2026-10-01',
  currency: 'USD',
  amountMinor: 110_400,
};

type Org = Awaited<ReturnType<typeof seedOrg>>;
let files = 0x77_0000;
const owned = (org: Org) => ({ orgId: org.orgId, memberId: org.memberId, role: 'owner' as const });

/** Files a receipt for `memberId` and settles a reading of it with its lines, as the workflow does. */
async function read(
  org: Org,
  lines: Itemization | null,
  offer: ReceiptOffer = STAY,
  receiptId = newId(),
  memberId = org.memberId,
): Promise<string> {
  const requestId = await withOrg(app.db, org.orgId, async (tx) => {
    const [known] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
    if (known) return (await requestReceiptReading(tx, org.orgId, receiptId, org.userId))!.outboxId;
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
        sha256: (++files).toString(16).padStart(64, 'c'),
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
      lines,
    }),
  );
  return receiptId;
}

const expenseIdOf = (org: Org, receiptId: string) =>
  withOrg(app.db, org.orgId, async (tx) => {
    const [r] = await tx.select().from(receipts).where(eq(receipts.id, receiptId));
    return r!.expenseId!;
  });

const linesOf = async (org: Org, expenseId: string) =>
  (await withOrg(app.db, org.orgId, (tx) => itemizationsOf(tx, [expenseId])))[0];
const amountOf = async (org: Org, expenseId: string) =>
  (await withOrg(app.db, org.orgId, (tx) => getExpense(tx, expenseId)))?.amountMinor;
const actions = (org: Org, expenseId: string) =>
  withOrg(app.db, org.orgId, async (tx) =>
    (
      await tx
        .select({ action: auditEvents.action })
        .from(auditEvents)
        .where(eq(auditEvents.entityId, expenseId))
        .orderBy(auditEvents.sequence)
    ).map((e) => e.action),
  );

/** A member of `org` with `role`, added by the system as an accepted invite would. */
async function addMember(org: Org, name: string, role: MemberRole) {
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

async function withCatalog(name: string) {
  const org = await seedOrg(app.db, name);
  await withOrg(app.db, org.orgId, (tx) => seedStarterCatalog(tx, org.orgId));
  const catalog = await withOrg(app.db, org.orgId, (tx) => listCatalog(tx));
  const pick = (category: string, type: string) => ({
    categoryId: catalog.categories.find((c) => c.name === category)!.id,
    typeId: catalog.types.find((t) => t.name === type)!.id,
  });
  return { org, meals: pick('Meals', 'Business meal'), lodging: pick('Travel', 'Lodging') };
}

describe('a receipt’s lines on its expense (FR-INT-22, ADR-0041)', () => {
  it('copies a reading’s lines onto its expense, and a new reading replaces them', async () => {
    const org = await seedOrg(app.db, 'lines-copy');
    const receipt = await read(org, FOLIO);
    const expenseId = await expenseIdOf(org, receipt);
    const copied = await linesOf(org, expenseId);
    expect(
      copied?.lines.map((l) => [l.position, l.kind, l.description, l.amount.amountMinor]),
    ).toEqual([
      [1, 'item', 'Room, 3 nights', 89_700],
      [2, 'item', 'Minibar', 1850],
      [3, 'item', 'Room service', 4600],
      [4, 'tax', 'Occupancy tax', 12_495],
      [5, 'fee', 'Resort fee', 1755],
    ]);
    expect(copied).toMatchObject({ total: usd(110_400), subtotal: usd(96_150) });

    const fewer = {
      ...FOLIO,
      lines: FOLIO.lines.slice(0, 2),
      subtotal: usd(91_550),
      total: usd(91_550),
    };
    await read(org, fewer, { ...STAY, amountMinor: 91_550 }, receipt);
    expect((await linesOf(org, expenseId))?.lines).toHaveLength(2);
    // A reading that prints no lines takes them away; the same lines again record nothing.
    await read(org, null, STAY, receipt);
    expect(await linesOf(org, expenseId)).toBeUndefined();
    await read(org, null, STAY, receipt);
    expect((await actions(org, expenseId)).filter((a) => a === 'expense.lines_read')).toHaveLength(
      3,
    );
  });

  it('keeps the lines as they were once a person excludes one, whatever is read after', async () => {
    const org = await seedOrg(app.db, 'lines-kept');
    const receipt = await read(org, FOLIO);
    const expenseId = await expenseIdOf(org, receipt);
    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        excludeLine(tx, org.orgId, expenseId, 2, { reason: 'personal' }, org.userId),
      ),
    ).toEqual({ status: 'changed' });
    await read(
      org,
      { ...FOLIO, lines: FOLIO.lines.slice(0, 1) },
      { ...STAY, amountMinor: 1 },
      receipt,
    );
    expect((await linesOf(org, expenseId))?.lines).toHaveLength(5);
    expect(await amountOf(org, expenseId)).toBe(108_276);
  });
});

describe('excluding a line (FR-EXP-16)', () => {
  it('drops the claim by the line and its share, with its reason, and includes it again', async () => {
    const org = await seedOrg(app.db, 'lines-exclude');
    const expenseId = await expenseIdOf(org, await read(org, FOLIO));
    const inOrg = <T>(work: Parameters<typeof withMember<T>>[2]) =>
      withMember(app.db, owned(org), work);
    expect(
      await inOrg((tx) =>
        excludeLine(tx, org.orgId, expenseId, 2, { reason: 'other', note: ' ' }, org.userId),
      ),
    ).toEqual({ status: 'invalid', problem: 'note_needed' });
    expect(
      await inOrg((tx) =>
        excludeLine(tx, org.orgId, expenseId, 4, { reason: 'personal' }, org.userId),
      ),
    ).toEqual({ status: 'invalid', problem: 'not_an_item' });
    expect(
      await inOrg((tx) =>
        excludeLine(
          tx,
          org.orgId,
          expenseId,
          2,
          { reason: 'personal', note: 'Snacks' },
          org.userId,
        ),
      ),
    ).toEqual({ status: 'changed' });
    expect(await amountOf(org, expenseId)).toBe(110_400 - 2124);
    expect((await linesOf(org, expenseId))?.lines[1]?.excluded).toMatchObject({
      reason: 'personal',
      note: 'Snacks',
    });
    // The same again changes nothing; a new reason is taken without changing the claim.
    expect(
      await inOrg((tx) =>
        excludeLine(
          tx,
          org.orgId,
          expenseId,
          2,
          { reason: 'personal', note: 'Snacks' },
          org.userId,
        ),
      ),
    ).toEqual({ status: 'unchanged' });
    expect(
      await inOrg((tx) =>
        excludeLine(tx, org.orgId, expenseId, 2, { reason: 'paid_by_someone_else' }, org.userId),
      ),
    ).toEqual({ status: 'changed' });
    expect(await amountOf(org, expenseId)).toBe(108_276);

    expect(await inOrg((tx) => includeLine(tx, org.orgId, expenseId, 2, org.userId))).toEqual({
      status: 'changed',
    });
    expect(await amountOf(org, expenseId)).toBe(110_400);
    expect(await inOrg((tx) => includeLine(tx, org.orgId, expenseId, 2, org.userId))).toEqual({
      status: 'unchanged',
    });
    const trail = await withOrg(app.db, org.orgId, (tx) =>
      tx
        .select({ action: auditEvents.action, payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.entityId, expenseId))
        .orderBy(auditEvents.sequence),
    );
    expect(trail.map((e) => e.action)).toEqual([
      'expense.created',
      'expense.lines_read',
      'expense.filed',
      'expense.line_excluded',
      'expense.line_excluded',
      'expense.line_included',
    ]);
    expect(trail[3]?.payload).toMatchObject({
      position: 2,
      line: 'Minibar',
      reason: 'personal',
      note: 'Snacks',
      takesOff: 2124,
      claimed: 108_276,
      previousClaim: 110_400,
    });
  });

  it('refuses while the lines don’t add up, or don’t make up what the expense claims', async () => {
    const org = await seedOrg(app.db, 'lines-unusable');
    const short = await expenseIdOf(org, await read(org, { ...FOLIO, subtotal: usd(90_000) }));
    const exclude = (expenseId: string) =>
      withOrg(app.db, org.orgId, (tx) =>
        excludeLine(tx, org.orgId, expenseId, 2, { reason: 'personal' }, org.userId),
      );
    expect(await exclude(short)).toEqual({ status: 'not_usable', problem: 'lines_dont_add_up' });
    const edited = await expenseIdOf(org, await read(org, FOLIO));
    await withOrg(app.db, org.orgId, (tx) =>
      editExpense(tx, org.orgId, edited, { amount: '1000.00' }, org.userId),
    );
    expect(await exclude(edited)).toEqual({ status: 'not_usable', problem: 'amount_changed' });
    const plain = await expenseIdOf(org, await read(org, null));
    expect(await exclude(plain)).toEqual({ status: 'not_itemized' });
    // An expense filed before lines were copied takes its reading's lines first.
    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        excludeLine(tx, org.orgId, plain, 2, { reason: 'personal' }, org.userId, FOLIO),
      ),
    ).toEqual({ status: 'changed' });
    expect(await amountOf(org, plain)).toBe(108_276);
  });

  it('refuses an amount or currency edit while the claim is made of its lines', async () => {
    const org = await seedOrg(app.db, 'lines-edit');
    const expenseId = await expenseIdOf(org, await read(org, FOLIO));
    const edit = (change: Parameters<typeof editExpense>[3]) =>
      withOrg(app.db, org.orgId, (tx) => editExpense(tx, org.orgId, expenseId, change, org.userId));
    await withOrg(app.db, org.orgId, (tx) =>
      excludeLine(tx, org.orgId, expenseId, 2, { reason: 'personal' }, org.userId),
    );
    expect(await edit({ amount: '1104.00' })).toEqual({ status: 'itemized' });
    expect(await edit({ currency: 'EUR' })).toEqual({ status: 'itemized' });
    expect((await edit({ merchant: 'The Lindley' })).status).toBe('edited');
  });

  it('holds an excluded line to a reason, and other to a note, in the database too', async () => {
    const org = await seedOrg(app.db, 'lines-checks');
    const expenseId = await expenseIdOf(org, await read(org, FOLIO));
    const set = (values: Partial<typeof expenseLines.$inferInsert>, position = 2) =>
      withOrg(app.db, org.orgId, (tx) =>
        tx
          .update(expenseLines)
          .set(values)
          .where(
            sql`${expenseLines.expenseId} = ${expenseId} and ${expenseLines.position} = ${position}`,
          ),
      );
    await expectDbError(
      set({ excludedReason: 'other', excludedNote: null, excludedAt: new Date() }),
      /expense_lines_other_needs_note/,
    );
    await expectDbError(set({ excludedNote: 'why' }), /expense_lines_excluded_whole/);
    await expectDbError(
      set({ excludedReason: 'personal', excludedAt: new Date() }, 4),
      /expense_lines_items_only/,
    );
  });
});

describe('splitting an expense into parts (FR-EXP-15)', () => {
  it('splits by line, the lines left keeping the expense’s own, and works it out again on an exclusion', async () => {
    const { org, meals } = await withCatalog('split-lines');
    const expenseId = await expenseIdOf(org, await read(org, FOLIO));
    const inOrg = <T>(work: Parameters<typeof withMember<T>>[2]) =>
      withMember(app.db, owned(org), work);
    expect(
      await inOrg((tx) =>
        splitExpense(
          tx,
          org.orgId,
          expenseId,
          { basis: 'lines', lines: [{ position: 3, ...meals }] },
          org.userId,
        ),
      ),
    ).toEqual({ status: 'changed' });
    const parts = await inOrg((tx) => partsOf(tx, [expenseId]));
    expect(parts.map((p) => [p.basis, p.category, p.type, p.amountMinor])).toEqual([
      ['lines', null, null, 105_119],
      ['lines', 'Meals', 'Business meal', 5281],
    ]);
    // The minibar excluded: the parts are worked out again and still add up to the claim.
    await inOrg((tx) =>
      excludeLine(tx, org.orgId, expenseId, 2, { reason: 'personal' }, org.userId),
    );
    const after = await inOrg((tx) => partsOf(tx, [expenseId]));
    expect(after.map((p) => p.amountMinor)).toEqual([102_995, 5281]);
    expect(after.reduce((a, p) => a + p.amountMinor, 0)).toBe(await amountOf(org, expenseId));
    // A category in a split is in use, so it can be retired but not deleted.
    const catalog = await inOrg((tx) => listCatalog(tx));
    expect(catalog.categories.find((c) => c.id === meals.categoryId)?.inUse).toBe(true);

    expect(await inOrg((tx) => unsplitExpense(tx, org.orgId, expenseId, org.userId))).toEqual({
      status: 'changed',
    });
    expect(await inOrg((tx) => partsOf(tx, [expenseId]))).toEqual([]);
    expect(await inOrg((tx) => unsplitExpense(tx, org.orgId, expenseId, org.userId))).toEqual({
      status: 'unchanged',
    });
    expect((await actions(org, expenseId)).slice(-3)).toEqual([
      'expense.split',
      'expense.line_excluded',
      'expense.split_removed',
    ]);
  });

  it('splits by amount, refusing parts that don’t add up to the claim, and refuses an exclusion while so split', async () => {
    const { org, meals, lodging } = await withCatalog('split-amounts');
    const expenseId = await expenseIdOf(org, await read(org, FOLIO));
    const split = (parts: { amount: string; categoryId: string; typeId: string }[]) =>
      withOrg(app.db, org.orgId, (tx) =>
        splitExpense(tx, org.orgId, expenseId, { basis: 'amounts', parts }, org.userId),
      );
    expect(
      await split([
        { ...lodging, amount: '1000.00' },
        { ...meals, amount: '100.00' },
      ]),
    ).toEqual({
      status: 'invalid',
      problem: 'parts_dont_add_up',
    });
    expect(
      await split([
        { ...lodging, amount: '1000.00' },
        { ...meals, typeId: lodging.typeId, amount: '104.00' },
      ]),
    ).toEqual({ status: 'invalid', problem: 'type_not_allowed', index: 1 });
    expect(
      await split([
        { ...lodging, amount: '1000.00' },
        { ...meals, amount: '104.00' },
      ]),
    ).toEqual({
      status: 'changed',
    });
    expect(
      (await withOrg(app.db, org.orgId, (tx) => partsOf(tx, [expenseId]))).map((p) => [
        p.basis,
        p.amountMinor,
      ]),
    ).toEqual([
      ['amounts', 100_000],
      ['amounts', 10_400],
    ]);
    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        excludeLine(tx, org.orgId, expenseId, 2, { reason: 'personal' }, org.userId),
      ),
    ).toEqual({ status: 'split_by_amount' });
    // The parts add up in the database too: none is zero or less.
    await expectDbError(
      withOrg(app.db, org.orgId, (tx) =>
        tx
          .update(expenseParts)
          .set({ amountMinor: 0 })
          .where(eq(expenseParts.expenseId, expenseId)),
      ),
      /expense_parts_amount_positive/,
    );
    // A drive is paid at miles × its rate, changed as mileage, so it isn't split.
    const drive = newId();
    await withOrg(app.db, org.orgId, (tx) =>
      tx.insert(expenses).values({
        id: drive,
        orgId: org.orgId,
        memberId: org.memberId,
        status: 'ready',
        source: 'mileage',
        merchant: 'Eppley Airfield',
        transactionDate: '2026-09-29',
        currency: 'USD',
        amountMinor: 2784,
      }),
    );
    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        splitExpense(
          tx,
          org.orgId,
          drive,
          {
            basis: 'amounts',
            parts: [
              { ...lodging, amount: '20.00' },
              { ...meals, amount: '7.84' },
            ],
          },
          org.userId,
        ),
      ),
    ).toEqual({ status: 'mileage' });
  });

  it('totals a report by category and type, and exports a row per part with the excluded lines', async () => {
    const { org, meals } = await withCatalog('split-report');
    const expenseId = await expenseIdOf(org, await read(org, FOLIO));
    const inOrg = <T>(work: Parameters<typeof withMember<T>>[2]) =>
      withMember(app.db, owned(org), work);
    await inOrg((tx) =>
      splitExpense(
        tx,
        org.orgId,
        expenseId,
        { basis: 'lines', lines: [{ position: 3, ...meals }] },
        org.userId,
      ),
    );
    await inOrg((tx) =>
      excludeLine(tx, org.orgId, expenseId, 2, { reason: 'personal' }, org.userId),
    );
    const reportId = await withOrg(app.db, org.orgId, async (tx) => {
      const [made] = await tx
        .insert(reports)
        .values({
          orgId: org.orgId,
          memberId: org.memberId,
          title: 'October',
          currency: 'USD',
          status: 'closed',
          closedAt: new Date(),
          closesAt: new Date('2026-11-01T00:00:00Z'),
        })
        .returning({ id: reports.id });
      await tx.update(expenses).set({ reportId: made!.id }).where(eq(expenses.id, expenseId));
      return made!.id;
    });
    const counted = await inOrg((tx) => reportCategories(tx, [reportId]));
    expect(counted).toHaveLength(1);
    expect(counted[0]?.parts.map((p) => [p.category, p.amountMinor])).toEqual([
      [null, 102_995],
      ['Meals', 5281],
    ]);
    const exported = await inOrg((tx) => reportForExport(tx, reportId));
    expect(exported?.expenses[0]).toMatchObject({
      amountMinor: 108_276,
      parts: [
        { category: null, type: null, amountMinor: 102_995 },
        { category: 'Meals', type: 'Business meal', amountMinor: 5281 },
      ],
      excluded: [{ line: 'Minibar', amountMinor: 2124, reason: 'personal', note: null }],
    });
  });
});

describe('whose lines and parts they are, and when they are locked (ADR-0035)', () => {
  it('keeps each member’s lines and parts to that member; others see them only by their role', async () => {
    const { org, meals } = await withCatalog('lines-own');
    const sam = await addMember(org, 'sam', 'member');
    const finance = await addMember(org, 'fin', 'finance_admin');
    const receipt = await read(org, FOLIO, STAY, newId(), sam.memberId);
    const expenseId = await expenseIdOf(org, receipt);
    expect(
      await withMember(app.db, sam, (tx) =>
        splitExpense(
          tx,
          org.orgId,
          expenseId,
          { basis: 'lines', lines: [{ position: 3, ...meals }] },
          sam.userId,
        ),
      ),
    ).toEqual({ status: 'changed' });
    // The owner's own work: nothing of Sam's shows to a member, everything to finance.
    const other = await addMember(org, 'alex', 'member');
    expect(await withMember(app.db, other, (tx) => itemizationsOf(tx, [expenseId]))).toEqual([]);
    expect(await withMember(app.db, other, (tx) => partsOf(tx, [expenseId]))).toEqual([]);
    expect(
      await withMember(app.db, other, (tx) =>
        excludeLine(tx, org.orgId, expenseId, 2, { reason: 'personal' }, other.userId),
      ),
    ).toEqual({ status: 'missing' });
    expect(await withMember(app.db, finance, (tx) => itemizationsOf(tx, [expenseId]))).toHaveLength(
      1,
    );
    expect(await withMember(app.db, finance, (tx) => partsOf(tx, [expenseId]))).toHaveLength(2);
    const refused = await withMember(app.db, finance, (tx) =>
      excludeLine(tx, org.orgId, expenseId, 2, { reason: 'personal' }, finance.userId),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isOwnRecordsRefusal(refused)).toBe(true);
    expect(await amountOf(org, expenseId)).toBe(110_400);
  });

  it('locks a submitted claim’s lines and split, and a new reading leaves them as they were', async () => {
    const { org, meals } = await withCatalog('lines-locked');
    const receipt = await read(org, FOLIO);
    const expenseId = await expenseIdOf(org, receipt);
    await withOrg(app.db, org.orgId, (tx) =>
      tx.update(expenses).set({ status: 'submitted' }).where(eq(expenses.id, expenseId)),
    );
    const inOrg = <T>(work: Parameters<typeof withMember<T>>[2]) =>
      withMember(app.db, owned(org), work);
    expect(
      await inOrg((tx) =>
        excludeLine(tx, org.orgId, expenseId, 2, { reason: 'personal' }, org.userId),
      ),
    ).toEqual({ status: 'not_editable', current: 'submitted' });
    expect(
      await inOrg((tx) =>
        splitExpense(
          tx,
          org.orgId,
          expenseId,
          { basis: 'lines', lines: [{ position: 3, ...meals }] },
          org.userId,
        ),
      ),
    ).toEqual({ status: 'not_editable', current: 'submitted' });
    expect(await inOrg((tx) => includeLine(tx, org.orgId, expenseId, 2, org.userId))).toEqual({
      status: 'not_editable',
      current: 'submitted',
    });
    await read(org, null, STAY, receipt);
    expect((await linesOf(org, expenseId))?.lines).toHaveLength(5);
  });

  it('deletes an expense’s lines and parts with its receipt', async () => {
    const { org, meals } = await withCatalog('lines-delete');
    const receipt = await read(org, FOLIO);
    const expenseId = await expenseIdOf(org, receipt);
    await withMember(app.db, owned(org), (tx) =>
      splitExpense(
        tx,
        org.orgId,
        expenseId,
        { basis: 'lines', lines: [{ position: 3, ...meals }] },
        org.userId,
      ),
    );
    await withMember(app.db, owned(org), (tx) =>
      tx.execute(sql`select * from delete_receipt(${receipt}::uuid)`),
    );
    const left = await owner.db.execute<{ n: number }>(sql`
      select (select count(*) from expense_lines where expense_id = ${expenseId}::uuid)
           + (select count(*) from expense_parts where expense_id = ${expenseId}::uuid)
           + (select count(*) from expense_itemizations where expense_id = ${expenseId}::uuid) as n`);
    expect(Number(left.rows[0]?.n)).toBe(0);
  });
});

/**
 * An airline receipt of two purchases (FR-INT-23, Q49): the ticket, bought Sep 12 on one card,
 * and a seat upgrade bought Sep 30 on a personal card, each with its own taxes and fees.
 */
const of = (purchase: number, l: ReturnType<typeof line>) => ({ ...l, purchase });
const AIRFARE: Itemization = {
  currency: 'USD',
  subtotal: null,
  total: usd(48_713),
  purchases: [
    { description: 'Ticket', date: '2026-09-12', cardLastFour: '4417', total: usd(40_220) },
    { description: 'Seat upgrade', date: '2026-09-30', cardLastFour: '9921', total: usd(8493) },
  ],
  lines: [
    of(1, line('item', 'Airfare', 36_000)),
    of(1, line('tax', 'US transportation tax', 2700)),
    of(1, line('fee', 'September 11 security fee', 560)),
    of(1, line('fee', 'Passenger facility charge', 960)),
    of(2, line('item', 'Economy Plus', 7900)),
    of(2, line('tax', 'US transportation tax', 593)),
  ],
};
const FLIGHT: ReceiptOffer = {
  merchant: 'Example Air',
  transactionDate: '2026-09-12',
  currency: 'USD',
  amountMinor: 48_713,
};

describe('a receipt of several purchases (FR-INT-23, FR-EXP-20, Q49)', () => {
  it('copies each purchase with its lines, and a reading of one purchase takes them away', async () => {
    const org = await seedOrg(app.db, 'purchases-copy');
    const receipt = await read(org, AIRFARE, FLIGHT);
    const expenseId = await expenseIdOf(org, receipt);
    const copied = await linesOf(org, expenseId);
    expect(copied?.purchases).toEqual(AIRFARE.purchases);
    expect(copied?.lines.map((l) => [l.position, l.purchase, l.description])).toEqual([
      [1, 1, 'Airfare'],
      [2, 1, 'US transportation tax'],
      [3, 1, 'September 11 security fee'],
      [4, 1, 'Passenger facility charge'],
      [5, 2, 'Economy Plus'],
      [6, 2, 'US transportation tax'],
    ]);
    // The same purchases again record nothing; the ticket alone replaces them.
    await read(org, AIRFARE, FLIGHT, receipt);
    const ticket: Itemization = {
      currency: 'USD',
      subtotal: null,
      total: usd(40_220),
      lines: AIRFARE.lines.slice(0, 4).map(({ purchase: _, ...l }) => l),
    };
    await read(org, ticket, { ...FLIGHT, amountMinor: 40_220 }, receipt);
    const after = await linesOf(org, expenseId);
    expect(after?.purchases).toBeUndefined();
    expect(after?.lines.every((l) => l.purchase === null)).toBe(true);
    const left = await owner.db.execute<{ n: number }>(
      sql`select count(*) as n from expense_purchases where expense_id = ${expenseId}::uuid`,
    );
    expect(Number(left.rows[0]?.n)).toBe(0);
    expect((await actions(org, expenseId)).filter((a) => a === 'expense.lines_read')).toHaveLength(
      2,
    );
  });

  it('leaves out the seat upgrade with its own taxes, as one change, and includes it again', async () => {
    const org = await seedOrg(app.db, 'purchases-exclude');
    const expenseId = await expenseIdOf(org, await read(org, AIRFARE, FLIGHT));
    const inOrg = <T>(work: Parameters<typeof withMember<T>>[2]) =>
      withMember(app.db, owned(org), work);
    expect(
      await inOrg((tx) =>
        excludePurchase(tx, org.orgId, expenseId, 3, { reason: 'personal' }, org.userId),
      ),
    ).toEqual({ status: 'invalid', problem: 'no_such_purchase' });
    expect(
      await inOrg((tx) =>
        excludePurchase(
          tx,
          org.orgId,
          expenseId,
          2,
          { reason: 'personal', note: 'Paid on my own card' },
          org.userId,
        ),
      ),
    ).toEqual({ status: 'changed' });
    // The ticket and its own taxes and fees stay claimed; none of them went with the upgrade.
    expect(await amountOf(org, expenseId)).toBe(40_220);
    const lines = await linesOf(org, expenseId);
    expect(lines?.lines.filter((l) => l.excluded).map((l) => l.position)).toEqual([5]);
    expect(
      await inOrg((tx) =>
        excludePurchase(
          tx,
          org.orgId,
          expenseId,
          2,
          { reason: 'personal', note: 'Paid on my own card' },
          org.userId,
        ),
      ),
    ).toEqual({ status: 'unchanged' });
    expect(await inOrg((tx) => includePurchase(tx, org.orgId, expenseId, 2, org.userId))).toEqual({
      status: 'changed',
    });
    expect(await amountOf(org, expenseId)).toBe(48_713);
    const trail = await withOrg(app.db, org.orgId, (tx) =>
      tx
        .select({ action: auditEvents.action, payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.entityId, expenseId))
        .orderBy(auditEvents.sequence),
    );
    expect(trail.map((e) => e.action).slice(-2)).toEqual([
      'expense.purchase_excluded',
      'expense.purchase_included',
    ]);
    expect(trail.at(-2)?.payload).toMatchObject({
      purchase: 2,
      description: 'Seat upgrade',
      lines: [5],
      reason: 'personal',
      note: 'Paid on my own card',
      takesOff: 8493,
      claimed: 40_220,
      previousClaim: 48_713,
    });
  });

  it('refuses a purchase on a receipt of one, and keeps a member’s purchases to them', async () => {
    const org = await seedOrg(app.db, 'purchases-own');
    const folio = await expenseIdOf(org, await read(org, FOLIO));
    expect(
      await withMember(app.db, owned(org), (tx) =>
        excludePurchase(tx, org.orgId, folio, 1, { reason: 'personal' }, org.userId),
      ),
    ).toEqual({ status: 'invalid', problem: 'no_such_purchase' });

    const sam = await addMember(org, 'sam', 'member');
    const other = await addMember(org, 'alex', 'member');
    const expenseId = await expenseIdOf(
      org,
      await read(org, AIRFARE, FLIGHT, newId(), sam.memberId),
    );
    expect(await withMember(app.db, other, (tx) => itemizationsOf(tx, [expenseId]))).toEqual([]);
    const seen = await withMember(app.db, other, (tx) =>
      tx.execute(
        sql`select count(*) as n from expense_purchases where expense_id = ${expenseId}::uuid`,
      ),
    );
    expect(Number((seen.rows[0] as { n: number }).n)).toBe(0);
    expect(
      await withMember(app.db, other, (tx) =>
        excludePurchase(tx, org.orgId, expenseId, 2, { reason: 'personal' }, other.userId),
      ),
    ).toEqual({ status: 'missing' });
    expect(
      await withMember(app.db, sam, (tx) =>
        excludePurchase(tx, org.orgId, expenseId, 2, { reason: 'personal' }, sam.userId),
      ),
    ).toEqual({ status: 'changed' });
    await withOrg(app.db, org.orgId, (tx) =>
      tx.update(expenses).set({ status: 'submitted' }).where(eq(expenses.id, expenseId)),
    );
    expect(
      await withMember(app.db, sam, (tx) =>
        includePurchase(tx, org.orgId, expenseId, 2, sam.userId),
      ),
    ).toEqual({ status: 'not_editable', current: 'submitted' });
  });

  it('exports the purchase left out, line by line with its own taxes, and deletes it with its receipt', async () => {
    const org = await seedOrg(app.db, 'purchases-export');
    const receipt = await read(org, AIRFARE, FLIGHT);
    const expenseId = await expenseIdOf(org, receipt);
    await withMember(app.db, owned(org), (tx) =>
      excludePurchase(tx, org.orgId, expenseId, 2, { reason: 'personal' }, org.userId),
    );
    const reportId = await withOrg(app.db, org.orgId, async (tx) => {
      const [made] = await tx
        .insert(reports)
        .values({
          orgId: org.orgId,
          memberId: org.memberId,
          title: 'September',
          currency: 'USD',
          status: 'closed',
          closedAt: new Date(),
          closesAt: new Date('2026-10-01T00:00:00Z'),
        })
        .returning({ id: reports.id });
      await tx.update(expenses).set({ reportId: made!.id }).where(eq(expenses.id, expenseId));
      return made!.id;
    });
    const exported = await withMember(app.db, owned(org), (tx) => reportForExport(tx, reportId));
    expect(exported?.expenses[0]).toMatchObject({
      amountMinor: 40_220,
      excluded: [{ line: 'Economy Plus', amountMinor: 8493, reason: 'personal', note: null }],
    });
    await withMember(app.db, owned(org), (tx) =>
      tx.execute(sql`select * from delete_receipt(${receipt}::uuid)`),
    );
    const left = await owner.db.execute<{ n: number }>(sql`
      select (select count(*) from expense_lines where expense_id = ${expenseId}::uuid)
           + (select count(*) from expense_purchases where expense_id = ${expenseId}::uuid) as n`);
    expect(Number(left.rows[0]?.n)).toBe(0);
  });
});
