import {
  duplicateKind,
  mergeExpenses,
  money,
  toDecimal,
  type ExpenseSource,
  type ExpenseStatus,
  type MergeableExpense,
  type MergeField,
} from '@expensewise/domain';
import { and, asc, eq, inArray, isNull, ne, or, sql, type SQLWrapper } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { fileReceiptExpense } from './expenses.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import type { ReceiptStatus } from './receipts.ts';
import { expenses, receiptDuplicates, receipts, trips } from './schema.ts';
import { fileExpenseToTrip } from './trips.ts';

const WORKFLOW: AuditEntry['actor'] = { type: 'system', id: 'receipt-workflow' };

/** The receipts a duplicate check compares with: read, and not being read again. */
const COMPARABLE: ReceiptStatus[] = ['extracted', 'needs_review'];

/** When and where an expense was bought, as a duplicate check compares them (ADR-0031). */
const placeSelection = {
  time: expenses.transactionTime,
  address: expenses.merchantAddress,
  city: expenses.merchantCity,
  country: expenses.merchantCountry,
};

async function expenseOfReceipt(tx: Transaction, orgId: string, receiptId: string) {
  const [row] = await tx
    .select({
      receiptId: receipts.id,
      memberId: receipts.memberId,
      receiptStatus: receipts.status,
      storageKey: receipts.storageKey,
      sha256: receipts.sha256,
      createdAt: receipts.createdAt,
      expenseId: expenses.id,
      expenseStatus: expenses.status,
      merchant: expenses.merchant,
      transactionDate: expenses.transactionDate,
      currency: expenses.currency,
      amountMinor: expenses.amountMinor,
      notes: expenses.notes,
      tripId: expenses.tripId,
      ...placeSelection,
    })
    .from(receipts)
    .leftJoin(
      expenses,
      and(eq(expenses.orgId, receipts.orgId), eq(expenses.id, receipts.expenseId)),
    )
    .where(and(eq(receipts.orgId, orgId), eq(receipts.id, receiptId)));
  return row;
}

/** Puts a receipt back to what its reading settled to, once nothing holds it any more. */
async function release(
  tx: Transaction,
  orgId: string,
  receiptId: string,
  settledStatus: ReceiptStatus,
  actor: AuditEntry['actor'],
) {
  const [stillHeld] = await tx
    .select({ id: receiptDuplicates.id })
    .from(receiptDuplicates)
    .where(
      and(
        eq(receiptDuplicates.orgId, orgId),
        eq(receiptDuplicates.receiptId, receiptId),
        eq(receiptDuplicates.state, 'open'),
      ),
    )
    .limit(1);
  if (stillHeld) return;
  await tx
    .update(receipts)
    .set({ status: settledStatus })
    .where(and(eq(receipts.orgId, orgId), eq(receipts.id, receiptId)));
  await fileReceiptExpense(tx, orgId, receiptId, null, actor);
}

/**
 * Compares a receipt that has just been read with its member's other receipts dated a day
 * either way (FR-INT-18, ADR-0028, ADR-0031). When two are one purchase, exactly or possibly,
 * the later of them is held: it needs a look, whatever its reading settled to, until the
 * person decides. Returns the receipt it matches. A receipt already held stays held,
 * remembering its new reading. A pair the person dismissed is never flagged again.
 * Call after its expense is filed, in the same transaction; it never relies on row-level
 * security, so the release can run it as the schema owner.
 */
export async function checkForDuplicate(
  tx: Transaction,
  orgId: string,
  receiptId: string,
  settledStatus: ReceiptStatus,
  actor: AuditEntry['actor'] = WORKFLOW,
): Promise<string | undefined> {
  await tx
    .update(receipts)
    .set({ duplicatesCheckedAt: new Date() })
    .where(and(eq(receipts.orgId, orgId), eq(receipts.id, receiptId)));
  if (settledStatus === 'failed' || settledStatus === 'processing') return undefined;

  const [held] = await tx
    .update(receiptDuplicates)
    .set({ settledStatus })
    .where(
      and(
        eq(receiptDuplicates.orgId, orgId),
        eq(receiptDuplicates.receiptId, receiptId),
        eq(receiptDuplicates.state, 'open'),
      ),
    )
    .returning({ otherReceiptId: receiptDuplicates.otherReceiptId });
  if (held) {
    await tx
      .update(receipts)
      .set({ status: 'needs_review' })
      .where(and(eq(receipts.orgId, orgId), eq(receipts.id, receiptId)));
    await fileReceiptExpense(tx, orgId, receiptId, null, actor);
    return held.otherReceiptId;
  }

  const self = await expenseOfReceipt(tx, orgId, receiptId);
  // A match needs a merchant and a date on both; candidates are dated a day either way.
  if (!self?.expenseId || self.merchant === null || self.transactionDate === null) {
    return undefined;
  }
  const candidates = await tx
    .select({
      receiptId: receipts.id,
      status: receipts.status,
      createdAt: receipts.createdAt,
      merchant: expenses.merchant,
      transactionDate: expenses.transactionDate,
      currency: expenses.currency,
      amountMinor: expenses.amountMinor,
      ...placeSelection,
    })
    .from(receipts)
    .innerJoin(
      expenses,
      and(eq(expenses.orgId, receipts.orgId), eq(expenses.id, receipts.expenseId)),
    )
    .where(
      and(
        eq(receipts.orgId, orgId),
        eq(receipts.memberId, self.memberId),
        ne(receipts.id, receiptId),
        inArray(receipts.status, COMPARABLE),
        sql`${expenses.transactionDate} between ${self.transactionDate}::date - 1 and ${self.transactionDate}::date + 1`,
        // Never paired with this receipt before, in either order, open or dismissed.
        sql`not exists (
          select 1 from ${receiptDuplicates} d
           where d.org_id = ${orgId}
             and ((d.receipt_id = ${receiptId} and d.other_receipt_id = ${receipts.id})
               or (d.receipt_id = ${receipts.id} and d.other_receipt_id = ${receiptId})))`,
      ),
    )
    .orderBy(asc(receipts.createdAt), asc(receipts.id));
  // An exact copy first; otherwise the earliest possible one.
  const judged = candidates.map((c) => ({ ...c, kind: duplicateKind(self, c) }));
  const match = judged.find((c) => c.kind === 'exact') ?? judged.find((c) => c.kind !== null);
  if (!match) return undefined;

  // The later of the two is the copy, whichever was read last: a receipt read again, or one
  // checked by the release, may be the earlier.
  const matchIsLater =
    match.createdAt > self.createdAt ||
    (match.createdAt.getTime() === self.createdAt.getTime() && match.receiptId > receiptId);
  const [heldId, of, heldStatus] = matchIsLater
    ? [match.receiptId, receiptId, match.status]
    : [receiptId, match.receiptId, settledStatus];
  await tx.insert(receiptDuplicates).values({
    orgId,
    receiptId: heldId,
    otherReceiptId: of,
    settledStatus: heldStatus,
  });
  await tx
    .update(receipts)
    .set({ status: 'needs_review' })
    .where(and(eq(receipts.orgId, orgId), eq(receipts.id, heldId)));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'receipt',
    entityId: heldId,
    action: 'receipt.possible_duplicate',
    payload: { of, kind: match.kind, settledStatus: heldStatus },
  });
  await fileReceiptExpense(tx, orgId, heldId, null, actor);
  return match.receiptId;
}

/** An open pair between two receipts, in whichever order it was flagged. */
async function openPair(tx: Transaction, orgId: string, a: string, b: string) {
  const [pair] = await tx
    .select()
    .from(receiptDuplicates)
    .where(
      and(
        eq(receiptDuplicates.orgId, orgId),
        eq(receiptDuplicates.state, 'open'),
        or(
          and(eq(receiptDuplicates.receiptId, a), eq(receiptDuplicates.otherReceiptId, b)),
          and(eq(receiptDuplicates.receiptId, b), eq(receiptDuplicates.otherReceiptId, a)),
        ),
      ),
    )
    .for('update');
  return pair;
}

export type ResolveDuplicateResult =
  | { readonly status: 'kept_both' }
  | { readonly status: 'deleted'; readonly kept: string; readonly storageKey: string }
  | {
      readonly status: 'merged';
      readonly kept: string;
      readonly storageKey: string;
      readonly taken: MergeField[];
    }
  /** No open pair between these two receipts. */
  | { readonly status: 'not_a_pair' }
  /** The expense to delete, or to merge into, is submitted or later. */
  | { readonly status: 'locked' };

/**
 * The person says two flagged receipts are different purchases: both stay, the held one goes
 * back to what its reading settled to, and the pair is never flagged again.
 */
export async function keepBothReceipts(
  tx: Transaction,
  orgId: string,
  receiptId: string,
  otherReceiptId: string,
  actorUserId: string,
): Promise<ResolveDuplicateResult> {
  await lockOrgWrites(tx, orgId);
  const pair = await openPair(tx, orgId, receiptId, otherReceiptId);
  if (!pair) return { status: 'not_a_pair' };
  const actor = { type: 'user' as const, id: actorUserId };
  await tx
    .update(receiptDuplicates)
    .set({ state: 'dismissed', resolvedAt: new Date() })
    .where(eq(receiptDuplicates.id, pair.id));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'receipt',
    entityId: pair.receiptId,
    action: 'receipt.not_a_duplicate',
    payload: { of: pair.otherReceiptId },
  });
  await release(tx, orgId, pair.receiptId, pair.settledStatus, actor);
  return { status: 'kept_both' };
}

/**
 * Deletes one receipt of an open pair, with its readings, confirmations and expense, through
 * delete_receipt(); the audit trail records what it was and what it duplicated. The receipt
 * kept goes back to what its reading settled to if this pair held it. The caller removes the
 * file once the transaction commits.
 */
export async function deleteDuplicateReceipt(
  tx: Transaction,
  orgId: string,
  deleteId: string,
  keepId: string,
  actorUserId: string,
  merge?: { readonly taken: MergeField[] },
): Promise<ResolveDuplicateResult> {
  await lockOrgWrites(tx, orgId);
  const pair = await openPair(tx, orgId, deleteId, keepId);
  if (!pair) return { status: 'not_a_pair' };
  const doomed = await expenseOfReceipt(tx, orgId, deleteId);
  if (!doomed) return { status: 'not_a_pair' };
  if (
    doomed.expenseStatus &&
    !['processing', 'needs_review', 'ready'].includes(doomed.expenseStatus)
  ) {
    return { status: 'locked' };
  }
  const actor = { type: 'user' as const, id: actorUserId };
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'receipt',
    entityId: deleteId,
    action: merge ? 'receipt.merged_away' : 'receipt.deleted',
    payload: {
      duplicateOf: keepId,
      sha256: doomed.sha256,
      merchant: doomed.merchant,
      date: doomed.transactionDate,
      currency: doomed.currency,
      amountMinor: doomed.amountMinor,
      expenseId: doomed.expenseId,
      ...(merge ? { taken: merge.taken } : {}),
    },
  });
  // Receipts held as copies of the one deleted lose that reason: each is checked again, so a
  // third copy of a purchase is now held against the receipt kept.
  const heldByDoomed = await tx
    .select({
      receiptId: receiptDuplicates.receiptId,
      settledStatus: receiptDuplicates.settledStatus,
    })
    .from(receiptDuplicates)
    .where(
      and(
        eq(receiptDuplicates.orgId, orgId),
        eq(receiptDuplicates.otherReceiptId, deleteId),
        eq(receiptDuplicates.state, 'open'),
        ne(receiptDuplicates.id, pair.id),
      ),
    );
  // Both receipts' reports change: a closed one reopens before the deletion (ADR-0029).
  const kept = await expenseOfReceipt(tx, orgId, keepId);
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(
      tx,
      [doomed.expenseId, kept?.expenseId ?? null].filter((id) => id !== null),
    ),
    actor,
    merge ? 'a duplicate was merged into an expense on it' : 'a duplicate on it was deleted',
  );
  const { rows } = await tx.execute<{ storage_key: string }>(
    sql`select storage_key from delete_receipt(${deleteId})`,
  );
  const storageKey = rows[0]?.storage_key ?? doomed.storageKey;
  if (pair.receiptId === keepId) {
    await release(tx, orgId, keepId, pair.settledStatus, actor);
  }
  for (const held of heldByDoomed) {
    await release(tx, orgId, held.receiptId, held.settledStatus, actor);
    await checkForDuplicate(tx, orgId, held.receiptId, held.settledStatus, actor);
  }
  return merge
    ? { status: 'merged', kept: keepId, storageKey, taken: merge.taken }
    : { status: 'deleted', kept: keepId, storageKey };
}

/**
 * Merges a duplicate into the primary the person chose (FR-INT-18): the primary's expense
 * takes every field it lacks from the duplicate's, and each field the person picked; then the
 * duplicate is deleted as deleteDuplicateReceipt() deletes it. The primary keeps its own file.
 */
export async function mergeDuplicateReceipt(
  tx: Transaction,
  orgId: string,
  primaryId: string,
  duplicateId: string,
  chosen: readonly MergeField[],
  actorUserId: string,
): Promise<ResolveDuplicateResult> {
  await lockOrgWrites(tx, orgId);
  if (!(await openPair(tx, orgId, primaryId, duplicateId))) return { status: 'not_a_pair' };
  const [primary, duplicate] = await Promise.all([
    expenseOfReceipt(tx, orgId, primaryId),
    expenseOfReceipt(tx, orgId, duplicateId),
  ]);
  if (!primary?.expenseId || !duplicate) return { status: 'not_a_pair' };
  if (primary.expenseStatus !== 'needs_review' && primary.expenseStatus !== 'ready') {
    return { status: 'locked' };
  }
  const asMergeable = (e: NonNullable<typeof primary>): MergeableExpense => ({
    merchant: e.merchant,
    transactionDate: e.transactionDate,
    currency: e.currency,
    amountMinor: e.amountMinor,
    notes: e.notes,
    tripId: e.tripId,
  });
  const { merged, taken } = mergeExpenses(asMergeable(primary), asMergeable(duplicate), chosen);
  const actor = { type: 'user' as const, id: actorUserId };
  if (taken.length > 0) {
    const now = new Date();
    await tx
      .update(expenses)
      .set({
        merchant: merged.merchant,
        transactionDate: merged.transactionDate,
        currency: merged.currency,
        amountMinor: merged.amountMinor,
        notes: merged.notes,
        tripId: merged.tripId,
        ...(taken.includes('trip') ? { tripPinned: true } : {}),
        editedAt: now,
        updatedAt: now,
      })
      .where(and(eq(expenses.orgId, orgId), eq(expenses.id, primary.expenseId)));
    const shown = (e: MergeableExpense, field: MergeField) =>
      field === 'merchant'
        ? e.merchant
        : field === 'date'
          ? e.transactionDate
          : field === 'amount'
            ? e.amountMinor === null || e.currency === null
              ? null
              : `${toDecimal(money(e.amountMinor, e.currency))} ${e.currency}`
            : field === 'notes'
              ? e.notes
              : e.tripId;
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'expense',
      entityId: primary.expenseId,
      action: 'expense.merged',
      payload: {
        from: duplicate.expenseId,
        changes: taken.map((field) => ({
          field,
          from: shown(asMergeable(primary), field),
          to: shown(merged, field),
        })),
      },
    });
  }
  const deleted = await deleteDuplicateReceipt(tx, orgId, duplicateId, primaryId, actorUserId, {
    taken,
  });
  if (deleted.status !== 'merged') return deleted;
  // Its status follows the merged values; a new date refiles it unless its trip was chosen.
  await fileReceiptExpense(tx, orgId, primaryId, null, actor);
  if (taken.includes('date') && !taken.includes('trip')) {
    await fileExpenseToTrip(tx, orgId, primary.expenseId, actor);
  }
  return deleted;
}

/**
 * Whether an expense is proved by a receipt held as a possible duplicate. Totals leave such an
 * expense out until the person decides, so one purchase sent twice never counts twice.
 */
export const heldAsDuplicate = (expenseId: SQLWrapper) => sql`exists (
  select 1 from ${receipts} r
    join ${receiptDuplicates} d on d.org_id = r.org_id and d.receipt_id = r.id and d.state = 'open'
   where r.org_id = ${expenses.orgId} and r.expense_id = ${expenseId})`;

/** One receipt of a pair, with the expense it proves: what the person compares. */
export interface DuplicateSide {
  readonly receiptId: string;
  readonly source: ExpenseSource;
  readonly contentType: string;
  readonly createdAt: Date;
  readonly expenseId: string | null;
  readonly expenseStatus: ExpenseStatus | null;
  readonly merchant: string | null;
  readonly transactionDate: string | null;
  readonly currency: string | null;
  readonly amountMinor: number | null;
  readonly notes: string | null;
  readonly tripId: string | null;
  readonly tripName: string | null;
  /** When and where it was bought, HH:MM local time and the place as read (FR-INT-17). */
  readonly time: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly country: string | null;
}

/** An open pair as one of its receipts sees it: itself, the other, and which is held. */
export interface DuplicatePairRecord {
  readonly receiptId: string;
  readonly otherReceiptId: string;
  /** The receipt this pair holds: the later of the two. */
  readonly heldReceiptId: string;
  readonly self: DuplicateSide;
  readonly other: DuplicateSide;
}

/** The open pairs these receipts are in, either side, oldest first. Call inside withOrg(). */
export async function listOpenDuplicatePairs(
  tx: Transaction,
  receiptIds: readonly string[],
): Promise<DuplicatePairRecord[]> {
  if (receiptIds.length === 0) return [];
  const ids = [...receiptIds];
  const pairs = await tx
    .select({
      receiptId: receiptDuplicates.receiptId,
      otherReceiptId: receiptDuplicates.otherReceiptId,
    })
    .from(receiptDuplicates)
    .where(
      and(
        eq(receiptDuplicates.state, 'open'),
        or(
          inArray(receiptDuplicates.receiptId, ids),
          inArray(receiptDuplicates.otherReceiptId, ids),
        ),
      ),
    )
    .orderBy(asc(receiptDuplicates.createdAt), asc(receiptDuplicates.id));
  if (pairs.length === 0) return [];
  const involved = [...new Set(pairs.flatMap((p) => [p.receiptId, p.otherReceiptId]))];
  const sides = await tx
    .select({
      receiptId: receipts.id,
      source: receipts.source,
      contentType: receipts.contentType,
      createdAt: receipts.createdAt,
      expenseId: expenses.id,
      expenseStatus: expenses.status,
      merchant: expenses.merchant,
      transactionDate: expenses.transactionDate,
      currency: expenses.currency,
      amountMinor: expenses.amountMinor,
      notes: expenses.notes,
      tripId: expenses.tripId,
      tripName: trips.name,
      ...placeSelection,
    })
    .from(receipts)
    .leftJoin(
      expenses,
      and(eq(expenses.orgId, receipts.orgId), eq(expenses.id, receipts.expenseId)),
    )
    .leftJoin(trips, and(eq(trips.orgId, expenses.orgId), eq(trips.id, expenses.tripId)))
    .where(inArray(receipts.id, involved));
  const side = new Map<string, DuplicateSide>(sides.map((s) => [s.receiptId, s]));
  return pairs.flatMap((p) => {
    const held = side.get(p.receiptId);
    const of = side.get(p.otherReceiptId);
    if (!held || !of) return [];
    const base = { heldReceiptId: p.receiptId };
    return [
      ...(ids.includes(p.receiptId)
        ? [
            {
              ...base,
              receiptId: p.receiptId,
              otherReceiptId: p.otherReceiptId,
              self: held,
              other: of,
            },
          ]
        : []),
      ...(ids.includes(p.otherReceiptId)
        ? [
            {
              ...base,
              receiptId: p.otherReceiptId,
              otherReceiptId: p.receiptId,
              self: of,
              other: held,
            },
          ]
        : []),
    ];
  });
}

/**
 * Checks, once, each receipt read before possible duplicates were looked for, oldest first,
 * so a later copy is the one held. A release data step: run as the schema owner, safe to run
 * on every release, since a receipt checked once is marked.
 */
export async function checkUncheckedReceipts(db: {
  transaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}): Promise<number> {
  return db.transaction(async (tx) => {
    const unchecked = await tx
      .select({ id: receipts.id, orgId: receipts.orgId, status: receipts.status })
      .from(receipts)
      .where(and(isNull(receipts.duplicatesCheckedAt), inArray(receipts.status, COMPARABLE)))
      .orderBy(asc(receipts.createdAt), asc(receipts.id));
    let held = 0;
    for (const receipt of unchecked) {
      const actor = { type: 'system' as const, id: 'duplicate-check' };
      if (await checkForDuplicate(tx, receipt.orgId, receipt.id, receipt.status, actor)) held++;
    }
    return held;
  });
}
