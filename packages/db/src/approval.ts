import {
  cleanApprovalNote,
  chooseApprover,
  holdsUp,
  mayDecide,
  needsSecondFactor,
  receiptDifferenceText,
  reopenedClosesAt,
  transitionExpense,
  transitionReport,
  type ApprovalBasis,
  type MemberRole,
  type ReceiptCheck,
  type ReportStatus,
} from '@expensewise/domain';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites } from './audit.ts';
import type { Transaction } from './client.ts';
import { heldAsDuplicate } from './duplicates.ts';
import { expenseColumns, type ExpenseRecord } from './expenses.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import { getReport, reportItems } from './reports.ts';
import {
  approvalSteps,
  expenseParts,
  expenseRejections,
  expenses,
  members,
  receipts,
  reports,
  trips,
} from './schema.ts';

/** The switch approval ships behind (ADR-0032). */
export const APPROVAL_FLAG = 'reports.approval';

/** One step of a report's approval, with its approver's name. */
export interface ApprovalStepRecord {
  readonly id: string;
  readonly reportId: string;
  readonly sequence: number;
  readonly approverMemberId: string;
  readonly approver: string;
  readonly decision: 'pending' | 'approved' | 'returned';
  readonly comment: string | null;
  readonly decidedAt: Date | null;
  readonly createdAt: Date;
}

/** An expense a returned report rejected, and why (FR-GOV-12). */
export interface RejectionRecord {
  readonly stepId: string;
  readonly expenseId: string;
  readonly reason: string;
  /** Rejected by the review on its own, because it differs from its receipt (FR-GOV-10). */
  readonly automatic: boolean;
  readonly createdAt: Date;
}

/** An expense on a report as its review sees it: with whether it is held, and lines left out. */
export interface ReviewExpense extends ExpenseRecord {
  readonly held: boolean;
  /** Lines of its receipt left out of the claim, each with its reason (FR-EXP-16). */
  readonly excludedLines: number;
}

/**
 * Judges each expense against its receipt, in the transaction that submits or decides (Q6).
 * The API supplies it: what a receipt shows is worked out from its readings there.
 */
export type ReceiptJudge = (
  tx: Transaction,
  expenses: readonly ReviewExpense[],
) => Promise<ReadonlyMap<string, ReceiptCheck>>;

const stepColumns = {
  id: approvalSteps.id,
  reportId: approvalSteps.reportId,
  sequence: approvalSteps.sequence,
  approverMemberId: approvalSteps.approverMemberId,
  approver: members.displayName,
  decision: approvalSteps.decision,
  comment: approvalSteps.comment,
  decidedAt: approvalSteps.decidedAt,
  createdAt: approvalSteps.createdAt,
};

/** The steps of these reports' approval, oldest first. Call inside withOrg(). */
export async function listApprovalSteps(
  tx: Transaction,
  reportIds: readonly string[],
): Promise<ApprovalStepRecord[]> {
  if (reportIds.length === 0) return [];
  return tx
    .select(stepColumns)
    .from(approvalSteps)
    .innerJoin(
      members,
      and(eq(members.orgId, approvalSteps.orgId), eq(members.id, approvalSteps.approverMemberId)),
    )
    .where(inArray(approvalSteps.reportId, [...reportIds]))
    .orderBy(asc(approvalSteps.reportId), asc(approvalSteps.sequence));
}

/** The expenses these steps rejected, in the order rejected. Call inside withOrg(). */
export async function listRejections(
  tx: Transaction,
  stepIds: readonly string[],
): Promise<RejectionRecord[]> {
  if (stepIds.length === 0) return [];
  return tx
    .select({
      stepId: expenseRejections.stepId,
      expenseId: expenseRejections.expenseId,
      reason: expenseRejections.reason,
      automatic: expenseRejections.automatic,
      createdAt: expenseRejections.createdAt,
    })
    .from(expenseRejections)
    .where(inArray(expenseRejections.stepId, [...stepIds]))
    .orderBy(asc(expenseRejections.createdAt), asc(expenseRejections.id));
}

/** The latest step of each report, by report. */
export function latestSteps(steps: readonly ApprovalStepRecord[]): Map<string, ApprovalStepRecord> {
  const latest = new Map<string, ApprovalStepRecord>();
  for (const step of steps) {
    const seen = latest.get(step.reportId);
    if (!seen || step.sequence > seen.sequence) latest.set(step.reportId, step);
  }
  return latest;
}

/**
 * Every expense on a report, its trips' and its local ones, in date order, undated last, with
 * whether each is held as a possible duplicate and how many lines it leaves out. Call inside
 * withOrg().
 */
export async function reviewExpenses(tx: Transaction, reportId: string): Promise<ReviewExpense[]> {
  return tx
    .select({ ...expenseColumns, held: sql<boolean>`${heldAsDuplicate(expenses.id)}` })
    .from(expenses)
    .innerJoin(members, and(eq(members.orgId, expenses.orgId), eq(members.id, expenses.memberId)))
    .leftJoin(
      receipts,
      and(eq(receipts.orgId, expenses.orgId), eq(receipts.expenseId, expenses.id)),
    )
    .leftJoin(trips, and(eq(trips.orgId, expenses.orgId), eq(trips.id, expenses.tripId)))
    .where(or(eq(expenses.reportId, reportId), eq(trips.reportId, reportId)))
    .orderBy(sql`${expenses.transactionDate} asc nulls last`, expenses.createdAt, expenses.id);
}

/** Who is in the organization now, as routing and separation of duties count them. */
async function activeMembers(tx: Transaction) {
  return tx
    .select({
      memberId: members.id,
      role: members.role,
      joinedAt: members.createdAt,
      managerMemberId: members.managerMemberId,
    })
    .from(members)
    .where(isNull(members.deactivatedAt))
    .orderBy(asc(members.createdAt), asc(members.id));
}

/** The expenses that don't hold up against their receipts, with why (FR-GOV-13). */
export interface Difference {
  readonly expenseId: string;
  readonly check: ReceiptCheck;
  readonly reason: string;
}

const differencesOf = (checks: ReadonlyMap<string, ReceiptCheck>): Difference[] =>
  [...checks].flatMap(([expenseId, check]) =>
    holdsUp(check) ? [] : [{ expenseId, check, reason: receiptDifferenceText(check) ?? '' }],
  );

/** Who would approve a report if it were submitted now; null when no one could. */
export async function wouldGoTo(
  tx: Transaction,
  submitterMemberId: string,
): Promise<string | null> {
  const active = await activeMembers(tx);
  const submitter = active.find((m) => m.memberId === submitterMemberId);
  return chooseApprover(
    { memberId: submitterMemberId, managerMemberId: submitter?.managerMemberId ?? null },
    active,
  );
}

/** How many people are in the organization now, as separation of duties counts them. */
export async function activeMemberCount(tx: Transaction): Promise<number> {
  return (await activeMembers(tx)).length;
}

/** Who a member's report would go to if submitted now, by name; null when no one could. */
export async function approverFor(
  tx: Transaction,
  submitterMemberId: string,
): Promise<{ readonly memberId: string; readonly name: string } | null> {
  const memberId = await wouldGoTo(tx, submitterMemberId);
  if (!memberId) return null;
  const [named] = await tx
    .select({ memberId: members.id, name: members.displayName })
    .from(members)
    .where(eq(members.id, memberId));
  return named ?? null;
}

export type SubmitReportResult =
  | {
      readonly status: 'submitted';
      readonly stepId: string;
      readonly approverMemberId: string;
      readonly selfAttests: boolean;
    }
  | { readonly status: 'missing' }
  /** Another member's report: each person submits only their own. */
  | { readonly status: 'not_yours' }
  | { readonly status: 'not_closed'; readonly current: ReportStatus }
  | { readonly status: 'empty' }
  /** These expenses differ from their receipts without a reason (FR-GOV-13). */
  | { readonly status: 'differs'; readonly differences: readonly Difference[] }
  /** No one else in the team can approve it (FR-GOV-03). */
  | { readonly status: 'no_approver' };

/**
 * The person submits their closed report for approval (FR-GOV-02, FR-GOV-13): only a closed
 * one, never while an expense on it differs from its receipt without a reason. It goes to its
 * approver in one step; each expense on it is submitted, and its category's and type's names,
 * and its parts', are copied onto it as they are now (NFR-DAT-04, #70). Call inside withOrg(),
 * as the member.
 */
export async function submitReport(
  tx: Transaction,
  orgId: string,
  reportId: string,
  submitter: { readonly memberId: string; readonly userId: string },
  judge: ReceiptJudge,
  now = new Date(),
): Promise<SubmitReportResult> {
  await lockOrgWrites(tx, orgId);
  const [row] = await tx
    .select({ status: reports.status, memberId: reports.memberId })
    .from(reports)
    .where(eq(reports.id, reportId))
    .for('update');
  if (!row) return { status: 'missing' };
  if (row.memberId !== submitter.memberId) return { status: 'not_yours' };
  const contents = await getReport(tx, reportId);
  if (!contents) return { status: 'missing' };
  const submitted = transitionReport(row.status, {
    type: 'submit',
    itemCount: reportItems(contents).length,
  });
  if (!submitted.ok) {
    return submitted.error.code === 'empty_report'
      ? { status: 'empty' }
      : { status: 'not_closed', current: row.status };
  }
  const onIt = await reviewExpenses(tx, reportId);
  const differences = differencesOf(await judge(tx, onIt));
  if (differences.length > 0) return { status: 'differs', differences };
  const approver = await wouldGoTo(tx, submitter.memberId);
  if (!approver) return { status: 'no_approver' };
  const routed = transitionReport(submitted.value, { type: 'route', steps: 1 });
  if (!routed.ok) throw new Error(`A submitted report can't be routed: ${routed.error.code}`);

  const ids = onIt
    .filter((e) => transitionExpense(e.status, { type: 'report_submitted' }).ok)
    .map((e) => e.id);
  if (ids.length > 0) {
    await tx
      .update(expenses)
      .set({
        status: 'submitted',
        categoryName: sql`(select c.name from categories c where c.org_id = ${expenses.orgId} and c.id = ${expenses.categoryId})`,
        typeName: sql`(select t.name from expense_types t where t.org_id = ${expenses.orgId} and t.id = ${expenses.typeId})`,
        updatedAt: now,
      })
      .where(inArray(expenses.id, ids));
    await tx
      .update(expenseParts)
      .set({
        categoryName: sql`(select c.name from categories c where c.org_id = ${expenseParts.orgId} and c.id = ${expenseParts.categoryId})`,
        typeName: sql`(select t.name from expense_types t where t.org_id = ${expenseParts.orgId} and t.id = ${expenseParts.typeId})`,
      })
      .where(inArray(expenseParts.expenseId, ids));
  }
  await tx
    .update(reports)
    .set({ status: routed.value, submittedAt: now, updatedAt: now })
    .where(eq(reports.id, reportId));
  const [last] = await tx
    .select({ sequence: approvalSteps.sequence })
    .from(approvalSteps)
    .where(eq(approvalSteps.reportId, reportId))
    .orderBy(desc(approvalSteps.sequence))
    .limit(1);
  const sequence = (last?.sequence ?? 0) + 1;
  const [step] = await tx
    .insert(approvalSteps)
    .values({ orgId, reportId, sequence, approverMemberId: approver, createdAt: now })
    .returning({ id: approvalSteps.id });
  if (!step) throw new Error('The approval step is not visible');
  const selfAttests = approver === submitter.memberId;
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: submitter.userId },
    entityType: 'report',
    entityId: reportId,
    action: 'report.submitted',
    payload: { stepId: step.id, sequence, approverMemberId: approver, selfAttests, expenses: ids },
  });
  return { status: 'submitted', stepId: step.id, approverMemberId: approver, selfAttests };
}

/** What the person deciding asks: approve it, or return it with a comment and rejections. */
export type Decision =
  | { readonly kind: 'approve' }
  | {
      readonly kind: 'return';
      readonly comment: string;
      /** Expenses the approver rejects, each with why, beside any the review rejects itself. */
      readonly rejections: readonly { readonly expenseId: string; readonly reason: string }[];
    };

export type DecideReportResult =
  | { readonly status: 'approved'; readonly basis: ApprovalBasis }
  | { readonly status: 'returned'; readonly basis: ApprovalBasis; readonly rejected: number }
  | { readonly status: 'missing' }
  | { readonly status: 'not_in_approval'; readonly current: ReportStatus }
  | { readonly status: 'self_approval' | 'not_an_approver' | 'not_your_approval' }
  /** Approving someone else's spend needs the second factor in this session (FR-GOV-04). */
  | { readonly status: 'second_factor_required' }
  /** These expenses differ from their receipts, so the report goes back (FR-GOV-10, FR-GOV-11). */
  | { readonly status: 'rejected'; readonly differences: readonly Difference[] }
  | { readonly status: 'invalid'; readonly message: string };

/**
 * Approves a report waiting for approval, or returns it to its member with a comment (FR-GOV-02).
 * The approver it went to decides, or an owner or finance admin in their place, never their own
 * in a team (FR-GOV-03, mayDecide()); approving someone else's needs the second factor
 * (FR-GOV-04). An expense that differs from its receipt is rejected on its own (FR-GOV-10), and
 * any rejected expense returns the whole report (FR-GOV-11), which opens again with a week to
 * close, each rejection kept with why (FR-GOV-12). Approved expenses are locked. Call inside
 * withOrg(), as the person deciding.
 */
export async function decideReport(
  tx: Transaction,
  orgId: string,
  reportId: string,
  decider: {
    readonly memberId: string;
    readonly role: MemberRole;
    readonly userId: string;
    /** Whether this session passed the second factor (aal2). */
    readonly secondFactor: boolean;
  },
  decision: Decision,
  judge: ReceiptJudge,
  now = new Date(),
): Promise<DecideReportResult> {
  await lockOrgWrites(tx, orgId);
  const [row] = await tx
    .select({ status: reports.status, memberId: reports.memberId, closesAt: reports.closesAt })
    .from(reports)
    .where(eq(reports.id, reportId))
    .for('update');
  if (!row) return { status: 'missing' };
  const [step] = await tx
    .select({ id: approvalSteps.id, approverMemberId: approvalSteps.approverMemberId })
    .from(approvalSteps)
    .where(and(eq(approvalSteps.reportId, reportId), eq(approvalSteps.decision, 'pending')))
    .orderBy(desc(approvalSteps.sequence))
    .limit(1)
    .for('update');
  if (row.status !== 'in_approval' || !step) {
    return { status: 'not_in_approval', current: row.status };
  }
  const allowed = mayDecide({
    approverMemberId: decider.memberId,
    approverRole: decider.role,
    submitterMemberId: row.memberId,
    organizationMemberCount: (await activeMembers(tx)).length,
    stepApproverMemberId: step.approverMemberId,
  });
  if (!allowed.ok) return { status: allowed.error.code };
  const basis = allowed.value;
  if (decision.kind === 'approve' && needsSecondFactor(basis) && !decider.secondFactor) {
    return { status: 'second_factor_required' };
  }

  const onIt = await reviewExpenses(tx, reportId);
  const differences = differencesOf(await judge(tx, onIt));
  let comment: string | null = null;
  const rejections = new Map<string, { reason: string; automatic: boolean }>();
  if (decision.kind === 'approve') {
    if (differences.length > 0) return { status: 'rejected', differences };
  } else {
    const cleaned = cleanApprovalNote(decision.comment, 'A comment');
    if ('error' in cleaned) return { status: 'invalid', message: cleaned.error };
    if (cleaned.value === null) {
      return { status: 'invalid', message: 'Say why it goes back, for its member to read.' };
    }
    comment = cleaned.value;
    const ids = new Set(onIt.map((e) => e.id));
    for (const d of differences) rejections.set(d.expenseId, { reason: d.reason, automatic: true });
    for (const chosen of decision.rejections) {
      if (!ids.has(chosen.expenseId)) {
        return { status: 'invalid', message: 'An expense rejected is not on this report.' };
      }
      const reason = cleanApprovalNote(chosen.reason, 'A rejection’s reason');
      if ('error' in reason) return { status: 'invalid', message: reason.error };
      if (reason.value === null) {
        return { status: 'invalid', message: 'Say why each expense is rejected.' };
      }
      const automatic = rejections.get(chosen.expenseId)?.automatic ?? false;
      rejections.set(chosen.expenseId, { reason: reason.value, automatic });
    }
  }

  // Whoever decides changes someone else's report and expenses: the database lets them, for
  // this report only, while its step is pending (migration 0045). The step is decided last.
  await tx.execute(sql`select set_config('app.deciding_report', ${reportId}, true)`);
  const event = decision.kind === 'approve' ? 'report_approved' : 'report_returned';
  const moved = onIt
    .filter((e) => transitionExpense(e.status, { type: event }).ok)
    .map((e) => e.id);
  if (moved.length > 0) {
    await tx
      .update(expenses)
      .set({ status: decision.kind === 'approve' ? 'approved' : 'ready', updatedAt: now })
      .where(inArray(expenses.id, moved));
  }
  const actor = { type: 'user', id: decider.userId } as const;
  if (decision.kind === 'approve') {
    const approved = transitionReport(row.status, { type: 'step_approved', remainingSteps: 0 });
    if (!approved.ok) throw new Error(`The report can't be approved: ${approved.error.code}`);
    await tx
      .update(reports)
      .set({ status: approved.value, approvedAt: now, updatedAt: now })
      .where(eq(reports.id, reportId));
  } else {
    if (rejections.size > 0) {
      await tx.insert(expenseRejections).values(
        [...rejections].map(([expenseId, r]) => ({
          orgId,
          stepId: step.id,
          expenseId,
          reason: r.reason,
          automatic: r.automatic,
          createdAt: now,
        })),
      );
    }
    const returned = transitionReport(row.status, { type: 'return', comment: comment ?? '' });
    if (!returned.ok) throw new Error(`The report can't be returned: ${returned.error.code}`);
    // It opens again as reopening does: its day 28, or a week from now if that is later.
    await tx
      .update(reports)
      .set({
        status: returned.value,
        closedAt: null,
        closesAt: reopenedClosesAt(row.closesAt, now),
        updatedAt: now,
      })
      .where(eq(reports.id, reportId));
  }
  await tx
    .update(approvalSteps)
    .set({
      decision: decision.kind === 'approve' ? 'approved' : 'returned',
      comment,
      decidedAt: now,
      approverMemberId: decider.memberId,
    })
    .where(eq(approvalSteps.id, step.id));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'report',
    entityId: reportId,
    action: decision.kind === 'approve' ? 'report.approved' : 'report.returned',
    payload: {
      stepId: step.id,
      basis,
      // A one-person organization's owner approved their own, and says so (FR-GOV-03).
      selfAttested: basis === 'solo_self_attestation',
      approverMemberId: decider.memberId,
      routedTo: step.approverMemberId,
      expenses: moved,
      ...(decision.kind === 'return'
        ? {
            comment,
            rejected: [...rejections].map(([expenseId, r]) => ({
              expenseId,
              reason: r.reason,
              automatic: r.automatic,
            })),
          }
        : {}),
    },
  });
  return decision.kind === 'approve'
    ? { status: 'approved', basis }
    : { status: 'returned', basis, rejected: rejections.size };
}

export type ClaimReasonResult =
  | { readonly status: 'saved'; readonly reason: string | null }
  | { readonly status: 'unchanged'; readonly reason: string | null }
  | { readonly status: 'missing' }
  | { readonly status: 'invalid'; readonly message: string }
  /** Being read, or submitted or later. */
  | { readonly status: 'not_editable' };

/**
 * A person says why an expense claims less than its receipt (FR-EXP-10, Q6), or takes the
 * reason away, with its audit event. A closed report it is on reopens. Call inside withOrg().
 */
export async function setClaimReason(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  text: string,
  actorUserId: string,
): Promise<ClaimReasonResult> {
  const cleaned = cleanApprovalNote(text);
  if ('error' in cleaned) return { status: 'invalid', message: cleaned.error };
  await lockOrgWrites(tx, orgId);
  const [expense] = await tx
    .select({ status: expenses.status, reason: expenses.claimReason })
    .from(expenses)
    .where(eq(expenses.id, expenseId))
    .for('update');
  if (!expense) return { status: 'missing' };
  if (expense.status !== 'needs_review' && expense.status !== 'ready') {
    return { status: 'not_editable' };
  }
  if (cleaned.value === expense.reason) return { status: 'unchanged', reason: expense.reason };
  const actor = { type: 'user', id: actorUserId } as const;
  await tx
    .update(expenses)
    .set({ claimReason: cleaned.value, updatedAt: new Date() })
    .where(eq(expenses.id, expenseId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.claim_reason_set',
    payload: { from: expense.reason, to: cleaned.value },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    actor,
    'a reason for claiming less changed',
  );
  return { status: 'saved', reason: cleaned.value };
}

/** A report's approval: its steps, oldest first, and what its latest return rejected. */
export interface ReportApproval {
  readonly steps: readonly ApprovalStepRecord[];
  readonly rejections: readonly RejectionRecord[];
}

/** One report's approval so far. Call inside withOrg(). */
export async function approvalOf(tx: Transaction, reportId: string): Promise<ReportApproval> {
  const steps = await listApprovalSteps(tx, [reportId]);
  const latest = steps.at(-1);
  return {
    steps,
    rejections:
      latest?.decision === 'returned' ? await listRejections(tx, [latest.id]) : ([] as const),
  };
}

/** The reports waiting for this member's decision, oldest first. Call inside withOrg(). */
export async function reportsToApprove(tx: Transaction, memberId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: reports.id })
    .from(reports)
    .innerJoin(
      approvalSteps,
      and(eq(approvalSteps.orgId, reports.orgId), eq(approvalSteps.reportId, reports.id)),
    )
    .where(
      and(
        eq(reports.status, 'in_approval'),
        eq(approvalSteps.decision, 'pending'),
        eq(approvalSteps.approverMemberId, memberId),
      ),
    )
    .orderBy(asc(reports.submittedAt), asc(reports.id));
  return rows.map((r) => r.id);
}

/** A report that came back to its member, with the comment it came back with. */
export interface ReturnedReport {
  readonly reportId: string;
  readonly step: ApprovalStepRecord;
  readonly rejections: readonly RejectionRecord[];
}

/**
 * A member's reports that came back and aren't submitted again yet, each with its latest
 * return's comment and rejections (FR-GOV-12). Call inside withOrg().
 */
export async function returnedReports(
  tx: Transaction,
  memberId: string,
): Promise<ReturnedReport[]> {
  const rows = await tx
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.memberId, memberId), inArray(reports.status, ['open', 'closed'])))
    .orderBy(asc(reports.createdAt), asc(reports.id));
  const latest = latestSteps(
    await listApprovalSteps(
      tx,
      rows.map((r) => r.id),
    ),
  );
  const returned = [...latest.values()].filter((s) => s.decision === 'returned');
  const rejections = await listRejections(
    tx,
    returned.map((s) => s.id),
  );
  return returned.map((step) => ({
    reportId: step.reportId,
    step,
    rejections: rejections.filter((r) => r.stepId === step.id),
  }));
}
