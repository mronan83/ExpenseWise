import {
  assertRowSecurityApplies,
  editMileage,
  getExpense,
  getMileage,
  logMileage,
  withOrg,
  type Database,
  type EditMileageResult,
  type ExpenseRecord,
  type LogMileageResult,
  type MileageRecord,
} from '@expensewise/db';
import type { IsoDate, MileageInput } from '@expensewise/domain';

/** A drive and the expense that claims it. */
export interface MileageEntry {
  readonly expense: ExpenseRecord;
  readonly mileage: MileageRecord;
}

/**
 * What the API needs from the database for mileage (FR-CAP-03). Every call names the member:
 * a member's drives are their own. Tests use an in-memory fake.
 */
export interface MileageStore {
  /** Logs a drive; the expense, its mileage log and the audit event commit together. */
  log(
    orgId: string,
    memberId: string,
    input: MileageInput,
    actorUserId: string,
    today: IsoDate,
  ): Promise<LogMileageResult>;
  /** One of the member's drives, or undefined: another member's is not found. */
  get(orgId: string, memberId: string, expenseId: string): Promise<MileageEntry | undefined>;
  edit(
    orgId: string,
    memberId: string,
    expenseId: string,
    input: MileageInput,
    actorUserId: string,
    today: IsoDate,
  ): Promise<EditMileageResult>;
}

/** The mileage store on Postgres, as expensewise_app. It checks the role once. */
export function dbMileageStore(db: Database): MileageStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  const inOrg = async <T>(orgId: string, work: Parameters<typeof withOrg<T>>[2]) => {
    await safe();
    return withOrg(db, orgId, work);
  };

  return {
    log: (orgId, memberId, input, actor, today) =>
      inOrg(orgId, (tx) => logMileage(tx, orgId, memberId, input, actor, today)),
    get: (orgId, memberId, expenseId) =>
      inOrg(orgId, async (tx) => {
        const mileage = await getMileage(tx, memberId, expenseId);
        const expense = mileage && (await getExpense(tx, expenseId));
        return mileage && expense ? { mileage, expense } : undefined;
      }),
    edit: (orgId, memberId, expenseId, input, actor, today) =>
      inOrg(orgId, (tx) => editMileage(tx, orgId, memberId, expenseId, input, actor, today)),
  };
}
