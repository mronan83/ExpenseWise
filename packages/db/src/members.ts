import {
  newId,
  type LetIn,
  type MemberRole,
  type PersonLetIn,
  type SignInStanding,
} from '@expensewise/domain';
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

/**
 * Whether the person a sign-in belongs to has a verified second factor on any email they sign
 * in with, this one or another linked to the same member (#88, Q43, ADR-0044): read through
 * `sign_in_has_authenticator`, so it answers as that does. False for a sign-in no member has.
 */
const personAuthenticatorOf = (userId: string) => sql<boolean>`person_has_authenticator(${userId})`;

/**
 * Whether a sign-in is let in (#90, Q44, ADR-0044): 'yes', 'waiting' until it passes its own
 * code, or 'no', lapsed included. Read through `sign_in_let_in`, an owner-run function, since
 * before an organization is chosen the app sees no let-in row.
 */
const letInOf = (userId: string) => sql<string>`sign_in_let_in(${userId})`;

/**
 * The emails the person a sign-in belongs to has let in, and whether one has a second factor
 * now: 'none', 'without_authenticator' or 'with_authenticator' (#90), through `person_let_in`.
 */
const personLetInOf = (userId: string) => sql<string>`person_let_in(${userId})`;

/**
 * Whether a sign-in is the one its member was made with, `members.user_id`: the email the person
 * first signed in with, the only one let in on its own (#91, Q45, ADR-0044). Set as the member is
 * made, on their first sign-in or as they accept their invite, and never changed by the app
 * (trigger `keep_first_sign_in`); linking another email, or unlinking this one, moves it to none
 * of the others. Read with the sign-in's own member row, which a user sees for their own sign-in.
 */
const FIRST_SIGN_IN = sql<boolean>`${members.userId} = ${memberSignIns.userId}`;

const LET_IN: readonly string[] = ['no', 'waiting', 'yes'] satisfies LetIn[];
const PERSON_LET_IN: readonly string[] = [
  'none',
  'without_authenticator',
  'with_authenticator',
] satisfies PersonLetIn[];

/**
 * A member a sign-in reaches, and where that sign-in stands for the second factor: whether it,
 * and its person, have one, whether it, and any email of the person's, is let in, and whether it
 * is the email they first signed in with (#85, #88, #90, #91).
 */
export interface SignedInMember extends Membership, SignInStanding {}

/** The five answers as the database gives them, read strictly. */
function standingOf(row: {
  authenticator?: unknown;
  personAuthenticator?: unknown;
  letIn?: unknown;
  personLetIn?: unknown;
  firstSignIn?: unknown;
}): SignInStanding {
  return {
    authenticator: row.authenticator === true,
    personAuthenticator: row.personAuthenticator === true,
    letIn: LET_IN.includes(row.letIn as string) ? (row.letIn as LetIn) : 'no',
    personLetIn: PERSON_LET_IN.includes(row.personLetIn as string)
      ? (row.personLetIn as PersonLetIn)
      : 'none',
    firstSignIn: row.firstSignIn === true,
  };
}

/** The four questions, asked of one sign-in in the same query. */
const standingQuestions = (userId: string) => ({
  authenticator: authenticatorOf(userId),
  personAuthenticator: personAuthenticatorOf(userId),
  letIn: letInOf(userId),
  personLetIn: personLetInOf(userId),
});

/**
 * The signed-in user's first membership, as `findMemberships` finds it, and where their sign-in
 * stands for the second factor, in one query: how the API learns who is calling, and how far
 * their session may act for them (#85, #88, #90, #91).
 */
export async function findSignedInMember(
  db: Database,
  userId: string,
): Promise<SignedInMember | undefined> {
  return withUser(db, userId, async (tx) => {
    const [found] = await tx
      .select({ ...MEMBERSHIP, ...standingQuestions(userId), firstSignIn: FIRST_SIGN_IN })
      .from(memberSignIns)
      .innerJoin(members, SIGN_IN_MEMBER)
      .where(activeSignInsOf(userId))
      .orderBy(asc(memberSignIns.createdAt))
      .limit(1);
    if (!found) return undefined;
    const { orgId, memberId, role } = found;
    return { orgId, memberId, role, ...standingOf(found) };
  });
}

/** Whether a sign-in has a verified second factor, as above. Call inside a transaction. */
export async function signInHasAuthenticator(tx: Transaction, userId: string): Promise<boolean> {
  const { rows } = await tx.execute<{ has: boolean }>(
    sql`select sign_in_has_authenticator(${userId}) as has`,
  );
  return rows[0]?.has === true;
}

/**
 * Where a sign-in stands for the second factor, as `findSignedInMember` reads it (#88, #90,
 * #91). Call inside a transaction that sees the sign-in and its member: the user's own
 * (`withUser`) or their organization's (`withOrg`); otherwise it isn't the first.
 */
export async function signInStanding(tx: Transaction, userId: string): Promise<SignInStanding> {
  const q = standingQuestions(userId);
  const { rows } = await tx.execute<{
    authenticator: unknown;
    personAuthenticator: unknown;
    letIn: unknown;
    personLetIn: unknown;
    firstSignIn: unknown;
  }>(
    sql`select ${q.authenticator} as "authenticator", ${q.personAuthenticator} as "personAuthenticator",
               ${q.letIn} as "letIn", ${q.personLetIn} as "personLetIn",
               exists (select 1 from ${memberSignIns} join ${members} on ${SIGN_IN_MEMBER}
                        where ${memberSignIns.userId} = ${userId} and ${FIRST_SIGN_IN}) as "firstSignIn"`,
  );
  return standingOf(rows[0] ?? {});
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
