import {
  getOrganization,
  listMileageRateChanges,
  mileagePolicy,
  setMileageRate,
  type Database,
  type MileageRateChangeRecord,
  type SetMileageRateResult,
} from '@expensewise/db';
import { IRS_BUSINESS_RATES, type MileagePolicy } from '@expensewise/domain';
import { asCaller } from './caller.ts';

/** What Settings › Mileage shows of the rate a mile: the changes made, and the home currency. */
export interface MileageRateSettings {
  /** What a rate of the organization's own is set in. */
  readonly homeCurrency: string;
  /** The latest day first. */
  readonly changes: readonly MileageRateChangeRecord[];
  /** The same changes over the IRS business rates, to price a drive with. */
  readonly policy: MileagePolicy;
}

/**
 * What the API needs from the database for the organization's rate a mile (Q28, #77). Every
 * member reads it; the routes let only owners and finance admins set it. Tests use a fake.
 */
export interface MileageRateStore {
  /** What drives are paid at, to quote one before it is logged. */
  policy(orgId: string): Promise<MileagePolicy>;
  settings(orgId: string): Promise<MileageRateSettings | undefined>;
  /** Sets the rate from a day; the audit event commits with it. */
  set(
    orgId: string,
    input: { readonly effectiveFrom: string; readonly perMile: string | null },
    actor: { readonly userId: string; readonly memberId: string },
  ): Promise<SetMileageRateResult>;
}

/** The rate store on Postgres, as expensewise_app and as the caller (ADR-0035). */
export function dbMileageRateStore(db: Database): MileageRateStore {
  const inOrg = asCaller(db);
  return {
    policy: (orgId) => inOrg(orgId, (tx) => mileagePolicy(tx)),
    settings: (orgId) =>
      inOrg(orgId, async (tx) => {
        const org = await getOrganization(tx, orgId);
        if (!org) return undefined;
        const changes = await listMileageRateChanges(tx);
        return {
          homeCurrency: org.homeCurrency,
          changes,
          policy: { own: changes, irs: IRS_BUSINESS_RATES },
        };
      }),
    set: (orgId, input, actor) => inOrg(orgId, (tx) => setMileageRate(tx, orgId, input, actor)),
  };
}
