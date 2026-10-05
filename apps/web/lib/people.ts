import { showDate } from '@expensewise/domain';

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

export interface PersonRef {
  id: string;
  name: string;
}

/** Who approves someone's reports, while approval is on (#86). */
export interface PersonApprover {
  /** The approver an owner chose; null for Automatic. */
  chosen: PersonRef | null;
  /** Who a report they submit now goes to; null when no one else can approve it. */
  goesTo: PersonRef | null;
  /** The one chosen can't approve now, so Automatic found goesTo. */
  passedOver: boolean;
  /** Everyone else here whose role may approve. */
  choices: PersonRef[];
}

export interface Person {
  id: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
  removedAt: string | null;
  you: boolean;
  /** Absent while approval is off, and for someone removed. */
  approver?: PersonApprover;
}

/** "your" for the caller, "Sam’s" for anyone else. */
export const whose = (person: Pick<Person, 'name' | 'you'>) =>
  person.you ? 'your' : `${person.name}’s`;

/**
 * Where someone's reports go now, as People says it under their approver (#86): to whom, and
 * why when it isn't the one chosen. Null when there is nothing to add.
 */
export function approverNote(person: Person): { text: string; warn: boolean } | null {
  const a = person.approver;
  if (!a) return null;
  const their = person.you ? 'your' : 'their';
  if (!a.goesTo) {
    return {
      text: `No one else here can approve ${their} reports yet. Give someone the approver or finance admin role.`,
      warn: true,
    };
  }
  if (a.passedOver && a.chosen) {
    return {
      text: `${a.chosen.name} can’t approve now, so ${their} reports go to ${a.goesTo.name}, as Automatic finds.`,
      warn: true,
    };
  }
  if (a.goesTo.id === person.id) {
    return { text: 'You approve your own: no one else is here yet.', warn: false };
  }
  return { text: `${person.you ? 'Your' : 'Their'} reports go to ${a.goesTo.name}.`, warn: false };
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

export const shortDate = (iso: string) => showDate(iso);
