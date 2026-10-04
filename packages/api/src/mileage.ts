import {
  editMileage,
  getExpense,
  getMileage,
  logMileage,
  type Database,
  type EditMileageResult,
  type ExpenseRecord,
  type LogMileageResult,
  type MileageRecord,
} from '@expensewise/db';
import type { IsoDate, MileageInput } from '@expensewise/domain';
import { asCaller } from './caller.ts';

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

/** The mileage store on Postgres, as expensewise_app and as the caller. */
export function dbMileageStore(db: Database): MileageStore {
  // As the caller, so row-level security shows and changes only what their role allows (ADR-0035).
  const inOrg = asCaller(db);

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
