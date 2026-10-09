import {
  choosePaidBy,
  followsPolicyChange,
  paidByOf,
  paidByProblem,
  type ExpenseStatus,
  type PaidByChoice,
  type PaidByProblem,
} from '@expensewise/domain';
import { and, eq, inArray, ne, not, or, sql } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { heldAsDuplicate } from './duplicates.ts';
import { expenseColumns, type ReportExpenseRecord } from './expenses.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import { cardTransactions, expenses, expenseTypes, members, receipts, trips } from './schema.ts';
import { safeMinor } from './trips.ts';

/*
 * Who paid an expense: the person, who claims it, or the company directly, such as airfare an
 * employer books (FR-EXP-17, FR-EXP-18, Q46 to Q48, ADR-0045). The organization's policy says
 * which types the company pays; a person may set any one expense either way, and it then stays
 * as they set it until handed back. Every change is audited in its own transaction. Whether
 * reads leave what the company paid out of a claim is the caller's to decide by the feature.
 */

/** The feature that brings it (F-62). Off, `company_paid` is kept but read by nothing. */
export const COMPANY_PAID_FLAG = 'expenses.company-paid' as const;

/** Whether the policy says the company pays this type; no type, it doesn't. Call inside withOrg(). */
export async function companyPaysType(tx: Transaction, typeId: string | null): Promise<boolean> {
  if (typeId === null) return false;
  const [row] = await tx
    .select({ companyPays: expenseTypes.companyPays })
    .from(expenseTypes)
    .where(eq(expenseTypes.id, typeId));
  return row?.companyPays ?? false;
}

/**
 * Whether a card charge paid for this expense. A corporate card brought in is billed to the
 * company, which pays the issuer (Q52), so the expense it paid is the company's, never claimed
 * (FR-INT-25). Call inside withOrg().
 */
export async function paidByCardCharge(tx: Transaction, expenseId: string): Promise<boolean> {
  const [charge] = await tx
    .select({ id: cardTransactions.id })
    .from(cardTransactions)
    .where(eq(cardTransactions.expenseId, expenseId))
    .limit(1);
  return charge !== undefined;
}

/**
 * Who the organization says paid an expense not set by hand: the company when its type is one
 * the company pays (FR-EXP-18), or a card charge paid for it (FR-INT-25). Call inside withOrg().
 */
export async function policyPays(
  tx: Transaction,
  expenseId: string,
  typeId: string | null,
): Promise<boolean> {
  return (await companyPaysType(tx, typeId)) || (await paidByCardCharge(tx, expenseId));
}

export type SetPaidByResult =
  | { readonly status: 'set'; readonly companyPaid: boolean; readonly pinned: boolean }
  /** It was already so. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged' }
  | { readonly status: 'missing' }
  /** A drive, or submitted or later. */
  | {
      readonly status: 'not_changeable';
      readonly problem: PaidByProblem;
      readonly current: ExpenseStatus;
    };

const shownPaidBy = (state: { companyPaid: boolean; pinned: boolean }) => ({
  paidBy: paidByOf(state.companyPaid),
  pinned: state.pinned,
});

/**
 * A person sets who paid an expense, and the policy leaves it so from then on (Q46); or hands
 * it back to the policy, which applies at once. Not for a drive, nor once it is submitted. A
 * closed report it is on opens again, as for any change. Call inside withOrg(), as the caller.
 */
export async function setExpensePaidBy(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  choice: PaidByChoice,
  actorUserId: string,
): Promise<SetPaidByResult> {
  await lockOrgWrites(tx, orgId);
  const [expense] = await tx
    .select({
      status: expenses.status,
      source: expenses.source,
      typeId: expenses.typeId,
      companyPaid: expenses.companyPaid,
      pinned: expenses.companyPaidPinned,
    })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense) return { status: 'missing' };
  const problem = paidByProblem(expense);
  if (problem) return { status: 'not_changeable', problem, current: expense.status };

  const next = choosePaidBy(choice, await policyPays(tx, expenseId, expense.typeId));
  if (next.companyPaid === expense.companyPaid && next.pinned === expense.pinned) {
    return { status: 'unchanged' };
  }
  await tx
    .update(expenses)
    .set({ companyPaid: next.companyPaid, companyPaidPinned: next.pinned, updatedAt: new Date() })
    .where(eq(expenses.id, expenseId));
  const actor = { type: 'user', id: actorUserId } as const;
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.paid_by_set',
    payload: {
      before: shownPaidBy(expense),
      after: shownPaidBy(next),
      byPolicy: 'byPolicy' in choice,
    },
  });
  if (next.companyPaid !== expense.companyPaid) {
    await reopenChangedReports(
      tx,
      orgId,
      await reportsOfExpenses(tx, [expenseId]),
      actor,
      'who paid an expense on it changed',
    );
  }
  return { status: 'set', ...next };
}

/**
 * Brings who paid these expenses in line with the policy once a card charge is matched to one,
 * or lets go of it (FR-INT-25, US-CAP-08): one not set by hand, not a drive and not yet
 * submitted follows `policyPays`; a person's choice stands, and a submitted claim never changes.
 * Each switch is audited, and a closed report one is on opens again. Returns those that switched.
 * Call inside withOrg(), as whoever matched the charge.
 */
export async function followCardCharges(
  tx: Transaction,
  orgId: string,
  expenseIds: readonly (string | null)[],
  actor: AuditEntry['actor'],
): Promise<string[]> {
  const ids = [...new Set(expenseIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return [];
  // The organization's write lock before the rows, in the order every change of who paid takes them.
  await lockOrgWrites(tx, orgId);
  const rows = await tx
    .select({
      id: expenses.id,
      status: expenses.status,
      source: expenses.source,
      typeId: expenses.typeId,
      companyPaid: expenses.companyPaid,
      pinned: expenses.companyPaidPinned,
    })
    .from(expenses)
    .where(inArray(expenses.id, ids))
    .orderBy(expenses.id)
    .for('update');
  const switched: string[] = [];
  for (const expense of rows) {
    if (!followsPolicyChange(expense)) continue;
    const companyPaid = await policyPays(tx, expense.id, expense.typeId);
    if (companyPaid === expense.companyPaid) continue;
    await tx
      .update(expenses)
      .set({ companyPaid, updatedAt: new Date() })
      .where(eq(expenses.id, expense.id));
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'expense',
      entityId: expense.id,
      action: 'expense.paid_by_set',
      payload: {
        before: shownPaidBy(expense),
        after: shownPaidBy({ companyPaid, pinned: false }),
        byCard: true,
      },
    });
    switched.push(expense.id);
  }
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, switched),
    actor,
    'a card charge changed who paid an expense on it',
  );
  return switched;
}

/** Who is changing the policy: the member, for the row, and their sign-in, for the audit trail. */
export interface PolicyActor {
  readonly memberId: string;
  readonly userId: string;
}

export type SetCompanyPaysResult =
  /** Saved, with the expenses that switched to follow it. */
  | { readonly status: 'saved'; readonly switched: readonly string[] }
  | { readonly status: 'unchanged' }
  | { readonly status: 'missing' };

/**
 * Changes the policy for one type (FR-EXP-18, Q46): whether the company pays it directly. In
 * the same transaction, every expense of that type not set by hand and not yet submitted
 * follows it (Q48); a submitted, approved or settled one never changes, nor a drive. One audit
 * event names the change and the expenses that switched, and a closed report any of them is on
 * opens again. Who may change it is the caller's to check. It changes members' records the
 * caller doesn't own, so call it inside withOrg() as the system.
 */
export async function setTypeCompanyPays(
  tx: Transaction,
  orgId: string,
  typeId: string,
  companyPays: boolean,
  actor: PolicyActor,
): Promise<SetCompanyPaysResult> {
  await lockOrgWrites(tx, orgId);
  const [type] = await tx
    .select({ name: expenseTypes.name, companyPays: expenseTypes.companyPays })
    .from(expenseTypes)
    .where(eq(expenseTypes.id, typeId))
    .for('update');
  if (!type) return { status: 'missing' };
  if (type.companyPays === companyPays) return { status: 'unchanged' };

  const now = new Date();
  await tx
    .update(expenseTypes)
    .set({ companyPays, updatedByMemberId: actor.memberId, updatedAt: now })
    .where(eq(expenseTypes.id, typeId));
  const candidates = await tx
    .select({
      id: expenses.id,
      status: expenses.status,
      source: expenses.source,
      pinned: expenses.companyPaidPinned,
    })
    .from(expenses)
    .where(
      and(
        eq(expenses.typeId, typeId),
        eq(expenses.companyPaidPinned, false),
        ne(expenses.companyPaid, companyPays),
        // Submitted or later never changes (Q48); an approved one is locked besides.
        inArray(expenses.status, ['processing', 'needs_review', 'ready']),
        // One a card charge paid for stays the company's, whatever its type (FR-INT-25).
        companyPays
          ? undefined
          : sql`NOT EXISTS (SELECT 1 FROM card_transactions m WHERE m.org_id = ${expenses.orgId} AND m.expense_id = ${expenses.id})`,
      ),
    )
    .orderBy(expenses.id)
    .for('update');
  const switched = candidates.filter((e) => followsPolicyChange(e)).map((e) => e.id);
  if (switched.length > 0) {
    await tx
      .update(expenses)
      .set({ companyPaid: companyPays, updatedAt: now })
      .where(inArray(expenses.id, switched));
  }
  const by = { type: 'user', id: actor.userId } as const;
  await appendAuditEvent(tx, orgId, {
    actor: by,
    entityType: 'expense_type',
    entityId: typeId,
    action: 'expense_type.company_pays_changed',
    payload: { name: type.name, before: type.companyPays, after: companyPays, switched },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, switched),
    by,
    'the company’s policy on what it pays changed',
  );
  return { status: 'saved', switched };
}

/**
 * What is on trips or reports, counted and summed by currency and who paid, possible duplicates
 * left out (FR-EXP-17): a trip's cost split into the claim and what the company paid.
 */
export interface PayerTally {
  /** The report it is on, through its trip or as a local expense; null for none yet. */
  readonly reportId: string | null;
  /** Its trip; null for a local expense. */
  readonly tripId: string | null;
  readonly currency: string | null;
  readonly companyPaid: boolean;
  readonly count: number;
  /** Integer minor units; null where no amount is known yet. */
  readonly amountMinor: number | null;
}

/** Where to tally: on these trips, or on these reports, through their trips and locally. */
export type PayerScope =
  { readonly tripIds: readonly string[] } | { readonly reportIds: readonly string[] };

/** What is on these trips or reports, tallied by who paid. Call inside withOrg(). */
export async function tallyPayers(tx: Transaction, scope: PayerScope): Promise<PayerTally[]> {
  const ids = 'tripIds' in scope ? scope.tripIds : scope.reportIds;
  if (ids.length === 0) return [];
  const reportOf = sql<string | null>`coalesce(${expenses.reportId}, ${trips.reportId})`;
  const rows = await tx
    .select({
      reportId: reportOf,
      tripId: expenses.tripId,
      currency: expenses.currency,
      companyPaid: expenses.companyPaid,
      count: sql<number>`count(*)::int`,
      // Summed as text so a large total is never squeezed through a float.
      amountMinor: sql<string | null>`sum(${expenses.amountMinor})::text`,
    })
    .from(expenses)
    .leftJoin(trips, and(eq(trips.orgId, expenses.orgId), eq(trips.id, expenses.tripId)))
    .where(
      and(
        'tripIds' in scope
          ? inArray(expenses.tripId, [...ids])
          : or(inArray(expenses.reportId, [...ids]), inArray(trips.reportId, [...ids])),
        not(heldAsDuplicate(expenses.id)),
      ),
    )
    .groupBy(reportOf, expenses.tripId, expenses.currency, expenses.companyPaid);
  return rows.map((r) => ({
    ...r,
    amountMinor: r.amountMinor === null ? null : safeMinor(r.amountMinor),
  }));
}

/** An expense the company paid, on a report, apart from its claim (Q47). */
export interface CompanyPaidRecord extends ReportExpenseRecord {
  /** The report it is on, through its trip or as a local expense. */
  readonly onReportId: string;
}

/**
 * The expenses the company paid on these reports, through their trips and as local expenses,
 * in date order, undated last, with whether each is held as a possible duplicate. Call inside
 * withOrg().
 */
export async function listCompanyPaid(
  tx: Transaction,
  reportIds: readonly string[],
): Promise<CompanyPaidRecord[]> {
  if (reportIds.length === 0) return [];
  const rows = await tx
    .select({
      ...expenseColumns,
      held: sql<boolean>`${heldAsDuplicate(expenses.id)}`,
      onReportId: sql<string>`coalesce(${expenses.reportId}, ${trips.reportId})`.mapWith(String),
    })
    .from(expenses)
    .innerJoin(members, and(eq(members.orgId, expenses.orgId), eq(members.id, expenses.memberId)))
    .leftJoin(
      receipts,
      and(eq(receipts.orgId, expenses.orgId), eq(receipts.expenseId, expenses.id)),
    )
    .leftJoin(trips, and(eq(trips.orgId, expenses.orgId), eq(trips.id, expenses.tripId)))
    .where(
      and(
        eq(expenses.companyPaid, true),
        or(inArray(expenses.reportId, [...reportIds]), inArray(trips.reportId, [...reportIds])),
      ),
    )
    .orderBy(sql`${expenses.transactionDate} asc nulls last`, expenses.createdAt, expenses.id);
  return rows;
}
