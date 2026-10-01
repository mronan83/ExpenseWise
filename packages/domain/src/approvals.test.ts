import { describe, expect, it } from 'vitest';
import { canApprove, type MemberRole } from './approvals.ts';

describe('canApprove', () => {
  it('blocks self-approval in any team, even for owners', () => {
    expect(
      canApprove({
        approverMemberId: 'a',
        approverRole: 'owner',
        submitterMemberId: 'a',
        organizationMemberCount: 2,
      }),
    ).toEqual({ ok: false, error: { code: 'self_approval' } });
  });

  it('lets a one-person organization self-attest, and says so', () => {
    expect(
      canApprove({
        approverMemberId: 'riley',
        approverRole: 'owner',
        submitterMemberId: 'riley',
        organizationMemberCount: 1,
      }),
    ).toEqual({ ok: true, value: 'solo_self_attestation' });
  });

  it.each<[MemberRole, boolean]>([
    ['member', false],
    ['auditor', false],
    ['approver', true],
    ['finance_admin', true],
    ['owner', true],
  ])('role %s may approve a teammate: %s', (role, allowed) => {
    const result = canApprove({
      approverMemberId: 'b',
      approverRole: role,
      submitterMemberId: 'a',
      organizationMemberCount: 5,
    });
    expect(result.ok).toBe(allowed);
    if (result.ok) expect(result.value).toBe('separation_of_duties');
  });

  it('still requires an approving role to self-attest', () => {
    expect(
      canApprove({
        approverMemberId: 'a',
        approverRole: 'member',
        submitterMemberId: 'a',
        organizationMemberCount: 1,
      }).ok,
    ).toBe(false);
  });
});
