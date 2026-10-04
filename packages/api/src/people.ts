import {
  acceptInvite,
  assertRowSecurityApplies,
  changeMemberRole,
  createInvite,
  inviteTokenHash,
  listOpenInvites,
  listPeople,
  lookUpInvite,
  newInviteToken,
  removeMember,
  revokeInvite,
  withOrg,
  type AcceptInviteResult,
  type ChangeRoleResult,
  type Database,
  type InviteLookup,
  type InviteRecord,
  type Membership,
  type PersonRecord,
  type RemoveMemberResult,
  type RevokeInviteResult,
} from '@expensewise/db';
import { inviteExpiresAt, type MemberRole } from '@expensewise/domain';

/**
 * What the API needs from the database for Settings › People and invite links (FR-PLT-07,
 * ADR-0035). Every change appends its audit event in the same transaction. Who may make each
 * change is the route's to check. Tests use an in-memory fake.
 */
export interface PeopleStore {
  /** Everyone in the organization, removed people too, and its unused invites. */
  list(orgId: string): Promise<{ people: PersonRecord[]; invites: InviteRecord[] }>;
  /** Makes an invite link. The token is returned once, here, and never stored. */
  invite(
    by: Membership,
    input: { readonly role: MemberRole; readonly label: string | null },
    actorUserId: string,
    now: Date,
  ): Promise<{ invite: InviteRecord; token: string }>;
  revokeInvite(
    orgId: string,
    inviteId: string,
    actorUserId: string,
    now: Date,
  ): Promise<RevokeInviteResult>;
  changeRole(
    orgId: string,
    memberId: string,
    role: MemberRole,
    actorUserId: string,
  ): Promise<ChangeRoleResult>;
  remove(
    orgId: string,
    memberId: string,
    actorUserId: string,
    now: Date,
  ): Promise<RemoveMemberResult>;
  /** The invite a token names, for the signed-in person holding it. */
  lookUp(token: string, userId: string, now: Date): Promise<InviteLookup | undefined>;
  accept(
    token: string,
    caller: { readonly userId: string; readonly email: string },
    now: Date,
  ): Promise<AcceptInviteResult>;
}

/**
 * The people store on Postgres, as expensewise_app. It acts for the system inside the
 * organization: members and invites belong to no one member. It checks the role once.
 */
export function dbPeopleStore(db: Database): PeopleStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  const inOrg = async <T>(orgId: string, work: Parameters<typeof withOrg<T>>[2]) => {
    await safe();
    return withOrg(db, orgId, work);
  };

  return {
    list: (orgId) =>
      inOrg(orgId, async (tx) => ({
        people: await listPeople(tx),
        invites: await listOpenInvites(tx),
      })),
    invite: async (by, input, actor, now) => {
      const token = newInviteToken();
      const invite = await inOrg(by.orgId, (tx) =>
        createInvite(
          tx,
          by.orgId,
          {
            ...input,
            tokenHash: inviteTokenHash(token),
            madeAt: now,
            expiresAt: inviteExpiresAt(now),
            memberId: by.memberId,
          },
          actor,
        ),
      );
      return { invite, token };
    },
    revokeInvite: (orgId, inviteId, actor, now) =>
      inOrg(orgId, (tx) => revokeInvite(tx, orgId, inviteId, actor, now)),
    changeRole: (orgId, memberId, role, actor) =>
      inOrg(orgId, (tx) => changeMemberRole(tx, orgId, memberId, role, actor)),
    remove: (orgId, memberId, actor, now) =>
      inOrg(orgId, (tx) => removeMember(tx, orgId, memberId, actor, now)),
    lookUp: async (token, userId, now) => {
      await safe();
      return lookUpInvite(db, inviteTokenHash(token), userId, now);
    },
    accept: async (token, caller, now) => {
      await safe();
      return acceptInvite(db, inviteTokenHash(token), caller, now);
    },
  };
}
