import {
  assertRowSecurityApplies,
  COMPANY_PAID_FLAG,
  setExpensePaidBy,
  setTypeCompanyPays,
  withOrg,
  type Database,
  type ExpenseRecord,
  type ReportContents,
  type PolicyActor,
  type SetCompanyPaysResult,
  type SetPaidByResult,
} from '@expensewise/db';
import { paidByOf, type PaidByChoice } from '@expensewise/domain';
import { asCaller } from './caller.ts';
import type { FeatureGate } from './features.ts';
import type { ReportsNeedingYou } from './reports.ts';

/*
 * Paid by the company (F-62, FR-EXP-17, FR-EXP-18, ADR-0045), behind `expenses.company-paid`:
 * who paid each expense, and the organization's policy of the types the company pays directly.
 * Off, `company_paid` is ignored everywhere and every screen and export reads as before.
 */

/**
 * Whether to show who paid, and leave what the company paid out of every claim: the records
 * were `read` with who paid them, and the feature is on. It is asked only then, so a store that
 * reads none, such as a test's, reads as it always has.
 */
export async function showCompanyPaid(
  features: FeatureGate,
  orgId: string,
  read: boolean,
): Promise<boolean> {
  return read && (await features.isOn(orgId, COMPANY_PAID_FLAG));
}

/** Whether to show these reports' claims without what the company paid (FR-EXP-17). */
export const companyPaidShown = (
  features: FeatureGate,
  orgId: string,
  reports: readonly ReportContents[],
): Promise<boolean> =>
  showCompanyPaid(
    features,
    orgId,
    reports.some((r) => r.payers !== undefined),
  );

/** Every report Needs you shows: the person's, those that came back and those to approve. */
export const reportsIn = (needs: ReportsNeedingYou): ReportContents[] => [
  ...needs.reports,
  ...(needs.returned ?? []).map((r) => r.report),
  ...(needs.toApprove ?? []),
];

/** Whether these expenses were read with who paid them. */
export const readPaidBy = (expenses: readonly Pick<ExpenseRecord, 'companyPaid'>[]) =>
  expenses.some((e) => e.companyPaid !== undefined);

/** Who paid an expense, as its views show it while the feature is on. */
export const paidByView = (expense: Pick<ExpenseRecord, 'companyPaid' | 'companyPaidPinned'>) => ({
  paidBy: paidByOf(expense.companyPaid ?? false),
  paidByPinned: expense.companyPaidPinned ?? false,
});

/**
 * What the API needs from the database for who paid. Each change is audited in its own
 * transaction. Tests use the database, or a fake.
 */
export interface CompanyPaidStore {
  /** A person sets who paid one of their expenses, or hands it back to the policy (Q46). */
  setPaidBy(
    orgId: string,
    expenseId: string,
    choice: PaidByChoice,
    actorUserId: string,
  ): Promise<SetPaidByResult>;
  /**
   * Changes the policy for one type, and every unsubmitted expense of it not set by hand
   * follows it (Q48). The caller has checked that the actor may.
   */
  setCompanyPays(
    orgId: string,
    typeId: string,
    companyPays: boolean,
    actor: PolicyActor,
  ): Promise<SetCompanyPaysResult>;
}

/**
 * The store on Postgres, as expensewise_app. A person's switch runs as the caller, so they
 * change only their own expenses (ADR-0035). A change of the policy runs for the system once
 * the route has checked the caller is an owner or finance admin: it reaches every member's
 * expenses of the type, which no member may change for another.
 */
export function dbCompanyPaidStore(db: Database): CompanyPaidStore {
  const asTheCaller = asCaller(db);
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  return {
    setPaidBy: (orgId, expenseId, choice, actor) =>
      asTheCaller(orgId, (tx) => setExpensePaidBy(tx, orgId, expenseId, choice, actor)),
    async setCompanyPays(orgId, typeId, companyPays, actor) {
      await safe();
      return withOrg(db, orgId, (tx) => setTypeCompanyPays(tx, orgId, typeId, companyPays, actor));
    },
  };
}
