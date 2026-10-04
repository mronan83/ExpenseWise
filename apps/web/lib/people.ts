/** Settings › People and invite links (FR-PLT-07, ADR-0035), behind team.invites. */

export type Role = 'member' | 'approver' | 'finance_admin' | 'owner' | 'auditor';

/** Each role, as people say it, and what it lets someone do. In the order a menu offers them. */
export const ROLES: readonly { role: Role; name: string; does: string }[] = [
  {
    role: 'member',
    name: 'Member',
    does: 'Files and sees their own receipts, expenses and trips.',
  },
  {
    role: 'approver',
    name: 'Approver',
    does: 'A member who will approve others’ reports once approval arrives.',
  },
  {
    role: 'finance_admin',
    name: 'Finance admin',
    does: 'Sees everyone’s records, changes their own, and manages AI keys.',
  },
  { role: 'auditor', name: 'Auditor', does: 'Reads everyone’s records and changes nothing.' },
  { role: 'owner', name: 'Owner', does: 'Everything a finance admin does, and manages people.' },
];

export const roleName = (role: Role) => ROLES.find((r) => r.role === role)?.name ?? role;

export interface Person {
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
  removedAt: string | null;
  you: boolean;
}

export interface Invite {
  id: string;
  role: Role;
  label: string | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
}

export interface People {
  people: Person[];
  invites: Invite[];
}

export interface CreatedInvite {
  invite: Invite;
  token: string;
  path: string;
}

export interface InvitePreview {
  organization: { id: string; name: string };
  role: Role;
  expiresAt: string;
  state: 'pending' | 'accepted' | 'revoked' | 'expired';
  standing: 'none' | 'empty' | 'not_empty' | 'this';
}

export const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
