import {
  applyMileageInput,
  initialExpenseStatus,
  IRS_BUSINESS_RATES,
  isExpenseEditable,
  mileageRate,
  newId,
  plainMiles,
  type DistanceUnit,
  type ExpenseStatus,
  type IsoDate,
  type MileageChange,
  type MileageInput,
  type MileageProblem,
  type MileageRate,
  type MileageRateTable,
  type MileageReimbursement,
  type MileageValues,
} from '@expensewise/domain';
import { and, eq } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites } from './audit.ts';
import type { Transaction } from './client.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import { expenses, mileageLogs } from './schema.ts';
import { fileExpenseToTrip } from './trips.ts';

/**
 * A mileage entry (FR-CAP-03): the drive, the rate copied onto it, and the expense that claims
 * it. The expense's amount is miles × that rate; its merchant is the destination and its
 * justification the business purpose, so it lists, files to trips and joins reports as any
 * expense does (ADR-0038).
 */
export interface MileageRecord extends MileageValues {
  readonly expenseId: string;
  readonly memberId: string;
  readonly status: ExpenseStatus;
  readonly method: 'manual' | 'route' | 'gps';
  readonly unit: DistanceUnit;
  /** Copied on when it was logged, and again whenever its date or miles changed (NFR-DAT-04). */
  readonly rate: MileageRate;
  /** What its expense claims, in integer minor units of the rate's currency. */
  readonly amountMinor: number | null;
}

const mileageColumns = {
  expenseId: mileageLogs.expenseId,
  memberId: expenses.memberId,
  status: expenses.status,
  amountMinor: expenses.amountMinor,
  method: mileageLogs.method,
  date: mileageLogs.travelDate,
  destination: mileageLogs.destination,
  purpose: mileageLogs.purpose,
  miles: mileageLogs.distance,
  unit: mileageLogs.unit,
  rateCurrency: mileageLogs.rateCurrency,
  ratePerUnit: mileageLogs.ratePerUnit,
  rateEffectiveFrom: mileageLogs.rateEffectiveFrom,
  rateSource: mileageLogs.rateSource,
};

/** A member's own mileage entry, with its expense. */
const mine = (tx: Transaction, memberId: string, expenseId: string) =>
  tx
    .select(mileageColumns)
    .from(mileageLogs)
    .innerJoin(
      expenses,
      and(eq(expenses.orgId, mileageLogs.orgId), eq(expenses.id, mileageLogs.expenseId)),
    )
    .where(and(eq(mileageLogs.expenseId, expenseId), eq(expenses.memberId, memberId)));

type MileageRow = Awaited<ReturnType<typeof mine>>[number];

const recordOf = (row: MileageRow): MileageRecord => ({
  expenseId: row.expenseId,
  memberId: row.memberId,
  status: row.status,
  amountMinor: row.amountMinor,
  method: row.method,
  date: row.date,
  destination: row.destination ?? '',
  purpose: row.purpose,
  miles: plainMiles(row.miles),
  unit: row.unit,
  rate: mileageRate({
    currency: row.rateCurrency,
    perUnit: row.ratePerUnit,
    unit: row.unit,
    effectiveFrom: row.rateEffectiveFrom,
    source: row.rateSource,
  }),
});

/**
 * One of the member's mileage entries, by its expense, or undefined: another member's is not
 * found. Call inside withOrg().
 */
export async function getMileage(
  tx: Transaction,
  memberId: string,
  expenseId: string,
): Promise<MileageRecord | undefined> {
  const [row] = await mine(tx, memberId, expenseId);
  return row && recordOf(row);
}

const rateColumns = (rate: MileageRate) => ({
  rateCurrency: rate.currency,
  ratePerUnit: rate.perUnit,
  rateEffectiveFrom: rate.effectiveFrom,
  rateSource: rate.source,
});

/** What the audit trail keeps of what a drive pays. */
const claimPayload = (claim: MileageReimbursement) => ({
  rate: {
    perUnit: claim.rate.perUnit,
    currency: claim.rate.currency,
    unit: claim.rate.unit,
    effectiveFrom: claim.rate.effectiveFrom,
    source: claim.rate.source,
  },
  amountMinor: claim.amount.amountMinor,
  currency: claim.amount.currency,
});

export type LogMileageResult =
  | { readonly status: 'logged'; readonly expenseId: string }
  | { readonly status: 'invalid'; readonly problem: MileageProblem };

/**
 * Logs a drive for a member (FR-CAP-03): an expense of miles × the rate in force on its date,
 * Ready at once, with the drive and that rate copied onto its mileage log, and its audit event.
 * It files to the member's trip its date falls in, as any expense does. Call inside withOrg().
 */
export async function logMileage(
  tx: Transaction,
  orgId: string,
  memberId: string,
  input: MileageInput,
  actorUserId: string,
  today: IsoDate,
  rates: MileageRateTable = IRS_BUSINESS_RATES,
): Promise<LogMileageResult> {
  const applied = applyMileageInput(null, input, today, rates);
  if (!applied.ok) return { status: 'invalid', problem: applied.error };
  const { values, claim } = applied.value;
  if (!claim) throw new Error('A new mileage entry was not priced');
  const actor = { type: 'user', id: actorUserId } as const;
  const status = initialExpenseStatus('mileage');
  // Before any expense is locked, so filing it to a trip sees every trip settled (ADR-0023).
  await lockOrgWrites(tx, orgId);
  const id = newId();
  await tx.insert(expenses).values({
    id,
    orgId,
    memberId,
    status,
    source: 'mileage',
    merchant: values.destination,
    transactionDate: values.date,
    amountMinor: claim.amount.amountMinor,
    currency: claim.amount.currency,
    justification: values.purpose,
  });
  await tx.insert(mileageLogs).values({
    orgId,
    expenseId: id,
    method: 'manual',
    travelDate: values.date,
    destination: values.destination,
    purpose: values.purpose,
    distance: values.miles,
    unit: claim.unit,
    ...rateColumns(claim.rate),
  });
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: id,
    action: 'expense.created',
    payload: {
      source: 'mileage',
      status,
      date: values.date,
      miles: values.miles,
      unit: claim.unit,
      ...claimPayload(claim),
    },
  });
  await fileExpenseToTrip(tx, orgId, id, actor);
  return { status: 'logged', expenseId: id };
}

export type EditMileageResult =
  | {
      readonly status: 'edited';
      readonly changes: readonly MileageChange[];
      /** The date or miles changed, so it was priced again at the rate then in force. */
      readonly repriced: boolean;
    }
  /** The values were already those. Nothing changed and nothing was recorded. */
  | { readonly status: 'unchanged' }
  | { readonly status: 'invalid'; readonly problem: MileageProblem }
  /** No such entry of this member's. */
  | { readonly status: 'missing' }
  /** Submitted or later: an approved entry is corrected by a reversal. */
  | { readonly status: 'not_editable'; readonly current: ExpenseStatus };

/**
 * A member corrects one of their mileage entries before it is submitted, with its audit event.
 * A new date or new miles price it again at the rate in force on its date, copied on afresh;
 * a new destination or purpose leaves the rate and amount alone. A closed report it is on
 * reopens, and a new date files it again by date. Call inside withOrg().
 */
export async function editMileage(
  tx: Transaction,
  orgId: string,
  memberId: string,
  expenseId: string,
  input: MileageInput,
  actorUserId: string,
  today: IsoDate,
  rates: MileageRateTable = IRS_BUSINESS_RATES,
): Promise<EditMileageResult> {
  await lockOrgWrites(tx, orgId);
  const [row] = await mine(tx, memberId, expenseId).for('update');
  if (!row) return { status: 'missing' };
  if (!isExpenseEditable(row.status)) return { status: 'not_editable', current: row.status };
  const current = recordOf(row);
  const applied = applyMileageInput(current, input, today, rates);
  if (!applied.ok) return { status: 'invalid', problem: applied.error };
  const { values, changes, claim } = applied.value;
  if (changes.length === 0) return { status: 'unchanged' };

  const actor = { type: 'user', id: actorUserId } as const;
  const now = new Date();
  await tx
    .update(mileageLogs)
    .set({
      travelDate: values.date,
      destination: values.destination,
      purpose: values.purpose,
      distance: values.miles,
      ...(claim ? rateColumns(claim.rate) : {}),
    })
    .where(eq(mileageLogs.expenseId, expenseId));
  await tx
    .update(expenses)
    .set({
      status: 'ready',
      merchant: values.destination,
      transactionDate: values.date,
      justification: values.purpose,
      ...(claim ? { amountMinor: claim.amount.amountMinor, currency: claim.amount.currency } : {}),
      editedAt: now,
      updatedAt: now,
    })
    .where(eq(expenses.id, expenseId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.edited',
    payload: {
      source: 'mileage',
      changes,
      ...(claim ? { ...claimPayload(claim), previousAmountMinor: current.amountMinor } : {}),
    },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    actor,
    'an expense on it was edited',
  );
  if (changes.some((c) => c.field === 'date')) {
    await fileExpenseToTrip(tx, orgId, expenseId, actor);
  }
  return { status: 'edited', changes, repriced: claim !== null };
}
