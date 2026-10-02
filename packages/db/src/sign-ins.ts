import { and, asc, eq, sql } from 'drizzle-orm';
import { appendAuditEvent } from './audit.ts';
import { switchOrg, withOrg, type Database, type Transaction } from './client.ts';
import { lockSignIn, type Membership } from './members.ts';
import {
  aiProviderKeys,
  categories,
  expenses,
  memberSignIns,
  members,
  mileageLogs,
  receipts,
  reports,
  trips,
} from './schema.ts';

export interface SignIn {
  readonly id: string;
  readonly userId: string;
  readonly email: string;
  readonly createdAt: Date;
}

const columns = {
  id: memberSignIns.id,
  userId: memberSignIns.userId,
  email: memberSignIns.email,
  createdAt: memberSignIns.createdAt,
};

/** A member's sign-ins, oldest first. Call inside withOrg(). */
export function listSignIns(tx: Transaction, memberId: string): Promise<SignIn[]> {
  return tx
    .select(columns)
    .from(memberSignIns)
    .where(eq(memberSignIns.memberId, memberId))
    .orderBy(asc(memberSignIns.createdAt));
}

/** Tables whose rows mean an organization holds someone's work. */
const WORK_TABLES = [receipts, expenses, trips, mileageLogs, reports, categories, aiProviderKeys];

/**
 * Whether the current organization can be left behind without losing anything: one member,
 * one sign-in, and none of the tables that hold work. Call inside withOrg().
 */
async function isEmptySoloOrganization(tx: Transaction): Promise<boolean> {
  const [people] = await tx.select({ n: sql<number>`count(*)::int` }).from(members);
  const [ways] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberSignIns);
  if (people?.n !== 1 || ways?.n !== 1) return false;
  for (const table of WORK_TABLES) {
    if (
      (
        await tx
          .select({ one: sql`1` })
          .from(table)
          .limit(1)
      ).length > 0
    )
      return false;
  }
  return true;
}

export type LinkResult =
  | { readonly status: 'linked'; readonly signIn: SignIn }
  | { readonly status: 'already_linked'; readonly signIn: SignIn }
  /** The sign-in reaches someone else in this organization. */
  | { readonly status: 'other_member' }
  /** The sign-in has its own organization with work in it, or other people. */
  | { readonly status: 'has_own_organization' };

/**
 * Adds a sign-in to `member`, so it reaches the same organization and the same person. The
 * caller must have proven control of both: `member` from the request's token, and the other
 * sign-in from a second token. A sign-in that already has an empty one-person organization
 * of its own (it signed in once before) moves; anything else is refused and nothing changes.
 * Audited in each organization touched, in one transaction.
 */
export async function linkSignIn(
  db: Database,
  member: Membership,
  other: { readonly userId: string; readonly email: string },
  actorUserId: string,
): Promise<LinkResult> {
  return withOrg(
    db,
    member.orgId,
    async (tx) => {
      await lockSignIn(tx, other.userId);
      // Visible through own_sign_ins wherever it is, since app.user_id is the other sign-in.
      const [current] = await tx
        .select({ ...columns, orgId: memberSignIns.orgId, memberId: memberSignIns.memberId })
        .from(memberSignIns)
        .where(eq(memberSignIns.userId, other.userId));

      if (current?.orgId === member.orgId) {
        if (current.memberId !== member.memberId) return { status: 'other_member' };
        const { orgId: _o, memberId: _m, ...signIn } = current;
        return { status: 'already_linked', signIn };
      }

      if (current) {
        await switchOrg(tx, current.orgId);
        if (!(await isEmptySoloOrganization(tx))) return { status: 'has_own_organization' };
        await tx.delete(memberSignIns).where(eq(memberSignIns.id, current.id));
        await appendAuditEvent(tx, current.orgId, {
          actor: { type: 'user', id: other.userId },
          entityType: 'member_sign_in',
          entityId: current.id,
          action: 'member_sign_in.moved_out',
          payload: { memberId: current.memberId },
        });
        await switchOrg(tx, member.orgId);
      }

      const [signIn] = await tx
        .insert(memberSignIns)
        .values({
          orgId: member.orgId,
          memberId: member.memberId,
          userId: other.userId,
          email: other.email,
        })
        .returning(columns);
      if (!signIn) throw new Error('The new sign-in was not returned');
      await appendAuditEvent(tx, member.orgId, {
        actor: { type: 'user', id: actorUserId },
        entityType: 'member_sign_in',
        entityId: signIn.id,
        action: 'member_sign_in.linked',
        payload: { memberId: member.memberId, movedFromAnotherOrganization: current !== undefined },
      });
      return { status: 'linked', signIn };
    },
    { userId: other.userId },
  );
}

/**
 * Removes one of `member`'s sign-ins. 'not_found' when the member has no such sign-in, and
 * 'last' when it is the only one left, which would lock the member out.
 */
export async function unlinkSignIn(
  db: Database,
  member: Membership,
  signInId: string,
  actorUserId: string,
): Promise<'removed' | 'not_found' | 'last'> {
  return withOrg(db, member.orgId, async (tx) => {
    const mine = await listSignIns(tx, member.memberId);
    if (!mine.some((s) => s.id === signInId)) return 'not_found';
    if (mine.length === 1) return 'last';
    const removed = await tx
      .delete(memberSignIns)
      .where(and(eq(memberSignIns.id, signInId), eq(memberSignIns.memberId, member.memberId)))
      .returning({ id: memberSignIns.id });
    if (removed.length === 0) return 'not_found';
    await appendAuditEvent(tx, member.orgId, {
      actor: { type: 'user', id: actorUserId },
      entityType: 'member_sign_in',
      entityId: signInId,
      action: 'member_sign_in.removed',
      payload: { memberId: member.memberId },
    });
    return 'removed';
  });
}
