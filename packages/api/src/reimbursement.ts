import {
  CONVERSION_FLAG,
  assertRowSecurityApplies,
  getReimbursementCurrency,
  setReimbursementCurrency,
  withOrg,
  type Database,
  type ReimbursementCurrency,
  type ReportContents,
  type SetReimbursementCurrencyResult,
} from '@expensewise/db';
import type { FeatureGate } from './features.ts';

/**
 * Whether to show these reports in their reimbursement currency (FR-EXP-13): their amounts
 * were loaded, and the feature is on. Off, a report reads as it always has.
 */
export async function showConverted(
  features: FeatureGate,
  orgId: string,
  reports: readonly ReportContents[],
): Promise<boolean> {
  return (
    reports.some((r) => r.amounts !== undefined) && (await features.isOn(orgId, CONVERSION_FLAG))
  );
}

/**
 * What the API needs from the database for the currency a person is reimbursed in
 * (FR-EXP-13, Q23). Every change is audited in its own transaction. Tests use a fake.
 */
export interface ReimbursementStore {
  get(orgId: string, memberId: string): Promise<ReimbursementCurrency | undefined>;
  set(
    orgId: string,
    memberId: string,
    currency: string | null,
    actorUserId: string,
  ): Promise<SetReimbursementCurrencyResult>;
}

/** The store on Postgres, as expensewise_app. It checks the role once, before first use. */
export function dbReimbursementStore(db: Database): ReimbursementStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  return {
    async get(orgId, memberId) {
      await safe();
      return withOrg(db, orgId, (tx) => getReimbursementCurrency(tx, memberId));
    },
    async set(orgId, memberId, currency, actorUserId) {
      await safe();
      return withOrg(db, orgId, (tx) =>
        setReimbursementCurrency(tx, orgId, memberId, currency, actorUserId),
      );
    },
  };
}
