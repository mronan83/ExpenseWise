import {
  activeMemberCount,
  approvalOf,
  approverFor,
  decideReport,
  getReport,
  loadReports,
  reportsToApprove,
  reviewExpenses,
  setClaimReason,
  submitReport,
  withReportAmounts,
  type ApprovalStepRecord,
  type ClaimReasonResult,
  type Database,
  type DecideReportResult,
  type Decision,
  type ExpenseRecord,
  type ReceiptJudge,
  type RejectionRecord,
  type ReportContents,
  type ReviewExpense,
  type SubmitReportResult,
  type Transaction,
} from '@expensewise/db';
import { checkAgainstReceipt, type MemberRole, type ReceiptCheck } from '@expensewise/domain';
import { proofDifferences } from '@expensewise/extraction';
import { asCaller } from './caller.ts';
import { proofOf } from './expense-views.ts';
import { withProofs } from './expenses.ts';
import type { ReceiptWithReadings } from './receipts.ts';

/**
 * Whether an expense holds up against its receipt (Q6): what the receipt shows is worked out
 * from its readings, as the expense's page shows it, and compared field by field.
 */
export function receiptCheckOf(
  expense: ExpenseRecord,
  proof: ReceiptWithReadings | null,
): ReceiptCheck {
  if (!proof) return { state: 'no_receipt' };
  const shown = proofOf(proof).values;
  return checkAgainstReceipt({
    differences: proofDifferences(expense, shown),
    claimedMinor: expense.amountMinor,
    claimedCurrency: expense.currency,
    receiptMinor: shown.amountMinor,
    receiptCurrency: shown.currency,
    reason: expense.claimReason ?? null,
    excludedLines: expense.excludedLines ?? 0,
  });
}

/** One expense on a report under review, with its receipt and how it holds up against it. */
export interface ReviewedExpense {
  readonly expense: ReviewExpense;
  readonly proof: ReceiptWithReadings | null;
  readonly check: ReceiptCheck;
}

/** Judges each expense against its receipt, in the transaction asked. */
async function review(tx: Transaction, list: readonly ReviewExpense[]): Promise<ReviewedExpense[]> {
  const found = await withProofs(tx, [...list]);
  return list.map((expense) => {
    const receipt = found.receipts.find((r) => r.id === expense.receiptId);
    const proof = receipt ? { receipt, runs: found.runs, reviews: found.reviews } : null;
    return { expense, proof, check: receiptCheckOf(expense, proof) };
  });
}

/** The judge the database's submission and decision call, in their own transaction. */
export const receiptJudge: ReceiptJudge = async (tx, list) =>
  new Map((await review(tx, list)).map((r) => [r.expense.id, r.check]));

/** A member as approval names them. */
export interface NamedMember {
  readonly memberId: string;
  readonly name: string;
}

/** Everything a report's approval page needs, read in one transaction. */
export interface ApprovalData {
  readonly contents: ReportContents;
  readonly steps: readonly ApprovalStepRecord[];
  /** What its latest return rejected, while it is back with its member. */
  readonly rejections: readonly RejectionRecord[];
  readonly expenses: readonly ReviewedExpense[];
  /** Who it would go to if submitted now: for a report not yet submitted. */
  readonly wouldGoTo: NamedMember | null;
  /** Active members, as separation of duties counts them. */
  readonly memberCount: number;
}

/** What the API needs from the database for approval (#24). Tests use an in-memory fake. */
export interface ApprovalStore {
  /** A report's approval, or undefined when the caller can't see it. */
  view(orgId: string, reportId: string): Promise<ApprovalData | undefined>;
  submit(
    orgId: string,
    reportId: string,
    submitter: { readonly memberId: string; readonly userId: string },
  ): Promise<SubmitReportResult>;
  decide(
    orgId: string,
    reportId: string,
    decider: {
      readonly memberId: string;
      readonly role: MemberRole;
      readonly userId: string;
      readonly secondFactor: boolean;
    },
    decision: Decision,
  ): Promise<DecideReportResult>;
  /** Why an expense claims less than its receipt (FR-EXP-10). */
  claimReason(
    orgId: string,
    expenseId: string,
    text: string,
    actorUserId: string,
  ): Promise<ClaimReasonResult>;
  /** The reports waiting for this member's decision, oldest first. */
  toApprove(orgId: string, memberId: string): Promise<ReportContents[]>;
}

/** The reports waiting for a member's decision, with their amounts. Call inside withOrg(). */
export async function reportsWaitingFor(
  tx: Transaction,
  memberId: string,
): Promise<ReportContents[]> {
  return withReportAmounts(tx, await loadReports(tx, await reportsToApprove(tx, memberId)));
}

/**
 * The approval store on Postgres, as expensewise_app, for the request's caller: they see a
 * report only where their role, or its routing to them, lets them (ADR-0035, ADR-0043).
 */
export function dbApprovalStore(db: Database): ApprovalStore {
  const inOrg = asCaller(db);
  return {
    view: (orgId, reportId) =>
      inOrg(orgId, async (tx) => {
        const found = await getReport(tx, reportId);
        if (!found) return undefined;
        const [contents] = await withReportAmounts(tx, [found]);
        const { steps, rejections } = await approvalOf(tx, reportId);
        const unsubmitted = found.report.status === 'open' || found.report.status === 'closed';
        return {
          contents: contents ?? found,
          steps,
          rejections,
          expenses: await review(tx, await reviewExpenses(tx, reportId)),
          wouldGoTo: unsubmitted ? await approverFor(tx, found.report.memberId) : null,
          memberCount: await activeMemberCount(tx),
        };
      }),
    submit: (orgId, reportId, submitter) =>
      inOrg(orgId, (tx) => submitReport(tx, orgId, reportId, submitter, receiptJudge)),
    decide: (orgId, reportId, decider, decision) =>
      inOrg(orgId, (tx) => decideReport(tx, orgId, reportId, decider, decision, receiptJudge)),
    claimReason: (orgId, expenseId, text, actor) =>
      inOrg(orgId, (tx) => setClaimReason(tx, orgId, expenseId, text, actor)),
    toApprove: (orgId, memberId) => inOrg(orgId, (tx) => reportsWaitingFor(tx, memberId)),
  };
}
