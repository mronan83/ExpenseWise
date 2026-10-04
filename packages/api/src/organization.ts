import {
  assertRowSecurityApplies,
  getOrganization,
  setDuplicateWindow,
  updateOrganization,
  withOrg,
  type Database,
  type OrganizationRecord,
  type SetDuplicateWindowResult,
  type UpdateOrganizationResult,
} from '@expensewise/db';
import type { OrganizationEdit } from '@expensewise/domain';

/**
 * What the API needs from the database for the organization's own settings (FR-PLT-11,
 * FR-INT-19). Every write appends its audit event in the same transaction. Tests use an
 * in-memory fake.
 */
export interface OrganizationStore {
  get(orgId: string): Promise<OrganizationRecord | undefined>;
  update(
    orgId: string,
    edit: OrganizationEdit,
    actorUserId: string,
  ): Promise<UpdateOrganizationResult>;
  setDuplicateWindow(
    orgId: string,
    minutes: number,
    actorUserId: string,
  ): Promise<SetDuplicateWindowResult>;
}

/** The store on Postgres, as expensewise_app. It checks the role once, before first use. */
export function dbOrganizationStore(db: Database): OrganizationStore {
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
    get: (orgId) => inOrg(orgId, (tx) => getOrganization(tx, orgId)),
    update: (orgId, edit, actor) =>
      inOrg(orgId, (tx) => updateOrganization(tx, orgId, edit, actor)),
    setDuplicateWindow: (orgId, minutes, actor) =>
      inOrg(orgId, (tx) => setDuplicateWindow(tx, orgId, minutes, actor)),
  };
}
