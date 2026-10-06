import type { ExpenseAmount, ExpenseStatus } from './expenses';

/** The feature that brings Paid by the company (F-62, FR-EXP-17, FR-EXP-18). */
export const COMPANY_PAID_FLAG = 'expenses.company-paid';

/**
 * Who paid an expense: claimant, the person, who claims it; company, the company directly,
 * such as airfare an employer books, which stays on its trip and is never claimed.
 */
export type PaidBy = 'claimant' | 'company';

/** A cost split by who paid it, one total per currency each, never converted. */
export interface CostSplit {
  claimed: ExpenseAmount[];
  companyPaid: ExpenseAmount[];
}

/** What the company paid on a report, apart from the claim and outside its total (Q47). */
export interface CompanyPaidSection {
  expenses: {
    id: string;
    status: ExpenseStatus;
    merchant: string | null;
    date: string | null;
    amount: ExpenseAmount | null;
    receiptId: string | null;
    trip: { id: string; name: string } | null;
    /** Held as a possible duplicate: in no total until decided. */
    held: boolean;
    /** Read and, on no trip, justified: the report closes only once it is (AC6). */
    ready: boolean;
  }[];
  totals: ExpenseAmount[];
  /** The claim and what the company paid together: the full cost. */
  fullCost: ExpenseAmount[];
}

/** Who paid an expense, in a few words, as its page says it. */
export function paidByText(paidBy: PaidBy, pinned: boolean): string {
  if (paidBy === 'claimant') return 'You';
  return pinned ? 'Paid by the company' : 'Paid by the company (your organization’s policy)';
}
