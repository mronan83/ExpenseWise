import { isCurrencyCode } from './currency.ts';
import { isExpenseEditable, type ExpenseSource, type ExpenseStatus } from './lifecycle/expense.ts';
import { add, money, type Money } from './money.ts';

/*
 * Who paid an expense (FR-EXP-17, FR-EXP-18, Q46 to Q48, ADR-0045): the person, who claims it,
 * or the company directly, such as airfare an employer books and pays. An expense the company
 * paid stays on its trip and in the trip's cost, and is never claimed.
 */

export const PAID_BY = ['claimant', 'company'] as const;
export type PaidBy = (typeof PAID_BY)[number];

/** Who paid an expense as it is kept: the company or not, and whether a person set it. */
export interface PaidByState {
  readonly companyPaid: boolean;
  /** A person set it by hand: the policy leaves it alone until it is handed back (Q46). */
  readonly pinned: boolean;
}

/** What a person does: sets who paid by hand, or hands it back to the policy for its type. */
export type PaidByChoice = { readonly paidBy: PaidBy } | { readonly byPolicy: true };

export const paidByOf = (companyPaid: boolean): PaidBy => (companyPaid ? 'company' : 'claimant');

/**
 * Who paid an expense after a person's choice (Q46): set by hand, it is pinned; handed back,
 * the policy for its type applies at once, and with no type the person paid.
 */
export function choosePaidBy(choice: PaidByChoice, policy: boolean): PaidByState {
  if ('byPolicy' in choice) return { companyPaid: policy, pinned: false };
  return { companyPaid: choice.paidBy === 'company', pinned: true };
}

/**
 * Who paid an expense once its type or the policy for its type changes (Q46, Q48): one a
 * person set stays as it is; any other follows the policy.
 */
export function followPolicy(current: PaidByState, policy: boolean): PaidByState {
  return current.pinned ? current : { companyPaid: policy, pinned: false };
}

/** Why who paid an expense can't change now, or null when it can. */
export type PaidByProblem = 'mileage' | 'locked';

/**
 * Whether who paid an expense can change: never for a drive, which is paid at miles × its rate
 * to whoever drove, and not once it is submitted, approved or settled (Q48).
 */
export function paidByProblem(expense: {
  readonly status: ExpenseStatus;
  readonly source: ExpenseSource;
}): PaidByProblem | null {
  if (expense.source === 'mileage') return 'mileage';
  return expense.status === 'processing' || isExpenseEditable(expense.status) ? null : 'locked';
}

/** Whether a change of the policy reaches an expense: unpinned, not a drive, not submitted. */
export function followsPolicyChange(expense: {
  readonly status: ExpenseStatus;
  readonly source: ExpenseSource;
  readonly pinned: boolean;
}): boolean {
  return !expense.pinned && paidByProblem(expense) === null;
}

/** An amount, or a sum of several, and who paid it; one with no amount yet counts in none. */
export interface PaidAmount {
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly paidBy: PaidBy;
}

/**
 * A cost split into what is claimed and what the company paid, and the two together, one total
 * per currency each, never converted, in currency order (FR-EXP-17). A currency appears only
 * where something was paid in it that way.
 */
export interface CostSplit {
  readonly claimed: readonly Money[];
  readonly companyPaid: readonly Money[];
  readonly full: readonly Money[];
}

function totals(amounts: readonly PaidAmount[]): Money[] {
  const sums = new Map<string, Money>();
  for (const a of amounts) {
    if (a.amountMinor === null || a.currency === null || !isCurrencyCode(a.currency)) continue;
    const amount = money(a.amountMinor, a.currency);
    const sofar = sums.get(a.currency);
    sums.set(a.currency, sofar ? add(sofar, amount) : amount);
  }
  return [...sums.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Splits amounts into the claim and what the company paid, per currency, in minor units. */
export function splitCost(amounts: readonly PaidAmount[]): CostSplit {
  return {
    claimed: totals(amounts.filter((a) => a.paidBy === 'claimant')),
    companyPaid: totals(amounts.filter((a) => a.paidBy === 'company')),
    full: totals(amounts),
  };
}

/** Who paid, as a report's export writes it on every row (US-RPT-22 AC5). */
export const PAID_BY_LABELS: Readonly<Record<PaidBy, string>> = {
  claimant: 'You',
  company: 'The company',
};
