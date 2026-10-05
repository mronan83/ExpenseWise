import { err, ok, type Result } from './result.ts';

export const MEMBER_ROLES = ['member', 'approver', 'finance_admin', 'owner', 'auditor'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

const APPROVING_ROLES: ReadonlySet<MemberRole> = new Set(['approver', 'finance_admin', 'owner']);

export interface ApprovalCheck {
  readonly approverMemberId: string;
  readonly approverRole: MemberRole;
  readonly submitterMemberId: string;
  /** Active members in the organization. */
  readonly organizationMemberCount: number;
}

/** Why an approval is allowed. Recorded on the audit event. */
export type ApprovalBasis = 'separation_of_duties' | 'solo_self_attestation';

/**
 * Separation of duties: in any organization with two or more members, approvers need an
 * approving role and never approve their own spend. A one-person organization has no one
 * else to ask, so its owner self-attests, and the audit trail says so (ADR-0001).
 */
export function canApprove(
  check: ApprovalCheck,
): Result<ApprovalBasis, { readonly code: 'self_approval' | 'not_an_approver' }> {
  if (!APPROVING_ROLES.has(check.approverRole)) return err({ code: 'not_an_approver' });
  if (check.approverMemberId !== check.submitterMemberId) return ok('separation_of_duties');
  return check.organizationMemberCount === 1
    ? ok('solo_self_attestation')
    : err({ code: 'self_approval' });
}

/**
 * Approving someone else's spend needs the second factor in this session (FR-GOV-04); a
 * one-person organization's self-attestation does not.
 */
export function needsSecondFactor(basis: ApprovalBasis): boolean {
  return basis === 'separation_of_duties';
}

/** The longest reason, comment or rejection approval keeps (FR-EXP-10, FR-GOV-02, FR-GOV-12). */
export const APPROVAL_NOTE_MAX = 500;

/**
 * A reason, comment or rejection as kept: trimmed, at most APPROVAL_NOTE_MAX characters, or
 * null when blank. Returns an error message for one too long.
 */
export function cleanApprovalNote(
  text: string,
  what = 'A reason',
): { value: string | null } | { error: string } {
  const value = text.trim();
  if (value === '') return { value: null };
  if (value.length > APPROVAL_NOTE_MAX) {
    return { error: `${what} is at most ${APPROVAL_NOTE_MAX} characters.` };
  }
  return { value };
}

/** An active member who might approve a report, as routing sees them. */
export interface ApproverCandidate {
  readonly memberId: string;
  readonly role: MemberRole;
  /** When they joined: the longest-standing comes first among equals. */
  readonly joinedAt: Date;
}

/** Who routing tries first: an approver, then a finance admin, then the owner. */
const ROUTING_ORDER: readonly MemberRole[] = ['approver', 'finance_admin', 'owner'];

/**
 * Whether an owner may choose `candidate` to approve `memberId`'s reports (#86): someone else,
 * active, with a role that may approve a teammate's spend (canApprove). No one approves their
 * own: a one-person organization has no one to choose, and its owner self-attests.
 */
export function mayChooseApprover(
  candidate: { readonly memberId: string; readonly role: MemberRole },
  memberId: string,
): boolean {
  return candidate.memberId !== memberId && APPROVING_ROLES.has(candidate.role);
}

/** Who a member's reports go to now, and whether the approver chosen for them is passed over. */
export interface ApproverRoute {
  /** The approver a report submitted now goes to; null when no one else can approve it. */
  readonly goesTo: string | null;
  /**
   * An owner chose an approver for them who can't approve it now (their role changed, or they
   * were removed), so the routing as built finds someone else (#86).
   */
  readonly passedOver: boolean;
}

/**
 * Who a report goes to, in one step (FR-GOV-02). A one-person organization's report goes to
 * its owner, who self-attests (FR-GOV-03). In a team: the approver an owner chose for the
 * submitter (their manager, #86) while they can approve it; otherwise the longest-standing
 * approver, then finance admin, then owner, never the submitter.
 */
export function routeReport(
  submitter: { readonly memberId: string; readonly managerMemberId: string | null },
  active: readonly ApproverCandidate[],
): ApproverRoute {
  const count = active.length;
  const allowed = (c: ApproverCandidate) =>
    canApprove({
      approverMemberId: c.memberId,
      approverRole: c.role,
      submitterMemberId: submitter.memberId,
      organizationMemberCount: count,
    }).ok;
  const manager = active.find((c) => c.memberId === submitter.managerMemberId);
  if (manager && mayChooseApprover(manager, submitter.memberId) && allowed(manager)) {
    return { goesTo: manager.memberId, passedOver: false };
  }
  const ranked = [...active].sort(
    (a, b) =>
      ROUTING_ORDER.indexOf(a.role) - ROUTING_ORDER.indexOf(b.role) ||
      a.joinedAt.getTime() - b.joinedAt.getTime() ||
      a.memberId.localeCompare(b.memberId),
  );
  return {
    goesTo: ranked.find((c) => ROUTING_ORDER.includes(c.role) && allowed(c))?.memberId ?? null,
    passedOver: submitter.managerMemberId !== null,
  };
}

/** Who a report goes to (routeReport()); null when no one else in the team can approve it. */
export function chooseApprover(
  submitter: { readonly memberId: string; readonly managerMemberId: string | null },
  active: readonly ApproverCandidate[],
): string | null {
  return routeReport(submitter, active).goesTo;
}

/** Roles that may decide a report routed to someone else: those who see every member's. */
const DECIDES_FOR_OTHERS: ReadonlySet<MemberRole> = new Set(['owner', 'finance_admin']);

export interface DecisionCheck extends ApprovalCheck {
  /** The approver the report was routed to. */
  readonly stepApproverMemberId: string;
}

/**
 * Whether this person may approve or return a report waiting for approval: the approver it
 * went to, or an owner or finance admin, who sees every member's records (ADR-0035), so a
 * report never waits on someone who has left; and always within canApprove().
 */
export function mayDecide(
  check: DecisionCheck,
): Result<
  ApprovalBasis,
  { readonly code: 'self_approval' | 'not_an_approver' | 'not_your_approval' }
> {
  const allowed = canApprove(check);
  if (!allowed.ok) return allowed;
  if (
    check.approverMemberId !== check.stepApproverMemberId &&
    !DECIDES_FOR_OTHERS.has(check.approverRole)
  ) {
    return err({ code: 'not_your_approval' });
  }
  return allowed;
}
