import { newId, type MemberRole } from '@expensewise/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import { withOrg, withUser, type Database, type Transaction } from './client.ts';
import { members, memberSignIns, organizations } from './schema.ts';

export interface Membership {
  readonly orgId: string;
  readonly memberId: string;
  readonly role: MemberRole;
}

/** The members a user signs in as, oldest sign-in first. Needs app.user_id set. */
export function membershipsOf(tx: Transaction, userId: string): Promise<Membership[]> {
  return tx
    .select({ orgId: members.orgId, memberId: members.id, role: members.role })
    .from(memberSignIns)
    .innerJoin(
      members,
      and(eq(members.orgId, memberSignIns.orgId), eq(members.id, memberSignIns.memberId)),
    )
    .where(eq(memberSignIns.userId, userId))
    .orderBy(asc(memberSignIns.createdAt));
}

/** The signed-in user's memberships. Row-level security limits it to their own sign-ins. */
export async function findMemberships(db: Database, userId: string): Promise<Membership[]> {
  return withUser(db, userId, (tx) => membershipsOf(tx, userId));
}

/** Serializes everything that decides which member a sign-in belongs to. */
export async function lockSignIn(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`bootstrap:${userId}`}, 0))`,
  );
}

export interface NewOwner {
  readonly userId: string;
  readonly email: string;
}

/**
 * Returns the user's first membership, creating a one-person organization with the user as
 * owner when there is none (Phase 1: the owner's organization appears on first sign-in).
 * Safe to call on every sign-in: a per-user lock makes concurrent first calls create one.
 */
export async function ensureOwnerOrganization(
  db: Database,
  owner: NewOwner,
): Promise<{ membership: Membership; created: boolean }> {
  const orgId = newId();
  const memberId = newId();
  return withOrg(
    db,
    orgId,
    async (tx) => {
      await lockSignIn(tx, owner.userId);
      const [existing] = await membershipsOf(tx, owner.userId);
      if (existing) return { membership: existing, created: false };

      const displayName = owner.email.split('@')[0] || owner.email;
      await tx
        .insert(organizations)
        .values({ id: orgId, name: `${displayName}'s organization`, homeCurrency: 'USD' });
      await tx.insert(members).values({
        id: memberId,
        orgId,
        userId: owner.userId,
        email: owner.email,
        displayName,
        role: 'owner',
      });
      await tx
        .insert(memberSignIns)
        .values({ orgId, memberId, userId: owner.userId, email: owner.email });
      await appendAuditEvent(tx, orgId, {
        actor: { type: 'user', id: owner.userId },
        entityType: 'organization',
        entityId: orgId,
        action: 'organization.created',
        payload: { via: 'first_sign_in', ownerMemberId: memberId },
      });
      return { membership: { orgId, memberId, role: 'owner' as const }, created: true };
    },
    { userId: owner.userId },
  );
}
