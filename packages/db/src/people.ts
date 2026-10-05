import { createHash, randomBytes } from 'node:crypto';
import {
  inviteState,
  leavesNoOwner,
  mayChooseApprover,
  newId,
  type InviteState,
  type MemberRole,
} from '@expensewise/domain';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites } from './audit.ts';
import { switchOrg, withUser, type Database, type Transaction } from './client.ts';
import { lockSignIn, type Membership } from './members.ts';
import { memberInvites, memberSignIns, members, organizations } from './schema.ts';
import { isEmptySoloOrganization } from './sign-ins.ts';

/*
 * The people in an organization and the links that let someone join it (FR-PLT-07,
 * ADR-0035). Who may do each of these is the caller's to check: in Phase 1, only an owner.
 */

/** Someone in the organization, or someone an owner removed, whose records stay. */
export interface PersonRecord {
  readonly memberId: string;
  readonly displayName: string;
  readonly email: string;
  readonly role: MemberRole;
  readonly joinedAt: Date;
  /** When an owner removed them; null while they are a member. */
  readonly removedAt: Date | null;
}

/** An invite link, as its organization's owners see it. Never the token. */
export interface InviteRecord {
  readonly id: string;
  readonly role: MemberRole;
  readonly label: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

/** A new invite token: 32 random bytes, as base64url. Shown once, never stored. */
export function newInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What is stored of a token: its SHA-256, as hex. */
export function inviteTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Everyone in the organization, the earliest to join first. Call inside withOrg(). */
export function listPeople(tx: Transaction): Promise<PersonRecord[]> {
  return tx
    .select({
      memberId: members.id,
      displayName: members.displayName,
      email: members.email,
      role: members.role,
      joinedAt: members.createdAt,
      removedAt: members.deactivatedAt,
    })
    .from(members)
    .orderBy(asc(members.createdAt), asc(members.id));
}

const inviteColumns = {
  id: memberInvites.id,
  role: memberInvites.role,
  label: memberInvites.label,
  createdBy: members.displayName,
  createdAt: memberInvites.createdAt,
  expiresAt: memberInvites.expiresAt,
  acceptedAt: memberInvites.acceptedAt,
  revokedAt: memberInvites.revokedAt,
};

/** Invites not yet used or revoked, expired ones too, newest first. Call inside withOrg(). */
export function listOpenInvites(tx: Transaction): Promise<InviteRecord[]> {
  return tx
    .select(inviteColumns)
    .from(memberInvites)
    .innerJoin(
      members,
      and(eq(members.orgId, memberInvites.orgId), eq(members.id, memberInvites.createdByMemberId)),
    )
    .where(and(isNull(memberInvites.acceptedAt), isNull(memberInvites.revokedAt)))
    .orderBy(desc(memberInvites.createdAt), desc(memberInvites.id));
}

export interface NewInvite {
  readonly role: MemberRole;
  readonly label: string | null;
  readonly tokenHash: string;
  readonly madeAt: Date;
  readonly expiresAt: Date;
  /** The member making it. */
  readonly memberId: string;
}

/** Makes an invite link, with its audit event. Call inside withOrg(). */
export async function createInvite(
  tx: Transaction,
  orgId: string,
  input: NewInvite,
  actorUserId: string,
): Promise<InviteRecord> {
  const id = newId();
  await tx.insert(memberInvites).values({
    id,
    orgId,
    role: input.role,
    label: input.label,
    tokenHash: input.tokenHash,
    createdByMemberId: input.memberId,
    createdAt: input.madeAt,
    expiresAt: input.expiresAt,
  });
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'member_invite',
    entityId: id,
    action: 'member_invite.created',
    // Never the token or its hash.
    payload: { role: input.role, expiresAt: input.expiresAt.toISOString() },
  });
  const [invite] = await tx
    .select(inviteColumns)
    .from(memberInvites)
    .innerJoin(
      members,
      and(eq(members.orgId, memberInvites.orgId), eq(members.id, memberInvites.createdByMemberId)),
    )
    .where(eq(memberInvites.id, id));
  if (!invite) throw new Error('The new invite is not visible');
  return invite;
}

export type RevokeInviteResult = 'revoked' | 'missing' | 'accepted';

/** Stops an unused invite from working, with its audit event. Call inside withOrg(). */
export async function revokeInvite(
  tx: Transaction,
  orgId: string,
  inviteId: string,
  actorUserId: string,
  now: Date,
): Promise<RevokeInviteResult> {
  const [invite] = await tx
    .select({ acceptedAt: memberInvites.acceptedAt, revokedAt: memberInvites.revokedAt })
    .from(memberInvites)
    .where(eq(memberInvites.id, inviteId))
    .for('update');
  if (!invite || invite.revokedAt) return 'missing';
  if (invite.acceptedAt) return 'accepted';
  await tx.update(memberInvites).set({ revokedAt: now }).where(eq(memberInvites.id, inviteId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'member_invite',
    entityId: inviteId,
    action: 'member_invite.revoked',
  });
  return 'revoked';
}

/** An active member, locked against a concurrent change to the organization's people. */
async function lockedMember(tx: Transaction, orgId: string, memberId: string) {
  await lockOrgWrites(tx, orgId);
  const [person] = await tx
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.id, memberId), isNull(members.deactivatedAt)))
    .for('update');
  return person;
}

async function activeOwners(tx: Transaction): Promise<number> {
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(members)
    .where(and(eq(members.role, 'owner'), isNull(members.deactivatedAt)));
  return row?.n ?? 0;
}

export type ChangeRoleResult = 'changed' | 'unchanged' | 'missing' | 'last_owner';

/**
 * Gives a member another role, with its audit event, unless it would leave the organization
 * without an owner. Call inside withOrg().
 */
export async function changeMemberRole(
  tx: Transaction,
  orgId: string,
  memberId: string,
  role: MemberRole,
  actorUserId: string,
): Promise<ChangeRoleResult> {
  const person = await lockedMember(tx, orgId, memberId);
  if (!person) return 'missing';
  if (person.role === role) return 'unchanged';
  if (leavesNoOwner(person, await activeOwners(tx), role)) return 'last_owner';
  await tx.update(members).set({ role }).where(eq(members.id, memberId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'member',
    entityId: memberId,
    action: 'member.role_changed',
    payload: { from: person.role, to: role },
  });
  return 'changed';
}

export type ChooseApproverResult =
  | 'changed'
  | 'unchanged'
  | 'missing'
  /** No one approves their own reports (FR-GOV-03). */
  | 'own_approver'
  /** The person chosen isn't active here with a role that may approve (canApprove). */
  | 'not_an_approver';

/**
 * Chooses who approves a member's reports (#86), or Automatic with null, with its audit event.
 * Only someone else active here who can approve is chosen; a report already submitted keeps
 * the approver it went to. Call inside withOrg().
 */
export async function chooseMemberApprover(
  tx: Transaction,
  orgId: string,
  memberId: string,
  approverMemberId: string | null,
  actorUserId: string,
): Promise<ChooseApproverResult> {
  await lockOrgWrites(tx, orgId);
  const [person] = await tx
    .select({ managerMemberId: members.managerMemberId })
    .from(members)
    .where(and(eq(members.id, memberId), isNull(members.deactivatedAt)))
    .for('update');
  if (!person) return 'missing';
  if (approverMemberId === memberId) return 'own_approver';
  if (approverMemberId !== null) {
    const [approver] = await tx
      .select({ memberId: members.id, role: members.role })
      .from(members)
      .where(and(eq(members.id, approverMemberId), isNull(members.deactivatedAt)));
    if (!approver || !mayChooseApprover(approver, memberId)) return 'not_an_approver';
  }
  if (person.managerMemberId === approverMemberId) return 'unchanged';
  await tx
    .update(members)
    .set({ managerMemberId: approverMemberId })
    .where(eq(members.id, memberId));
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'member',
    entityId: memberId,
    action: 'member.approver_chosen',
    payload: { from: person.managerMemberId, to: approverMemberId },
  });
  return 'changed';
}

export type RemoveMemberResult = 'removed' | 'missing' | 'last_owner';

/**
 * Removes a member: they can no longer sign in here, and their receipts, expenses, trips,
 * reports and history stay. Their sign-ins go, so the same person can be invited again.
 * Refused for the last owner. Call inside withOrg().
 */
export async function removeMember(
  tx: Transaction,
  orgId: string,
  memberId: string,
  actorUserId: string,
  now: Date,
): Promise<RemoveMemberResult> {
  const person = await lockedMember(tx, orgId, memberId);
  if (!person) return 'missing';
  if (leavesNoOwner(person, await activeOwners(tx), 'removed')) return 'last_owner';
  await tx.update(members).set({ deactivatedAt: now }).where(eq(members.id, memberId));
  const signIns = await tx
    .delete(memberSignIns)
    .where(eq(memberSignIns.memberId, memberId))
    .returning({ id: memberSignIns.id });
  await appendAuditEvent(tx, orgId, {
    actor: { type: 'user', id: actorUserId },
    entityType: 'member',
    entityId: memberId,
    action: 'member.removed',
    payload: { role: person.role, signInsRemoved: signIns.length },
  });
  return 'removed';
}

/**
 * Where the person opening an invite stands: in no organization yet, alone in an empty one
 * of their own (which joining replaces), in one with work or other people in it (which
 * stops them joining), or already in the invite's own.
 */
export type InviteeStanding = 'none' | 'empty' | 'not_empty' | 'this';

/** An invite as the person holding its link sees it. */
export interface InviteLookup {
  readonly id: string;
  readonly orgId: string;
  readonly organizationName: string;
  readonly role: MemberRole;
  readonly expiresAt: Date;
  readonly state: InviteState;
  readonly standing: InviteeStanding;
}

const lookupColumns = {
  id: memberInvites.id,
  orgId: memberInvites.orgId,
  role: memberInvites.role,
  expiresAt: memberInvites.expiresAt,
  acceptedAt: memberInvites.acceptedAt,
  acceptedByMemberId: memberInvites.acceptedByMemberId,
  revokedAt: memberInvites.revokedAt,
};

/**
 * Shows the holder of a link the one invite it names (policy invite_holder), then lets it go,
 * so nothing read later in the transaction sees it.
 */
async function holdLink(tx: Transaction, tokenHash: string) {
  await tx.execute(sql`select set_config('app.invite_hash', ${tokenHash}, true)`);
  const [invite] = await tx
    .select(lookupColumns)
    .from(memberInvites)
    .where(eq(memberInvites.tokenHash, tokenHash));
  await tx.execute(sql`select set_config('app.invite_hash', '', true)`);
  return invite;
}

/** The caller's own sign-in, wherever it is (policy own_sign_ins). */
async function ownSignIn(tx: Transaction, userId: string) {
  const [signIn] = await tx
    .select({ id: memberSignIns.id, orgId: memberSignIns.orgId, memberId: memberSignIns.memberId })
    .from(memberSignIns)
    .where(eq(memberSignIns.userId, userId));
  return signIn;
}

async function standingOf(
  tx: Transaction,
  signIn: { readonly orgId: string } | undefined,
  orgId: string,
): Promise<InviteeStanding> {
  if (!signIn) return 'none';
  if (signIn.orgId === orgId) return 'this';
  await switchOrg(tx, signIn.orgId);
  return (await isEmptySoloOrganization(tx)) ? 'empty' : 'not_empty';
}

async function organizationName(tx: Transaction, orgId: string): Promise<string> {
  await switchOrg(tx, orgId);
  const [org] = await tx.select({ name: organizations.name }).from(organizations);
  if (!org) throw new Error('The invite’s organization is not visible');
  return org.name;
}

/**
 * The invite a link names, for the signed-in person holding it, and where they stand. Reads
 * only. Undefined when no invite has that token.
 */
export async function lookUpInvite(
  db: Database,
  tokenHash: string,
  userId: string,
  now: Date,
): Promise<InviteLookup | undefined> {
  return withUser(db, userId, async (tx) => {
    const invite = await holdLink(tx, tokenHash);
    if (!invite) return undefined;
    const standing = await standingOf(tx, await ownSignIn(tx, userId), invite.orgId);
    return {
      id: invite.id,
      orgId: invite.orgId,
      organizationName: await organizationName(tx, invite.orgId),
      role: invite.role,
      expiresAt: invite.expiresAt,
      state: inviteState(invite, now),
      standing,
    };
  });
}

export type AcceptInviteResult =
  | {
      readonly status: 'joined';
      readonly membership: Membership;
      readonly organizationName: string;
    }
  | { readonly status: 'not_found' | 'expired' | 'revoked' | 'used' }
  /** The caller is in this organization already. */
  | { readonly status: 'already_member'; readonly membership: Membership }
  /** The caller's own organization has work or other people in it. Nothing changed. */
  | { readonly status: 'has_own_organization' };

/**
 * Joins the signed-in person to the invite's organization with its role, once (FR-PLT-07,
 * ADR-0035). An empty one-person organization their first sign-in made is left behind, as
 * linking a sign-in does (ADR-0016); one with work or other people in it is refused and
 * nothing changes. Someone removed before comes back as the same member, with their records.
 * Audited in each organization touched, in one transaction.
 */
export async function acceptInvite(
  db: Database,
  tokenHash: string,
  caller: { readonly userId: string; readonly email: string },
  now: Date,
): Promise<AcceptInviteResult> {
  return withUser(db, caller.userId, async (tx) => {
    await lockSignIn(tx, caller.userId);
    const found = await holdLink(tx, tokenHash);
    if (!found) return { status: 'not_found' };

    // Lock the invite, so two people can't both use it.
    await switchOrg(tx, found.orgId);
    const [invite] = await tx
      .select(lookupColumns)
      .from(memberInvites)
      .where(eq(memberInvites.id, found.id))
      .for('update');
    if (!invite) return { status: 'not_found' };

    const signIn = await ownSignIn(tx, caller.userId);
    if (signIn?.orgId === invite.orgId) {
      const [me] = await tx
        .select({ role: members.role })
        .from(members)
        .where(eq(members.id, signIn.memberId));
      const membership = { orgId: invite.orgId, memberId: signIn.memberId, role: me!.role };
      // Accepting again, such as a retried request, answers as the first time did.
      return invite.acceptedByMemberId === signIn.memberId
        ? {
            status: 'joined',
            membership,
            organizationName: await organizationName(tx, invite.orgId),
          }
        : { status: 'already_member', membership };
    }
    const state = inviteState(invite, now);
    if (state !== 'pending') return { status: state === 'accepted' ? 'used' : state };

    if (signIn) {
      if ((await standingOf(tx, signIn, invite.orgId)) !== 'empty') {
        return { status: 'has_own_organization' };
      }
      await tx.delete(memberSignIns).where(eq(memberSignIns.id, signIn.id));
      await appendAuditEvent(tx, signIn.orgId, {
        actor: { type: 'user', id: caller.userId },
        entityType: 'member_sign_in',
        entityId: signIn.id,
        action: 'member_sign_in.moved_out',
        payload: { memberId: signIn.memberId, joinedByInvite: true },
      });
      await switchOrg(tx, invite.orgId);
    }

    await lockOrgWrites(tx, invite.orgId);
    // Someone removed before keeps their member, records and history.
    const [before] = await tx
      .select({ id: members.id })
      .from(members)
      .where(eq(members.userId, caller.userId));
    const memberId = before?.id ?? newId();
    if (before) {
      await tx
        .update(members)
        .set({ role: invite.role, deactivatedAt: null })
        .where(eq(members.id, memberId));
    } else {
      await tx.insert(members).values({
        id: memberId,
        orgId: invite.orgId,
        userId: caller.userId,
        email: caller.email,
        displayName: caller.email.split('@')[0] || caller.email,
        role: invite.role,
      });
    }
    await tx.insert(memberSignIns).values({
      orgId: invite.orgId,
      memberId,
      userId: caller.userId,
      email: caller.email,
    });
    await tx
      .update(memberInvites)
      .set({ acceptedAt: now, acceptedByMemberId: memberId })
      .where(eq(memberInvites.id, invite.id));
    await appendAuditEvent(tx, invite.orgId, {
      actor: { type: 'user', id: caller.userId },
      entityType: 'member',
      entityId: memberId,
      action: 'member.joined',
      payload: {
        inviteId: invite.id,
        role: invite.role,
        returning: before !== undefined,
        leftAnEmptyOrganization: signIn !== undefined,
      },
    });
    return {
      status: 'joined',
      membership: { orgId: invite.orgId, memberId, role: invite.role },
      organizationName: await organizationName(tx, invite.orgId),
    };
  });
}
