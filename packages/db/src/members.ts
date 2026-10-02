import { newId, type MemberRole } from '@expensewise/domain';
import { asc, eq, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import { withOrg, withUser, type Database } from './client.ts';
import { members, organizations } from './schema.ts';

export interface Membership {
  readonly orgId: string;
  readonly memberId: string;
  readonly role: MemberRole;
}

/** The signed-in user's memberships, oldest first. Row-level security limits it to theirs. */
export async function findMemberships(db: Database, userId: string): Promise<Membership[]> {
  return withUser(db, userId, (tx) =>
    tx
      .select({ orgId: members.orgId, memberId: members.id, role: members.role })
      .from(members)
      .where(eq(members.userId, userId))
      .orderBy(asc(members.createdAt)),
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
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`bootstrap:${owner.userId}`}, 0))`,
      );
      const [existing] = await tx
        .select({ orgId: members.orgId, memberId: members.id, role: members.role })
        .from(members)
        .where(eq(members.userId, owner.userId))
        .orderBy(asc(members.createdAt))
        .limit(1);
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
