import type { Membership } from '@expensewise/db';
import {
  paidByOf,
  mayDecide,
  needsSecondFactor,
  receiptDifferenceText,
  type ReceiptCheck,
} from '@expensewise/domain';
import type { ApprovalData, ReviewedExpense } from './approval.ts';
import type { Identity } from './auth.ts';
import { proofOf } from './expense-views.ts';
import { amountView } from './receipt-views.ts';

/** How an expense holds up against its receipt, as the page shows it. */
export function checkView(check: ReceiptCheck) {
  return {
    state: check.state,
    differences: check.state === 'differs' ? [...check.differences] : [],
    over: check.state === 'differs' && check.over,
    needsReason: check.state === 'differs' && check.needsReason,
    explainedBy: check.state === 'explained' ? check.by : null,
    text: receiptDifferenceText(check),
  };
}

function expenseView(
  { expense, proof, check }: ReviewedExpense,
  rejection: { reason: string; automatic: boolean } | undefined,
  companyPaid: boolean,
) {
  const shown = proof ? proofOf(proof).values : null;
  return {
    id: expense.id,
    merchant: expense.merchant,
    date: expense.transactionDate,
    amount: amountView(expense.amountMinor, expense.currency),
    receiptId: expense.receiptId,
    trip: expense.tripName,
    receipt: shown
      ? {
          merchant: shown.merchant,
          date: shown.transactionDate,
          amount: amountView(shown.amountMinor, shown.currency),
        }
      : null,
    check: checkView(check),
    claimReason: expense.claimReason ?? null,
    excludedLines: expense.excludedLines,
    rejection: rejection ?? null,
    // Who paid it, while Paid by the company is on: one the company paid is never claimed.
    ...(companyPaid ? { paidBy: paidByOf(expense.companyPaid ?? false) } : {}),
  };
}

const WHY = {
  not_closed: 'Once it is closed, submit it here for approval.',
  differs:
    'An expense on it differs from its receipt without a reason. Fix it, or say why it claims less.',
  no_approver:
    'No one else here can approve it. An owner can give someone the approver or finance admin role in Settings › People.',
  self_approval: 'It is your own spend: in a team, someone else approves it.',
  not_an_approver: 'Only an approver, a finance admin or the owner approves a report.',
  not_your_approval: 'It went to another approver.',
  rejected:
    'An expense on it differs from its receipt, so it is rejected: return the report for its member to fix.',
  second_factor_required:
    'Approving someone else’s spend needs your second factor: set one up in Settings › Sign-ins, once the owner has switched the second factor on, and sign in with its code. You can return it without one.',
} as const;

type Why = keyof typeof WHY;

/**
 * A report's approval as the caller sees it (#24): who it is with, each expense against its
 * receipt, a return's comment and rejections while it is back, and what the caller may do.
 * With `companyPaid`, each expense says who paid it (FR-EXP-17).
 */
export function approvalView(
  data: ApprovalData,
  caller: Membership,
  identity: Pick<Identity, 'assuranceLevel'>,
  companyPaid = false,
) {
  const { report } = data.contents;
  const mine = report.memberId === caller.memberId;
  const latest = data.steps.at(-1);
  const pending = latest?.decision === 'pending' ? latest : undefined;
  const unsubmitted = report.status === 'open' || report.status === 'closed';
  // Who it is with; before it goes, who it would go to; once decided, who decided it.
  const approver = unsubmitted
    ? data.wouldGoTo
    : latest
      ? { memberId: latest.approverMemberId, name: latest.approver }
      : null;
  const returned =
    unsubmitted && latest?.decision === 'returned' && latest.decidedAt
      ? { comment: latest.comment ?? '', by: latest.approver, at: latest.decidedAt.toISOString() }
      : null;
  const rejected = new Map(
    (returned ? data.rejections : []).map((r) => [
      r.expenseId,
      { reason: r.reason, automatic: r.automatic },
    ]),
  );
  const differs = data.expenses.some((e) => e.check.state === 'differs');

  let why: Why | null = null;
  const can = { submit: false, approve: false, return: false };
  let secondFactor: 'needed' | 'passed' | 'not_needed' = 'not_needed';
  if (unsubmitted && mine) {
    if (report.status !== 'closed') why = 'not_closed';
    else if (differs) why = 'differs';
    else if (!approver) why = 'no_approver';
    else can.submit = true;
  }
  if (report.status === 'in_approval' && pending) {
    const allowed = mayDecide({
      approverMemberId: caller.memberId,
      approverRole: caller.role,
      submitterMemberId: report.memberId,
      organizationMemberCount: data.memberCount,
      stepApproverMemberId: pending.approverMemberId,
    });
    if (!allowed.ok) {
      // Its own member waits for it; anyone else is told why it isn't theirs to decide.
      if (!mine) why = allowed.error.code;
    } else {
      can.return = true;
      if (needsSecondFactor(allowed.value)) {
        secondFactor = identity.assuranceLevel === 'aal2' ? 'passed' : 'needed';
      }
      if (differs) why = 'rejected';
      else if (secondFactor === 'needed') why = 'second_factor_required';
      else can.approve = true;
    }
  }
  return {
    reportId: report.id,
    status: report.status,
    member: report.owner,
    mine,
    approver,
    selfAttests: approver?.memberId === report.memberId,
    steps: data.steps.map((s) => ({
      sequence: s.sequence,
      approver: s.approver,
      decision: s.decision,
      comment: s.comment,
      decidedAt: s.decidedAt?.toISOString() ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
    returned,
    expenses: data.expenses.map((e) => expenseView(e, rejected.get(e.expense.id), companyPaid)),
    can,
    why: why ? { code: why, detail: WHY[why] } : null,
    secondFactor,
  };
}

export type ApprovalView = ReturnType<typeof approvalView>;
