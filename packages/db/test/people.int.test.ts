import { inviteExpiresAt, newId, type MemberRole } from '@expensewise/domain';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg, withUser } from '../src/client.ts';
import { ensureOwnerOrganization, findMemberships } from '../src/members.ts';
import {
  acceptInvite,
  changeMemberRole,
  createInvite,
  inviteTokenHash,
  listOpenInvites,
  listPeople,
  lookUpInvite,
  newInviteToken,
  removeMember,
  revokeInvite,
} from '../src/people.ts';
import { auditEvents, memberInvites, memberSignIns, members, trips } from '../src/schema.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const NOW = new Date('2026-10-04T09:00:00.000Z');
const user = () => `user_${newId()}`;
const actions = (orgId: string) =>
  withOrg(app.db, orgId, async (tx) =>
    (await tx.select().from(auditEvents).orderBy(asc(auditEvents.sequence))).map((e) => e.action),
  );

type Org = Awaited<ReturnType<typeof seedOrg>>;

/** An owner's invite link with a role; returns the token, as the owner would be shown it. */
async function invite(org: Org, role: MemberRole, madeAt = NOW) {
  const token = newInviteToken();
  const made = await withOrg(app.db, org.orgId, (tx) =>
    createInvite(
      tx,
      org.orgId,
      {
        role,
        label: 'For Sam',
        tokenHash: inviteTokenHash(token),
        madeAt,
        expiresAt: inviteExpiresAt(madeAt),
        memberId: org.memberId,
      },
      org.userId,
    ),
  );
  return { token, id: made.id };
}

const accept = (token: string, userId: string, at = NOW) =>
  acceptInvite(app.db, inviteTokenHash(token), { userId, email: `${userId}@example.com` }, at);

describe('invite links (#29)', () => {
  it('keeps only the hash of a link, lists it until used, and records who made it', async () => {
    const org = await seedOrg(app.db, 'people-invite');
    const { token, id } = await invite(org, 'member');
    const [row] = await withOrg(app.db, org.orgId, (tx) =>
      tx.select().from(memberInvites).where(eq(memberInvites.id, id)),
    );
    expect(row?.tokenHash).toBe(inviteTokenHash(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row?.expiresAt.toISOString()).toBe('2026-10-11T09:00:00.000Z');
    const open = await withOrg(app.db, org.orgId, (tx) => listOpenInvites(tx));
    expect(open).toMatchObject([
      { id, role: 'member', label: 'For Sam', createdBy: 'people-invite' },
    ]);
    expect(await actions(org.orgId)).toEqual(['member_invite.created']);
  });

  it('joins a person with the link’s role, once', async () => {
    const org = await seedOrg(app.db, 'people-join');
    const { token } = await invite(org, 'approver');
    const sam = user();
    const joined = await accept(token, sam);
    expect(joined).toMatchObject({
      status: 'joined',
      membership: { orgId: org.orgId, role: 'approver' },
      organizationName: 'people-join',
    });
    expect(await findMemberships(app.db, sam)).toMatchObject([
      { orgId: org.orgId, role: 'approver' },
    ]);
    // A retried request answers as the first did; anyone else finds it used.
    expect((await accept(token, sam)).status).toBe('joined');
    expect((await accept(token, user())).status).toBe('used');
    expect(await withOrg(app.db, org.orgId, (tx) => listOpenInvites(tx))).toEqual([]);
    expect(await actions(org.orgId)).toEqual(['member_invite.created', 'member.joined']);
  });

  it('replaces the empty organization a first sign-in made', async () => {
    const org = await seedOrg(app.db, 'people-empty');
    const { token } = await invite(org, 'member');
    const sam = user();
    const own = await ensureOwnerOrganization(app.db, { userId: sam, email: 'sam@example.com' });
    const joined = await accept(token, sam);
    expect(joined.status).toBe('joined');
    expect(await findMemberships(app.db, sam)).toMatchObject([{ orgId: org.orgId }]);
    expect(await actions(own.membership.orgId)).toEqual([
      'organization.created',
      'member_sign_in.moved_out',
    ]);
  });

  it('refuses someone whose own organization has work in it, and changes nothing', async () => {
    const org = await seedOrg(app.db, 'people-busy');
    const { token, id } = await invite(org, 'member');
    const busy = user();
    const own = await ensureOwnerOrganization(app.db, { userId: busy, email: 'busy@example.com' });
    await withOrg(app.db, own.membership.orgId, (tx) =>
      tx.insert(trips).values({
        orgId: own.membership.orgId,
        memberId: own.membership.memberId,
        name: 'Austin',
        startDate: '2026-09-01',
        endDate: '2026-09-02',
      }),
    );
    expect(await accept(token, busy)).toEqual({ status: 'has_own_organization' });
    expect(await findMemberships(app.db, busy)).toEqual([own.membership]);
    const preview = await lookUpInvite(app.db, inviteTokenHash(token), busy, NOW);
    expect(preview).toMatchObject({ id, state: 'pending', standing: 'not_empty' });
  });

  it('refuses a link that has expired or been revoked, or that names no invite', async () => {
    const org = await seedOrg(app.db, 'people-stale');
    const old = await invite(org, 'member', new Date('2026-09-20T09:00:00.000Z'));
    expect((await accept(old.token, user())).status).toBe('expired');
    const revoked = await invite(org, 'member');
    expect(
      await withOrg(app.db, org.orgId, (tx) =>
        revokeInvite(tx, org.orgId, revoked.id, org.userId, NOW),
      ),
    ).toBe('revoked');
    expect((await accept(revoked.token, user())).status).toBe('revoked');
    expect((await accept(newInviteToken(), user())).status).toBe('not_found');
    expect(await lookUpInvite(app.db, inviteTokenHash(newInviteToken()), user(), NOW)).toBe(
      undefined,
    );
  });

  it('shows the holder of a link that one invite and nothing else of the organization', async () => {
    const org = await seedOrg(app.db, 'people-holder');
    const { token, id } = await invite(org, 'auditor');
    await invite(org, 'member');
    const stranger = user();
    const preview = await lookUpInvite(app.db, inviteTokenHash(token), stranger, NOW);
    expect(preview).toEqual({
      id,
      orgId: org.orgId,
      organizationName: 'people-holder',
      role: 'auditor',
      expiresAt: inviteExpiresAt(NOW),
      state: 'pending',
      standing: 'none',
    });
    // Without the token, the same person sees no invite at all.
    expect(await withUser(app.db, stranger, (tx) => tx.select().from(memberInvites))).toEqual([]);
  });
});

describe('roles and removing people (#29)', () => {
  it('changes a role, and never leaves the organization without an owner', async () => {
    const org = await seedOrg(app.db, 'people-roles');
    const inOrg = <T>(run: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, run);
    expect(
      await inOrg((tx) => changeMemberRole(tx, org.orgId, org.memberId, 'member', org.userId)),
    ).toBe('last_owner');
    expect(await inOrg((tx) => removeMember(tx, org.orgId, org.memberId, org.userId, NOW))).toBe(
      'last_owner',
    );
    const { token } = await invite(org, 'owner');
    const joined = await accept(token, user());
    if (joined.status !== 'joined') throw new Error(joined.status);
    expect(
      await inOrg((tx) =>
        changeMemberRole(tx, org.orgId, org.memberId, 'finance_admin', org.userId),
      ),
    ).toBe('changed');
    expect(
      await inOrg((tx) =>
        changeMemberRole(tx, org.orgId, joined.membership.memberId, 'member', org.userId),
      ),
    ).toBe('last_owner');
    expect(
      await inOrg((tx) =>
        changeMemberRole(tx, org.orgId, org.memberId, 'finance_admin', org.userId),
      ),
    ).toBe('unchanged');
    const audit = await inOrg((tx) =>
      tx
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(eq(auditEvents.action, 'member.role_changed')),
    );
    expect(audit.map((e) => e.payload)).toEqual([{ from: 'owner', to: 'finance_admin' }]);
  });

  it('removes a member, keeping their records, and lets them back in as the same member', async () => {
    const org = await seedOrg(app.db, 'people-remove');
    const inOrg = <T>(run: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, run);
    const sam = user();
    const first = await accept((await invite(org, 'member')).token, sam);
    if (first.status !== 'joined') throw new Error(first.status);
    const samId = first.membership.memberId;
    await inOrg((tx) =>
      tx.insert(trips).values({
        orgId: org.orgId,
        memberId: samId,
        name: 'Denver',
        startDate: '2026-09-01',
        endDate: '2026-09-02',
      }),
    );

    expect(await inOrg((tx) => removeMember(tx, org.orgId, samId, org.userId, NOW))).toBe(
      'removed',
    );
    expect(await findMemberships(app.db, sam)).toEqual([]);
    expect(
      await inOrg((tx) => tx.select().from(memberSignIns).where(eq(memberSignIns.memberId, samId))),
    ).toEqual([]);
    expect(
      await inOrg((tx) => tx.select().from(trips).where(eq(trips.memberId, samId))),
    ).toHaveLength(1);
    expect(await inOrg((tx) => listPeople(tx))).toMatchObject([
      { memberId: org.memberId, removedAt: null },
      { memberId: samId, role: 'member', removedAt: NOW },
    ]);
    expect(await inOrg((tx) => removeMember(tx, org.orgId, samId, org.userId, NOW))).toBe(
      'missing',
    );

    const back = await accept((await invite(org, 'finance_admin')).token, sam);
    expect(back).toMatchObject({
      status: 'joined',
      membership: { memberId: samId, role: 'finance_admin' },
    });
    const [row] = await inOrg((tx) => tx.select().from(members).where(eq(members.id, samId)));
    expect(row?.deactivatedAt).toBeNull();
    expect((await actions(org.orgId)).filter((a) => a.startsWith('member.'))).toEqual([
      'member.joined',
      'member.removed',
      'member.joined',
    ]);
  });
});
