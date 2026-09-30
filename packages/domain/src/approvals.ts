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
