import { newId, type MemberRole } from '@expensewise/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import { seedStarterCatalog } from './categories.ts';
import { withOrg, withUser, type Database, type Transaction } from './client.ts';
import { members, memberSignIns, organizations } from './schema.ts';

export interface Membership {
  readonly orgId: string;
  readonly memberId: string;
  readonly role: MemberRole;
}

const MEMBERSHIP = { orgId: members.orgId, memberId: members.id, role: members.role };
/** A sign-in's member, in the same organization. */
const SIGN_IN_MEMBER = and(
  eq(members.orgId, memberSignIns.orgId),
  eq(members.id, memberSignIns.memberId),
);
/** A user's sign-ins to members an owner hasn't removed. */
const activeSignInsOf = (userId: string) =>
  and(eq(memberSignIns.userId, userId), isNull(members.deactivatedAt));

/**
 * The members a user signs in as, oldest sign-in first. A member an owner removed is not one.
 * Needs app.user_id set.
 */
export function membershipsOf(tx: Transaction, userId: string): Promise<Membership[]> {
  return tx
    .select(MEMBERSHIP)
    .from(memberSignIns)
    .innerJoin(members, SIGN_IN_MEMBER)
    .where(activeSignInsOf(userId))
    .orderBy(asc(memberSignIns.createdAt));
}

/** The signed-in user's memberships. Row-level security limits it to their own sign-ins. */
export async function findMemberships(db: Database, userId: string): Promise<Membership[]> {
  return withUser(db, userId, (tx) => membershipsOf(tx, userId));
}

/**
 * Whether a sign-in, a Supabase Auth user, has a verified second factor such as an
 * authenticator app, read from Supabase Auth's own record of factors as it is asked (#85,
 * ADR-0044). Nothing the app writes changes it. Plain Postgres has no Supabase Auth: false.
 */
const authenticatorOf = (userId: string) => sql<boolean>`sign_in_has_authenticator(${userId})`;

/** A member a sign-in reaches, and whether that sign-in has a verified second factor. */
export interface SignedInMember extends Membership {
  readonly authenticator: boolean;
}

/**
 * The signed-in user's first membership, as `findMemberships` finds it, and whether their
 * sign-in has a verified second factor, in one query: how the API learns who is calling, and
 * whether their password alone may act for them (#85).
 */
export async function findSignedInMember(
  db: Database,
  userId: string,
): Promise<SignedInMember | undefined> {
  return withUser(db, userId, async (tx) => {
    const [found] = await tx
      .select({ ...MEMBERSHIP, authenticator: authenticatorOf(userId) })
      .from(memberSignIns)
      .innerJoin(members, SIGN_IN_MEMBER)
      .where(activeSignInsOf(userId))
      .orderBy(asc(memberSignIns.createdAt))
      .limit(1);
    return found && { ...found, authenticator: found.authenticator === true };
  });
}

/** Whether a sign-in has a verified second factor, as above. Call inside a transaction. */
export async function signInHasAuthenticator(tx: Transaction, userId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ has: boolean }>(
    sql`select sign_in_has_authenticator(${userId}) as has`,
  );
  return rows[0]?.has === true;
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
      // It starts with the ready-made categories and types (FR-EXP-11, ADR-0036).
      await seedStarterCatalog(tx, orgId);
      await appendAuditEvent(tx, orgId, {
        actor: { type: 'user', id: owner.userId },
        entityType: 'organization',
        entityId: orgId,
        action: 'organization.created',
        payload: { via: 'first_sign_in', ownerMemberId: memberId, catalog: 'starter' },
      });
      return { membership: { orgId, memberId, role: 'owner' as const }, created: true };
    },
    { userId: owner.userId },
  );
}
