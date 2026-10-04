import type { RouteProvider } from '@expensewise/domain';
import { eq, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import type { Transaction } from './client.ts';
import { routeServiceKeys } from './schema.ts';

/**
 * An organization's key for the routing service, as stored: ciphertext only, bound to the
 * organization and provider, with its last four characters (Q31, ADR-0039).
 */
export interface StoredRouteKey {
  readonly provider: RouteProvider;
  readonly ciphertext: string;
  readonly keyHint: string;
  readonly verifiedAt: Date | null;
  readonly updatedAt: Date;
}

const columns = {
  provider: routeServiceKeys.provider,
  ciphertext: routeServiceKeys.ciphertext,
  keyHint: routeServiceKeys.keyHint,
  verifiedAt: routeServiceKeys.verifiedAt,
  updatedAt: routeServiceKeys.updatedAt,
};

/** The organization's key for a routing service, or undefined. Call inside withOrg(). */
export async function getRouteKey(
  tx: Transaction,
  provider: RouteProvider,
): Promise<StoredRouteKey | undefined> {
  const [row] = await tx
    .select(columns)
    .from(routeServiceKeys)
    .where(eq(routeServiceKeys.provider, provider));
  return row;
}

export interface RouteKeyWrite {
  readonly provider: RouteProvider;
  readonly ciphertext: string;
  readonly keyHint: string;
  readonly verifiedAt: Date;
  readonly memberId: string;
}

const keyEntity = (provider: RouteProvider) => ({
  entityType: 'route_service_key',
  entityId: provider,
});

/**
 * Saves the key for a routing service, replacing any earlier one, with its audit event. The
 * event names the key by its last four characters only. Call inside withOrg().
 */
export async function saveRouteKey(
  tx: Transaction,
  orgId: string,
  key: RouteKeyWrite,
  actorUserId: string,
): Promise<StoredRouteKey> {
  const values = {
    ciphertext: key.ciphertext,
    keyHint: key.keyHint,
    verifiedAt: key.verifiedAt,
    updatedByMemberId: key.memberId,
    updatedAt: sql`now()`,
  };
  const [row] = await tx
    .insert(routeServiceKeys)
    .values({ orgId, provider: key.provider, ...values })
    .onConflictDoUpdate({
      target: [routeServiceKeys.orgId, routeServiceKeys.provider],
      set: values,
    })
    .returning(columns);
  if (!row) throw new Error('saving the route key returned no row');
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    ...keyEntity(key.provider),
    action: 'route_service_key.saved',
    // Never the key itself.
    payload: { keyHint: key.keyHint, memberId: key.memberId },
  });
  return row;
}

/** Removes the key for a routing service, with its audit event. False when there was none. */
export async function deleteRouteKey(
  tx: Transaction,
  orgId: string,
  provider: RouteProvider,
  actorUserId: string,
): Promise<boolean> {
  const removed = await tx
    .delete(routeServiceKeys)
    .where(eq(routeServiceKeys.provider, provider))
    .returning({ keyHint: routeServiceKeys.keyHint });
  if (removed.length === 0) return false;
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    ...keyEntity(provider),
    action: 'route_service_key.removed',
    payload: { keyHint: removed[0]!.keyHint },
  });
  return true;
}
