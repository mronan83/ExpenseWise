import type { PaidBy } from './company-paid';
import type { ExpenseAmount, ExpenseField } from './expenses';
import type { ReportStatus } from './reports';

/** The feature approval ships behind (ADR-0032). */
export const APPROVAL_FLAG = 'reports.approval';

/**
 * How an expense holds up against its receipt (Q6): what it is, a lower claim with a reason,
 * or a difference that stops its report being submitted and is rejected on review.
 */
export interface ReceiptCheck {
  state: 'matches' | 'explained' | 'differs' | 'no_receipt';
  differences: ExpenseField[];
  /** It claims more than its receipt, which it never may. */
  over: boolean;
  /** It claims less than its receipt, and a reason would settle it. */
  needsReason: boolean;
  explainedBy: 'reason' | 'lines' | null;
  /** Why it differs, in a sentence. */
  text: string | null;
}

/** An expense on a report under review. */
export interface ReviewedExpense {
  id: string;
  merchant: string | null;
  date: string | null;
  amount: ExpenseAmount | null;
  receiptId: string | null;
  trip: string | null;
  receipt: { merchant: string | null; date: string | null; amount: ExpenseAmount | null } | null;
  check: ReceiptCheck;
  claimReason: string | null;
  excludedLines: number;
  rejection: { reason: string; automatic: boolean } | null;
  /** Who paid it, while Paid by the company is on: the company's is never claimed (FR-EXP-17). */
  paidBy?: PaidBy;
}

/** A report's approval as the caller sees it (#24). */
export interface Approval {
  reportId: string;
  status: ReportStatus;
  member: string;
  mine: boolean;
  approver: { memberId: string; name: string } | null;
  selfAttests: boolean;
  steps: {
    sequence: number;
    approver: string;
    decision: 'pending' | 'approved' | 'returned';
    comment: string | null;
    decidedAt: string | null;
    createdAt: string;
  }[];
  returned: { comment: string; by: string; at: string } | null;
  expenses: ReviewedExpense[];
  can: { submit: boolean; approve: boolean; return: boolean };
  why: { code: string; detail: string } | null;
  secondFactor: 'needed' | 'passed' | 'not_needed';
}

/** How an expense holds up against its receipt, in a few words, and in which tone. */
export function checkLabel(check: ReceiptCheck): { text: string; tone: 'ok' | 'warn' | 'none' } {
  switch (check.state) {
    case 'matches':
      return { text: 'Matches its receipt', tone: 'ok' };
    case 'no_receipt':
      return { text: 'No receipt needed', tone: 'none' };
    case 'explained':
      return {
        text:
          check.explainedBy === 'lines'
            ? 'Less than its receipt: lines left out'
            : 'Less than its receipt, with a reason',
        tone: 'ok',
      };
    case 'differs':
      return { text: check.text ?? 'Differs from its receipt', tone: 'warn' };
  }
}
