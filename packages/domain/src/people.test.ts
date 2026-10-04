import { describe, expect, it } from 'vitest';
import {
  INVITE_DAYS,
  inviteExpiresAt,
  inviteState,
  leavesNoOwner,
  mayChangeRecord,
  seesEveryMember,
} from './people.ts';

const MADE = new Date('2026-10-04T09:00:00.000Z');

describe('invite links', () => {
  it('work for 7 days from when they are made', () => {
    expect(INVITE_DAYS).toBe(7);
    expect(inviteExpiresAt(MADE).toISOString()).toBe('2026-10-11T09:00:00.000Z');
  });

  it('are pending until used, revoked or past their 7 days', () => {
    const invite = { acceptedAt: null, revokedAt: null, expiresAt: inviteExpiresAt(MADE) };
    expect(inviteState(invite, new Date('2026-10-11T08:59:59.999Z'))).toBe('pending');
    expect(inviteState(invite, new Date('2026-10-11T09:00:00.000Z'))).toBe('expired');
    expect(inviteState({ ...invite, revokedAt: MADE }, MADE)).toBe('revoked');
    expect(inviteState({ ...invite, acceptedAt: MADE }, new Date('2027-01-01'))).toBe('accepted');
  });
});

describe('who sees and changes whose records (ADR-0035)', () => {
  it('lets owners, finance admins and auditors see everyone’s, and members and approvers their own', () => {
    expect(seesEveryMember('owner')).toBe(true);
    expect(seesEveryMember('finance_admin')).toBe(true);
    expect(seesEveryMember('auditor')).toBe(true);
    expect(seesEveryMember('member')).toBe(false);
    expect(seesEveryMember('approver')).toBe(false);
  });

  it('lets everyone change only their own records, and an auditor none', () => {
    expect(mayChangeRecord('owner', true)).toBe(true);
    expect(mayChangeRecord('owner', false)).toBe(false);
    expect(mayChangeRecord('finance_admin', false)).toBe(false);
    expect(mayChangeRecord('member', true)).toBe(true);
    expect(mayChangeRecord('auditor', true)).toBe(false);
  });

  it('never leaves an organization without an owner', () => {
    expect(leavesNoOwner({ role: 'owner' }, 1, 'member')).toBe(true);
    expect(leavesNoOwner({ role: 'owner' }, 1, 'removed')).toBe(true);
    expect(leavesNoOwner({ role: 'owner' }, 2, 'removed')).toBe(false);
    expect(leavesNoOwner({ role: 'owner' }, 1, 'owner')).toBe(false);
    expect(leavesNoOwner({ role: 'member' }, 1, 'removed')).toBe(false);
  });
});
