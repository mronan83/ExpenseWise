import {
  JUSTIFICATION_MAX,
  REFUND_DAYS,
  isComplete,
  isExpenseEditable,
  isRefund,
  isTripMovable,
  receiptExpenseStatus,
  refundCandidates,
  refundFits,
  type ExpenseStatus,
  type ExpenseValues,
  type RefundCandidate,
  type RefundProblem,
  type RefundablePurchase,
} from '@expensewise/domain';
import { and, asc, eq, gt, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { openReportOf } from './reports.ts';
import { reopenChangedReports, reportsOfExpenses, reportsOfTrips } from './report-touch.ts';
import { expenses, receipts } from './schema.ts';

/*
 * Refunds (FR-EXP-21, Q59, Q60, ADR-0054): money a merchant gave back, an expense below zero.
 * A refund never takes anything off a claim on its own. Until its member pairs it with the
 * purchase it refunds it is on no trip and no report, never Ready, and waits in Needs you; the
 * expenses_refund_unpaired_held check holds every writer to that. Paired, it goes where its
 * purchase goes, so the two net down on one claim, or on the member's open report when the
 * purchase was claimed already, as money paid back; it is the company's when its purchase is.
 */

/** A refund waiting to be paired: it counts in no total until it is (FR-EXP-21). */
export const unpairedRefund = sql`(coalesce(${expenses.amountMinor} < 0, false) and ${expenses.refundOfId} is null)`;

/** What is read of an expense to pair it, place it or check its pairing still fits. */
const pairingColumns = {
  id: expenses.id,
  memberId: expenses.memberId,
  status: expenses.status,
  source: expenses.source,
  merchant: expenses.merchant,
  transactionDate: expenses.transactionDate,
  currency: expenses.currency,
  amountMinor: expenses.amountMinor,
  tripId: expenses.tripId,
  reportId: expenses.reportId,
  refundOfId: expenses.refundOfId,
  justification: expenses.justification,
  companyPaid: expenses.companyPaid,
  categoryId: expenses.categoryId,
  typeId: expenses.typeId,
};

/** What the other refunds paired with a purchase give back, as a negative or zero. */
async function refundedOf(
  tx: Transaction,
  purchaseId: string,
  except: string | null,
): Promise<number> {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${expenses.amountMinor}), 0)` })
    .from(expenses)
    .where(and(eq(expenses.refundOfId, purchaseId), except ? ne(expenses.id, except) : undefined));
  return Number(row?.total ?? 0);
}

/** An expense as read to pair it. */
type PairingRow = {
  readonly id: string;
  readonly memberId: string;
  readonly status: ExpenseStatus;
  readonly source: string;
  readonly merchant: string | null;
  readonly transactionDate: string | null;
  readonly currency: string | null;
  readonly amountMinor: number | null;
  readonly tripId: string | null;
  readonly reportId: string | null;
  readonly refundOfId: string | null;
  readonly justification: string | null;
  readonly companyPaid: boolean;
  readonly categoryId: string | null;
  readonly typeId: string | null;
};

const asPurchase = (p: PairingRow, refundedMinor: number): RefundablePurchase => ({
  id: p.id,
  merchant: p.merchant,
  transactionDate: p.transactionDate,
  currency: p.currency,
  amountMinor: p.amountMinor,
  refundedMinor,
  mileage: p.source === 'mileage',
});

async function pairingRow(
  tx: Transaction,
  expenseId: string,
  lock = false,
): Promise<PairingRow | undefined> {
  const query = tx.select(pairingColumns).from(expenses).where(eq(expenses.id, expenseId));
  const [row] = lock ? await query.for('update') : await query;
  return row;
}

/** An expense as a refund or its purchase shows it. */
export interface RefundLink {
  readonly id: string;
  readonly merchant: string | null;
  readonly transactionDate: string | null;
  readonly currency: string | null;
  readonly amountMinor: number | null;
  readonly status: ExpenseStatus;
}

/** What a refund is paired with, and the refunds paired with a purchase (FR-EXP-21). */
export interface RefundLinks {
  /** For a refund, the purchase it is paired with; null while it waits, or for a purchase. */
  readonly of: RefundLink | null;
  /** For a purchase, the refunds paired with it, oldest first. */
  readonly refunds: RefundLink[];
}

const linkColumns = {
  id: expenses.id,
  merchant: expenses.merchant,
  transactionDate: expenses.transactionDate,
  currency: expenses.currency,
  amountMinor: expenses.amountMinor,
  status: expenses.status,
};

/** An expense's refund links. Call inside withOrg(). */
export async function refundLinksOf(tx: Transaction, expenseId: string): Promise<RefundLinks> {
  const [own] = await tx
    .select({ refundOfId: expenses.refundOfId })
    .from(expenses)
    .where(eq(expenses.id, expenseId));
  const [of] = own?.refundOfId
    ? await tx.select(linkColumns).from(expenses).where(eq(expenses.id, own.refundOfId))
    : [];
  const refunds = await tx
    .select(linkColumns)
    .from(expenses)
    .where(eq(expenses.refundOfId, expenseId))
    .orderBy(asc(expenses.transactionDate), asc(expenses.id));
  return { of: of ?? null, refunds };
}

/** A purchase offered for a refund, with where it is in its lifecycle. */
export interface RefundOption extends RefundCandidate {
  readonly status: ExpenseStatus;
}

/**
 * The purchases a refund can be paired with, likeliest first (R-REFUND-DAYS): its member's own
 * in its currency, dated up to REFUND_DAYS before it, with enough left of them. Undefined when
 * there is no such expense; empty for one that isn't a refund. Call inside withOrg().
 */
export async function listRefundCandidates(
  tx: Transaction,
  refundId: string,
): Promise<RefundOption[] | undefined> {
  const refund = await pairingRow(tx, refundId);
  if (!refund) return undefined;
  if (!isRefund(refund) || !refund.currency || !refund.transactionDate) return [];
  const purchases = await tx
    .select(pairingColumns)
    .from(expenses)
    .where(
      and(
        eq(expenses.memberId, refund.memberId),
        eq(expenses.currency, refund.currency),
        gt(expenses.amountMinor, 0),
        ne(expenses.source, 'mileage'),
        sql`${expenses.transactionDate} between ${refund.transactionDate}::date - ${REFUND_DAYS}::int and ${refund.transactionDate}::date`,
      ),
    )
    .orderBy(asc(expenses.transactionDate), asc(expenses.id));
  // What the other refunds paired with each already give back.
  const given =
    purchases.length === 0
      ? []
      : await tx
          .select({
            purchaseId: expenses.refundOfId,
            total: sql<string>`sum(${expenses.amountMinor})`,
          })
          .from(expenses)
          .where(
            and(
              inArray(
                expenses.refundOfId,
                purchases.map((p) => p.id),
              ),
              ne(expenses.id, refundId),
            ),
          )
          .groupBy(expenses.refundOfId);
  const refunded = new Map(given.map((g) => [g.purchaseId, Number(g.total)]));
  const statuses = new Map(purchases.map((p) => [p.id, p.status]));
  return refundCandidates(
    refund,
    purchases.map((p) => asPurchase(p, refunded.get(p.id) ?? 0)),
  ).map((c) => ({ ...c, status: statuses.get(c.id)! }));
}

export type PairRefundResult =
  | { readonly status: 'paired'; readonly purchaseId: string }
  /** It is paired with that purchase already. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged' }
  /** No such refund, or no such purchase of the same person's. */
  | { readonly status: 'missing' }
  /** Being read, or submitted or later: its pairing can't change (FR-EXP-09). */
  | { readonly status: 'not_editable'; readonly current: ExpenseStatus }
  | { readonly status: 'invalid'; readonly problem: RefundProblem };

/**
 * Pairs a refund with the purchase it refunds (FR-EXP-21), with its audit event, then puts it
 * where it counts. Only within a person's own expenses: the pairing names its member, and a
 * purchase of anyone else's is missing. Call inside withOrg(), as the caller.
 */
export async function pairRefund(
  tx: Transaction,
  orgId: string,
  refundId: string,
  purchaseId: string,
  actorUserId: string,
): Promise<PairRefundResult> {
  await lockOrgWrites(tx, orgId);
  const refund = await pairingRow(tx, refundId, true);
  if (!refund) return { status: 'missing' };
  if (!isExpenseEditable(refund.status)) return { status: 'not_editable', current: refund.status };
  if (refund.refundOfId === purchaseId) return { status: 'unchanged' };
  const purchase = purchaseId === refundId ? undefined : await pairingRow(tx, purchaseId, true);
  if (!purchase || purchase.memberId !== refund.memberId) return { status: 'missing' };
  const fits = refundFits(refund, asPurchase(purchase, await refundedOf(tx, purchaseId, refundId)));
  if (!fits.ok) return { status: 'invalid', problem: fits.error };
  await tx
    .update(expenses)
    .set({ refundOfId: purchaseId, updatedAt: new Date() })
    .where(eq(expenses.id, refundId));
  const actor = { type: 'user', id: actorUserId } as const;
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: refundId,
    action: 'expense.refund_paired',
    payload: { purchaseId, previous: refund.refundOfId, amountMinor: refund.amountMinor },
  });
  await placeRefund(tx, orgId, refundId, actor);
  return { status: 'paired', purchaseId };
}

export type UnpairRefundResult =
  | { readonly status: 'unpaired'; readonly purchaseId: string }
  /** It is paired with nothing. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged' }
  | { readonly status: 'missing' }
  | { readonly status: 'not_editable'; readonly current: ExpenseStatus };

/** Takes a refund off its purchase: it counts in no claim again, and waits in Needs you. */
export async function unpairRefund(
  tx: Transaction,
  orgId: string,
  refundId: string,
  actorUserId: string,
): Promise<UnpairRefundResult> {
  await lockOrgWrites(tx, orgId);
  const refund = await pairingRow(tx, refundId, true);
  if (!refund) return { status: 'missing' };
  if (!refund.refundOfId) return { status: 'unchanged' };
  if (!isExpenseEditable(refund.status)) return { status: 'not_editable', current: refund.status };
  await letGo(tx, orgId, refund, { type: 'user', id: actorUserId }, 'a person unpaired it');
  return { status: 'unpaired', purchaseId: refund.refundOfId };
}

/**
 * Lets a refund go of its purchase, or holds an unpaired one: off its trip and report, which
 * reopen if closed, and no longer Ready. Audited.
 */
async function letGo(
  tx: Transaction,
  orgId: string,
  refund: PairingRow,
  actor: AuditEntry['actor'],
  reason: string,
) {
  const touched = await reportsOfExpenses(tx, [refund.id]);
  const status: ExpenseStatus = refund.status === 'ready' ? 'needs_review' : refund.status;
  await tx
    .update(expenses)
    .set({ refundOfId: null, tripId: null, reportId: null, status, updatedAt: new Date() })
    .where(eq(expenses.id, refund.id));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: refund.id,
    action: refund.refundOfId ? 'expense.refund_unpaired' : 'expense.refund_held',
    payload: {
      ...(refund.refundOfId ? { purchaseId: refund.refundOfId } : {}),
      tripId: refund.tripId,
      reportId: refund.reportId,
      status,
      previous: refund.status,
      reason,
    },
  });
  await reopenChangedReports(tx, orgId, touched, actor, 'a refund on it was taken off');
}

/** A justification for a refund on a report of its own: what it gave money back on. */
const refundJustification = (purchase: PairingRow) =>
  `Refund of ${purchase.merchant ?? 'a purchase'} on ${purchase.transactionDate ?? 'an earlier day'}`.slice(
    0,
    JUSTIFICATION_MAX,
  );

/**
 * Puts a paired refund where it counts (ADR-0054): with its purchase while that is open to
 * change, so the two net down on one claim; on its member's open report once the purchase is
 * submitted or later, as money paid back. It is Ready once its proof is, it is the company's
 * when its purchase is (FR-EXP-17), it takes its purchase's category and type when it has none,
 * and on a report of its own it says what it refunds. Audited when anything moved. Call inside
 * withOrg(), after lockOrgWrites().
 */
async function placeRefund(
  tx: Transaction,
  orgId: string,
  refundId: string,
  actor: AuditEntry['actor'],
): Promise<void> {
  const refund = await pairingRow(tx, refundId, true);
  if (!refund?.refundOfId || !isTripMovable(refund.status)) return;
  const purchase = await pairingRow(tx, refund.refundOfId);
  if (!purchase) return;
  let tripId: string | null;
  let reportId: string | null;
  if (isTripMovable(purchase.status)) {
    ({ tripId, reportId } = purchase);
  } else {
    // Claimed already: the refund is paid back on a report of the person's that is still open.
    tripId = null;
    reportId =
      refund.tripId === null && refund.reportId !== null
        ? refund.reportId
        : (await openReportOf(tx, orgId, refund.memberId, new Date(), actor, 'a refund')).id;
  }
  const [proof] = await tx
    .select({ status: receipts.status })
    .from(receipts)
    .where(eq(receipts.expenseId, refundId));
  const status: ExpenseStatus = proof
    ? (receiptExpenseStatus(refund.status, proof.status, refund, true) ?? refund.status)
    : isComplete(refund)
      ? 'ready'
      : 'needs_review';
  const justification =
    tripId === null && reportId !== null && !refund.justification
      ? refundJustification(purchase)
      : refund.justification;
  const classified =
    refund.categoryId === null && purchase.categoryId !== null && purchase.typeId !== null
      ? { categoryId: purchase.categoryId, typeId: purchase.typeId, classifiedAt: new Date() }
      : {};
  if (
    tripId === refund.tripId &&
    reportId === refund.reportId &&
    status === refund.status &&
    justification === refund.justification &&
    purchase.companyPaid === refund.companyPaid &&
    !('categoryId' in classified)
  ) {
    return;
  }
  const touched = [
    ...(await reportsOfExpenses(tx, [refundId])),
    ...(await reportsOfTrips(tx, [tripId])),
    ...(reportId ? [reportId] : []),
  ];
  await tx
    .update(expenses)
    .set({
      tripId,
      reportId,
      status,
      justification,
      companyPaid: purchase.companyPaid,
      companyPaidPinned: false,
      ...classified,
      updatedAt: new Date(),
    })
    .where(eq(expenses.id, refundId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: refundId,
    action: 'expense.refund_filed',
    payload: {
      purchaseId: purchase.id,
      tripId,
      reportId,
      status,
      companyPaid: purchase.companyPaid,
      previous: { tripId: refund.tripId, reportId: refund.reportId, status: refund.status },
      ...('categoryId' in classified ? { typeId: classified.typeId } : {}),
    },
  });
  await reopenChangedReports(tx, orgId, [...new Set(touched)], actor, 'a refund on it moved');
}

/**
 * Who paid the purchase a refund is paired with: the refund is the company's when it is
 * (FR-EXP-17). Null for any other expense, which follows the policy. Call inside withOrg().
 */
export async function refundPayer(tx: Transaction, expenseId: string): Promise<boolean | null> {
  const [own] = await tx
    .select({ refundOfId: expenses.refundOfId })
    .from(expenses)
    .where(eq(expenses.id, expenseId));
  if (!own?.refundOfId) return null;
  const [purchase] = await tx
    .select({ companyPaid: expenses.companyPaid })
    .from(expenses)
    .where(eq(expenses.id, own.refundOfId));
  return purchase?.companyPaid ?? null;
}

/**
 * Brings the refunds paired with these purchases along after a purchase moved trip or report,
 * or changed who paid it. Call inside withOrg(), after lockOrgWrites().
 */
export async function followPurchases(
  tx: Transaction,
  orgId: string,
  purchaseIds: readonly string[],
  actor: AuditEntry['actor'],
): Promise<void> {
  if (purchaseIds.length === 0) return;
  const refunds = await tx
    .select({ id: expenses.id })
    .from(expenses)
    .where(inArray(expenses.refundOfId, [...purchaseIds]))
    .orderBy(asc(expenses.id));
  for (const { id } of refunds) await placeRefund(tx, orgId, id, actor);
}

/**
 * Before an expense takes new values, settles it as a refund: one paired with a purchase they
 * no longer fit lets go of it, and a refund on its own is taken off its trip and report, so the
 * update that follows never puts an unpaired refund in a claim. Returns whether it stays paired,
 * for its status. Call inside withOrg(), after lockOrgWrites(), with the expense locked.
 */
export async function settleRefundValues(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  values: ExpenseValues,
  actor: AuditEntry['actor'],
): Promise<boolean> {
  const current = await pairingRow(tx, expenseId);
  if (!current || !isTripMovable(current.status)) return (current?.refundOfId ?? null) !== null;
  if (!isRefund(values)) {
    // No longer a refund: it is let go of its purchase, and files as any purchase does.
    if (current.refundOfId) await letGo(tx, orgId, current, actor, 'it is no longer a refund');
    return false;
  }
  if (current.refundOfId) {
    const purchase = await pairingRow(tx, current.refundOfId);
    const fits =
      purchase !== undefined &&
      refundFits(values, asPurchase(purchase, await refundedOf(tx, purchase.id, expenseId))).ok;
    if (fits) return true;
    await letGo(tx, orgId, current, actor, 'it no longer fits its purchase');
    return false;
  }
  if (current.tripId !== null || current.reportId !== null) {
    await letGo(tx, orgId, current, actor, 'a refund counts once it is paired');
  }
  return false;
}

/**
 * After a purchase took new values, lets go of the refunds paired with it that no longer fit,
 * the earliest kept first; with `all`, of every one, as before it is deleted. A refund submitted
 * or later stays where its claim went in, and keeps its pairing unless the purchase is deleted.
 * Call inside withOrg(), after lockOrgWrites().
 */
export async function releaseRefunds(
  tx: Transaction,
  orgId: string,
  purchaseId: string,
  actor: AuditEntry['actor'],
  reason: string,
  all = false,
): Promise<number> {
  const purchase = await pairingRow(tx, purchaseId);
  if (!purchase) return 0;
  const refunds = await tx
    .select(pairingColumns)
    .from(expenses)
    .where(eq(expenses.refundOfId, purchaseId))
    .orderBy(asc(expenses.transactionDate), asc(expenses.id))
    .for('update');
  let refunded = 0;
  let released = 0;
  for (const refund of refunds) {
    if (!isTripMovable(refund.status)) {
      // Its claim went in as it was: only a purchase going away takes the pairing off it.
      if (all) {
        await tx
          .update(expenses)
          .set({ refundOfId: null, updatedAt: new Date() })
          .where(eq(expenses.id, refund.id));
        await appendAuditEvent(tx, orgId, {
          actor,
          entityType: 'expense',
          entityId: refund.id,
          action: 'expense.refund_unpaired',
          payload: { purchaseId, status: refund.status, previous: refund.status, reason },
        });
        released++;
      } else {
        refunded += refund.amountMinor ?? 0;
      }
      continue;
    }
    if (!all && refundFits(refund, asPurchase(purchase, refunded)).ok) {
      refunded += refund.amountMinor ?? 0;
      continue;
    }
    await letGo(tx, orgId, refund, actor, reason);
    released++;
  }
  return released;
}

/**
 * Takes off its trip and report each refund filed before refunds were held (#114): read below
 * zero, unpaired and placed, or Ready. Then the check that holds every writer to that is
 * validated. Safe to run on every release. Runs as the schema owner, across organizations,
 * after migrations.
 */
export async function holdUnpairedRefunds(db: {
  transaction: <T>(work: (tx: Transaction) => Promise<T>) => Promise<T>;
}): Promise<number> {
  return db.transaction(async (tx) => {
    const placed = await tx
      .select({ ...pairingColumns, orgId: expenses.orgId })
      .from(expenses)
      .where(
        and(
          lt(expenses.amountMinor, 0),
          isNull(expenses.refundOfId),
          inArray(expenses.status, ['processing', 'needs_review', 'ready']),
          sql`(${expenses.status} = 'ready' or ${expenses.tripId} is not null or ${expenses.reportId} is not null)`,
        ),
      )
      .orderBy(asc(expenses.orgId), asc(expenses.id));
    const system = { type: 'system', id: 'refund-hold' } as const;
    for (const refund of placed) {
      await lockOrgWrites(tx, refund.orgId);
      await letGo(tx, refund.orgId, refund, system, 'a refund counts once it is paired');
    }
    await tx.execute(sql`alter table expenses validate constraint expenses_refund_unpaired_held`);
    return placed.length;
  });
}
