import { and, eq } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Transaction } from './client.ts';
import { orgFeatures } from './schema.ts';

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
 * Switches a feature on or off for the organization, with its audit event. Returns whether
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
  return 'switched';
}
