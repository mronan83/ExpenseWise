import { describe, expect, it } from 'vitest';
import {
  APPROVAL_NOTE_MAX,
  canApprove,
  chooseApprover,
  cleanApprovalNote,
  mayDecide,
  needsSecondFactor,
  type MemberRole,
} from './approvals.ts';

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

describe('needsSecondFactor', () => {
  it('asks for it to approve someone else’s spend, never to self-attest alone', () => {
    expect(needsSecondFactor('separation_of_duties')).toBe(true);
    expect(needsSecondFactor('solo_self_attestation')).toBe(false);
  });
});

describe('chooseApprover', () => {
  const joined = (day: number) => new Date(Date.UTC(2026, 8, day));
  const riley = { memberId: 'riley', role: 'owner' as const, joinedAt: joined(1) };
  const sam = { memberId: 'sam', role: 'member' as const, joinedAt: joined(2) };
  const casey = { memberId: 'casey', role: 'approver' as const, joinedAt: joined(3) };
  const fin = { memberId: 'fin', role: 'finance_admin' as const, joinedAt: joined(4) };
  const audrey = { memberId: 'audrey', role: 'auditor' as const, joinedAt: joined(5) };

  it('sends a one-person organization’s report to its owner, who self-attests', () => {
    expect(chooseApprover({ memberId: 'riley', managerMemberId: null }, [riley])).toBe('riley');
  });

  it('sends a report to an approver first, then a finance admin, then the owner, never its own member', () => {
    const team = [riley, sam, casey, fin, audrey];
    expect(chooseApprover({ memberId: 'sam', managerMemberId: null }, team)).toBe('casey');
    expect(chooseApprover({ memberId: 'casey', managerMemberId: null }, team)).toBe('fin');
    expect(chooseApprover({ memberId: 'sam', managerMemberId: null }, [riley, sam])).toBe('riley');
  });

  it('sends it to the member’s manager when they can approve it', () => {
    const team = [riley, sam, casey, fin];
    expect(chooseApprover({ memberId: 'sam', managerMemberId: 'riley' }, team)).toBe('riley');
    // A manager who can't approve is passed over.
    expect(chooseApprover({ memberId: 'fin', managerMemberId: 'sam' }, team)).toBe('casey');
  });

  it('finds no one when nobody else in the team can approve it', () => {
    expect(chooseApprover({ memberId: 'riley', managerMemberId: null }, [riley, sam])).toBeNull();
    expect(
      chooseApprover({ memberId: 'riley', managerMemberId: null }, [riley, sam, audrey]),
    ).toBeNull();
  });

  it('takes the longest-standing among equals', () => {
    const later = { memberId: 'jordan', role: 'approver' as const, joinedAt: joined(9) };
    expect(chooseApprover({ memberId: 'sam', managerMemberId: null }, [later, casey, sam])).toBe(
      'casey',
    );
  });
});

describe('mayDecide', () => {
  const check = {
    approverMemberId: 'fin',
    approverRole: 'finance_admin' as const,
    submitterMemberId: 'sam',
    organizationMemberCount: 3,
    stepApproverMemberId: 'casey',
  };

  it('lets the approver it went to decide, and an owner or finance admin in their place', () => {
    expect(mayDecide({ ...check, approverMemberId: 'casey', approverRole: 'approver' })).toEqual({
      ok: true,
      value: 'separation_of_duties',
    });
    expect(mayDecide(check).ok).toBe(true);
    expect(mayDecide({ ...check, approverMemberId: 'riley', approverRole: 'owner' }).ok).toBe(true);
  });

  it('refuses another approver, a member, and anyone deciding their own in a team', () => {
    expect(mayDecide({ ...check, approverMemberId: 'jordan', approverRole: 'approver' })).toEqual({
      ok: false,
      error: { code: 'not_your_approval' },
    });
    expect(mayDecide({ ...check, approverMemberId: 'alex', approverRole: 'member' })).toEqual({
      ok: false,
      error: { code: 'not_an_approver' },
    });
    expect(mayDecide({ ...check, approverMemberId: 'sam', approverRole: 'owner' })).toEqual({
      ok: false,
      error: { code: 'self_approval' },
    });
  });

  it('lets a one-person organization’s owner self-attest their own', () => {
    expect(
      mayDecide({
        approverMemberId: 'riley',
        approverRole: 'owner',
        submitterMemberId: 'riley',
        organizationMemberCount: 1,
        stepApproverMemberId: 'riley',
      }),
    ).toEqual({ ok: true, value: 'solo_self_attestation' });
  });
});

describe('cleanApprovalNote', () => {
  it('keeps a note trimmed, a blank one as none, and refuses one too long', () => {
    expect(cleanApprovalNote('  Minibar was personal ')).toEqual({ value: 'Minibar was personal' });
    expect(cleanApprovalNote('   ')).toEqual({ value: null });
    expect(cleanApprovalNote('x'.repeat(APPROVAL_NOTE_MAX))).toEqual({
      value: 'x'.repeat(APPROVAL_NOTE_MAX),
    });
    expect(cleanApprovalNote('x'.repeat(APPROVAL_NOTE_MAX + 1), 'A comment')).toEqual({
      error: 'A comment is at most 500 characters.',
    });
  });
});
