import { parseOverrides, type FlagKey } from '@expensewise/flags';
import { and, eq } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Transaction } from './client.ts';
import { enqueueOutbox } from './outbox.ts';
import { orgFeatures } from './schema.ts';

/**
 * Announces a switch, so work that waits on a feature can start once it is on (ADR-0017). The
 * payload names the flag and whether it is now on.
 */
export const FEATURE_SWITCHED = 'feature.switched';

/** A feature the organization's owner has switched, on or off. */
export interface OrgFeature {
  readonly flag: string;
  readonly enabled: boolean;
  readonly updatedAt: Date;
}

/** Every feature this organization has switched. One with no row is off. Call inside withOrg(). */
export async function listOrgFeatures(tx: Transaction, orgId: string): Promise<OrgFeature[]> {
  return tx
    .select({
      flag: orgFeatures.flag,
      enabled: orgFeatures.enabled,
      updatedAt: orgFeatures.updatedAt,
    })
    .from(orgFeatures)
    .where(eq(orgFeatures.orgId, orgId));
}

/** Whether the organization has switched this feature on. Call inside withOrg(). */
export async function orgFeatureOn(tx: Transaction, orgId: string, flag: string): Promise<boolean> {
  const [row] = await tx
    .select({ enabled: orgFeatures.enabled })
    .from(orgFeatures)
    .where(and(eq(orgFeatures.orgId, orgId), eq(orgFeatures.flag, flag)));
  return row?.enabled ?? false;
}

/**
 * Whether a feature is on for the organization, for work no API request starts, such as a
 * workflow or the report schedule: FLAG_OVERRIDES wins, as the server's kill switch, then the
 * owner's switch, then off, the same order as the API's FeatureGate (ADR-0032). Call inside
 * withOrg().
 */
export async function featureOn(
  tx: Transaction,
  orgId: string,
  flag: FlagKey,
  overrides: string | undefined = process.env.FLAG_OVERRIDES,
): Promise<boolean> {
  return featureOverride(flag, overrides) ?? orgFeatureOn(tx, orgId, flag);
}

/** What FLAG_OVERRIDES forces a feature to for every organization, if anything. */
export function featureOverride(
  flag: FlagKey,
  overrides: string | undefined = process.env.FLAG_OVERRIDES,
): boolean | undefined {
  return parseOverrides(overrides)[flag];
}

/**
 * Switches a feature on or off for the organization, with its audit event and the event that
 * announces it. Returns whether
 * anything changed. Who may switch it, and which flags exist, are the caller's to check.
 */
export async function setOrgFeature(
  tx: Transaction,
  orgId: string,
  change: { flag: string; enabled: boolean; memberId: string },
  actorUserId: string,
): Promise<'switched' | 'unchanged'> {
  const [before] = await tx
    .select({ enabled: orgFeatures.enabled })
    .from(orgFeatures)
    .where(and(eq(orgFeatures.orgId, orgId), eq(orgFeatures.flag, change.flag)))
    .for('update');
  if ((before?.enabled ?? false) === change.enabled) return 'unchanged';
  await tx
    .insert(orgFeatures)
    .values({
      orgId,
      flag: change.flag,
      enabled: change.enabled,
      updatedByMemberId: change.memberId,
    })
    .onConflictDoUpdate({
      target: [orgFeatures.orgId, orgFeatures.flag],
      set: { enabled: change.enabled, updatedByMemberId: change.memberId, updatedAt: new Date() },
    });
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'feature',
    entityId: change.flag,
    action: change.enabled ? 'feature.switched_on' : 'feature.switched_off',
    payload: { flag: change.flag, enabled: change.enabled },
  });
  await enqueueOutbox(tx, orgId, FEATURE_SWITCHED, { flag: change.flag, enabled: change.enabled });
  return 'switched';
}
