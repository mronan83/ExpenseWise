import type { MemberRole } from './approvals.ts';

/** Days an invite link works after it is made (FR-PLT-07, ADR-0035). */
export const INVITE_DAYS = 7;

/** The longest note an owner keeps on an invite, such as who it is for. */
export const INVITE_LABEL_MAX = 80;

const DAY_MS = 86_400_000;

/** When an invite made at `madeAt` stops working. */
export function inviteExpiresAt(madeAt: Date): Date {
  return new Date(madeAt.getTime() + INVITE_DAYS * DAY_MS);
}

/** Where an invite stands: still usable, used, revoked by an owner, or past its 7 days. */
export type InviteState = 'pending' | 'accepted' | 'revoked' | 'expired';

export function inviteState(
  invite: {
    readonly acceptedAt: Date | null;
    readonly revokedAt: Date | null;
    readonly expiresAt: Date;
  },
  now: Date,
): InviteState {
  if (invite.acceptedAt) return 'accepted';
  if (invite.revokedAt) return 'revoked';
  return now.getTime() >= invite.expiresAt.getTime() ? 'expired' : 'pending';
}

/**
 * Whether a role sees every member's receipts, expenses, trips and reports (ADR-0035): owners
 * and finance admins, who run the organization, and auditors, who check it. A member or
 * approver sees their own. The database enforces this; this is how the app explains it.
 */
export function seesEveryMember(role: MemberRole): boolean {
  return role === 'owner' || role === 'finance_admin' || role === 'auditor';
}

/**
 * Whether a member may change a record: only their own, and an auditor nothing at all
 * (ADR-0035). The database enforces this too.
 */
export function mayChangeRecord(role: MemberRole, own: boolean): boolean {
  return own && role !== 'auditor';
}

/**
 * Whether changing people this way would leave the organization without an owner: the last
 * active owner can neither be given another role nor be removed.
 */
export function leavesNoOwner(
  person: { readonly role: MemberRole },
  activeOwners: number,
  newRole: MemberRole | 'removed',
): boolean {
  return person.role === 'owner' && newRole !== 'owner' && activeOwners <= 1;
}
