import {
  applyOrganizationEdit,
  DUPLICATE_TIME_WINDOW_MINUTES,
  isDuplicateWindow,
  type OrganizationChange,
  type OrganizationDetails,
  type OrganizationEdit,
  type OrganizationEditProblem,
} from '@expensewise/domain';
import { eq, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Transaction } from './client.ts';
import { featureOn } from './features.ts';
import { organizations } from './schema.ts';

/** An organization with its details and settings (FR-PLT-11, FR-INT-19). */
export interface OrganizationRecord extends OrganizationDetails {
  readonly id: string;
  /** The window the owner set, or null for the default. */
  readonly duplicateWindowMinutes: number | null;
}

const organizationColumns = {
  id: organizations.id,
  name: organizations.name,
  homeCurrency: organizations.homeCurrency,
  country: organizations.country,
  locale: organizations.locale,
  timeZone: organizations.timeZone,
  address: organizations.address,
  industry: organizations.industry,
  size: organizations.size,
  duplicateWindowMinutes: organizations.duplicateWindowMinutes,
};

/**
 * The organization, with its details and settings. Filters by id itself, so it works as the
 * schema owner too. Call inside withOrg().
 */
export async function getOrganization(
  tx: Transaction,
  orgId: string,
): Promise<OrganizationRecord | undefined> {
  const [row] = await tx
    .select(organizationColumns)
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row;
}

/** Whether Postgres knows a time zone by this name, as the report schedule will ask it to. */
async function postgresKnowsZone(tx: Transaction, zone: string): Promise<boolean> {
  const { rows } = await tx.execute<{ known: boolean }>(
    sql`select exists (select 1 from pg_timezone_names where name = ${zone}) as known`,
  );
  return rows[0]?.known === true;
}

export type UpdateOrganizationResult =
  | {
      readonly status: 'updated';
      readonly organization: OrganizationRecord;
      readonly changes: readonly OrganizationChange[];
    }
  | { readonly status: 'unchanged'; readonly organization: OrganizationRecord }
  | { readonly status: 'invalid'; readonly problem: OrganizationEditProblem }
  | { readonly status: 'missing' };

/**
 * The owner changes the organization's details (FR-PLT-11), with one audit event that lists
 * each change from and to. Who may, and whether the feature is on, are the caller's to check.
 * A new home currency applies to what is made from now on: reports already opened keep theirs
 * and no amount is converted. Call inside withOrg().
 */
export async function updateOrganization(
  tx: Transaction,
  orgId: string,
  edit: OrganizationEdit,
  actorUserId: string,
): Promise<UpdateOrganizationResult> {
  const [current] = await tx
    .select(organizationColumns)
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for('update');
  if (!current) return { status: 'missing' };
  const applied = applyOrganizationEdit(current, edit);
  if (!applied.ok) return { status: 'invalid', problem: applied.error };
  const { details, changes } = applied.value;
  if (changes.length === 0) return { status: 'unchanged', organization: current };
  if (details.timeZone !== current.timeZone && details.timeZone !== null) {
    if (!(await postgresKnowsZone(tx, details.timeZone))) {
      return {
        status: 'invalid',
        problem: { field: 'timeZone', message: 'ExpenseWise doesn’t know that time zone.' },
      };
    }
  }
  const [saved] = await tx
    .update(organizations)
    .set(details)
    .where(eq(organizations.id, orgId))
    .returning(organizationColumns);
  if (!saved) return { status: 'missing' };
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'organization',
    entityId: orgId,
    action: 'organization.updated',
    payload: { changes },
  });
  return { status: 'updated', organization: saved, changes };
}

/** The window an organization's receipts are judged by: the owner's, or the default. */
export const windowOf = (org: Pick<OrganizationRecord, 'duplicateWindowMinutes'>): number =>
  org.duplicateWindowMinutes ?? DUPLICATE_TIME_WINDOW_MINUTES;

export type SetDuplicateWindowResult =
  | { readonly status: 'changed'; readonly from: number; readonly to: number }
  | { readonly status: 'unchanged'; readonly minutes: number }
  | { readonly status: 'invalid' }
  | { readonly status: 'missing' };

/**
 * The owner sets the duplicate time window for everyone (FR-INT-19, Q24): 0 to 120 minutes. It
 * judges pairs from then on; pairs already flagged or kept stay as they are. Each change is in
 * the audit trail; setting what it already is records nothing. Call inside withOrg().
 */
export async function setDuplicateWindow(
  tx: Transaction,
  orgId: string,
  minutes: number,
  actorUserId: string,
): Promise<SetDuplicateWindowResult> {
  if (!isDuplicateWindow(minutes)) return { status: 'invalid' };
  const [current] = await tx
    .select({ duplicateWindowMinutes: organizations.duplicateWindowMinutes })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .for('update');
  if (!current) return { status: 'missing' };
  const from = windowOf(current);
  if (from === minutes) return { status: 'unchanged', minutes };
  await tx
    .update(organizations)
    .set({ duplicateWindowMinutes: minutes })
    .where(eq(organizations.id, orgId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'organization',
    entityId: orgId,
    action: 'organization.duplicate_window_set',
    payload: { from, to: minutes },
  });
  return { status: 'changed', from, to: minutes };
}

/**
 * The time zone background work counts the organization's days in (ADR-0037): its own, when
 * organization settings are on and it has one; otherwise null, and the rules count at UTC−12
 * as they always have. Works as the schema owner too. Call inside withOrg().
 */
export async function organizationTimeZone(tx: Transaction, orgId: string): Promise<string | null> {
  if (!(await featureOn(tx, orgId, 'settings.organization'))) return null;
  const [row] = await tx
    .select({ timeZone: organizations.timeZone })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row?.timeZone ?? null;
}

/**
 * The window the organization's receipts are judged by (FR-INT-19): the owner's, when the
 * setting is on; otherwise the default of 30 minutes. Works as the schema owner too, as the
 * release's duplicate check runs. Call inside withOrg().
 */
export async function duplicateWindowFor(tx: Transaction, orgId: string): Promise<number> {
  if (!(await featureOn(tx, orgId, 'settings.duplicate-window'))) {
    return DUPLICATE_TIME_WINDOW_MINUTES;
  }
  const [row] = await tx
    .select({ duplicateWindowMinutes: organizations.duplicateWindowMinutes })
    .from(organizations)
    .where(eq(organizations.id, orgId));
  return row ? windowOf(row) : DUPLICATE_TIME_WINDOW_MINUTES;
}
