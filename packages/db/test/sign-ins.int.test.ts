import { newId } from '@expensewise/domain';
import { asc } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg, withUser } from '../src/client.ts';
import { ensureOwnerOrganization, findMemberships } from '../src/members.ts';
import { linkSignIn, listSignIns, unlinkSignIn } from '../src/sign-ins.ts';
import { auditEvents, expenses, members, memberSignIns, organizations } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const user = () => `user_${newId()}`;
const actions = (orgId: string) =>
  withOrg(app.db, orgId, async (tx) =>
    (await tx.select().from(auditEvents).orderBy(asc(auditEvents.sequence))).map((e) => e.action),
  );

describe('linking a second sign-in to the same person', () => {
  it('lets a fresh sign-in reach the same member and organization', async () => {
    const owner = user();
    const { membership } = await ensureOwnerOrganization(app.db, {
      userId: owner,
      email: 'riley@example.com',
    });
    const work = user();

    const result = await linkSignIn(
      app.db,
      membership,
      { userId: work, email: 'r@work.example' },
      owner,
    );
    expect(result).toMatchObject({
      status: 'linked',
      signIn: { userId: work, email: 'r@work.example' },
    });

    expect(await findMemberships(app.db, work)).toEqual([membership]);
    const again = await ensureOwnerOrganization(app.db, { userId: work, email: 'r@work.example' });
    expect(again).toEqual({ membership, created: false });

    const signIns = await withOrg(app.db, membership.orgId, (tx) =>
      listSignIns(tx, membership.memberId),
    );
    expect(signIns.map((s) => s.userId)).toEqual([owner, work]);
    expect(await actions(membership.orgId)).toEqual([
      'organization.created',
      'member_sign_in.linked',
    ]);
  });

  it('is idempotent', async () => {
    const acme = await seedOrg(app.db, 'acme-link-again');
    const membership = { orgId: acme.orgId, memberId: acme.memberId, role: 'owner' as const };
    const other = { userId: user(), email: 'b@example.com' };
    await linkSignIn(app.db, membership, other, acme.userId);
    const again = await linkSignIn(app.db, membership, other, acme.userId);
    expect(again.status).toBe('already_linked');
    expect(await actions(acme.orgId)).toEqual(['member_sign_in.linked']);
  });

  it('moves a sign-in out of the empty organization its first sign-in created', async () => {
    const gmail = await ensureOwnerOrganization(app.db, {
      userId: user(),
      email: 'a@gmail.example',
    });
    const workUser = user();
    const work = await ensureOwnerOrganization(app.db, {
      userId: workUser,
      email: 'a@work.example',
    });
    expect(work.membership.orgId).not.toBe(gmail.membership.orgId);

    const result = await linkSignIn(
      app.db,
      gmail.membership,
      { userId: workUser, email: 'a@work.example' },
      'gmail-user',
    );
    expect(result.status).toBe('linked');
    expect(await findMemberships(app.db, workUser)).toEqual([gmail.membership]);
    // The abandoned organization keeps its history, and records the move.
    expect(await actions(work.membership.orgId)).toEqual([
      'organization.created',
      'member_sign_in.moved_out',
    ]);
    // Its member row is no longer visible to the sign-in that left it.
    const visible = await withUser(app.db, workUser, (tx) => tx.select().from(members));
    expect(visible.map((m) => m.orgId)).toEqual([gmail.membership.orgId]);
  });

  it('refuses to move a sign-in whose organization holds work, and changes nothing', async () => {
    const target = await seedOrg(app.db, 'acme-target');
    const busy = await seedOrg(app.db, 'busy-own-org');
    await withOrg(app.db, busy.orgId, (tx) =>
      tx.insert(expenses).values({
        orgId: busy.orgId,
        memberId: busy.memberId,
        status: 'ready',
        source: 'manual',
        merchant: 'Blue Bottle',
        transactionDate: '2026-09-24',
        amountMinor: 650,
        currency: 'USD',
      }),
    );
    const result = await linkSignIn(
      app.db,
      { orgId: target.orgId, memberId: target.memberId, role: 'owner' },
      { userId: busy.userId, email: 'busy@example.com' },
      target.userId,
    );
    expect(result.status).toBe('has_own_organization');
    expect(await findMemberships(app.db, busy.userId)).toEqual([
      { orgId: busy.orgId, memberId: busy.memberId, role: 'owner' },
    ]);
    expect(await actions(target.orgId)).toEqual([]);
  });

  it("never takes over another person's sign-in in the same organization", async () => {
    const acme = await seedOrg(app.db, 'acme-team');
    const colleague = { id: newId(), userId: user() };
    await withOrg(app.db, acme.orgId, async (tx) => {
      await tx.insert(members).values({
        id: colleague.id,
        orgId: acme.orgId,
        userId: colleague.userId,
        email: 'sam@example.com',
        displayName: 'sam',
        role: 'member',
      });
      await tx.insert(memberSignIns).values({
        orgId: acme.orgId,
        memberId: colleague.id,
        userId: colleague.userId,
        email: 'sam@example.com',
      });
    });
    const result = await linkSignIn(
      app.db,
      { orgId: acme.orgId, memberId: acme.memberId, role: 'owner' },
      { userId: colleague.userId, email: 'sam@example.com' },
      acme.userId,
    );
    expect(result.status).toBe('other_member');
    expect(await findMemberships(app.db, colleague.userId)).toEqual([
      { orgId: acme.orgId, memberId: colleague.id, role: 'member' },
    ]);
  });
});

describe('removing a sign-in', () => {
  it('cuts that sign-in off, keeps the others, and never removes the last one', async () => {
    const acme = await seedOrg(app.db, 'acme-unlink');
    const membership = { orgId: acme.orgId, memberId: acme.memberId, role: 'owner' as const };
    const other = user();
    const linked = await linkSignIn(
      app.db,
      membership,
      { userId: other, email: 'o@x.io' },
      acme.userId,
    );
    if (linked.status !== 'linked') throw new Error('expected a new link');

    expect(await unlinkSignIn(app.db, membership, linked.signIn.id, acme.userId)).toBe('removed');
    expect(await findMemberships(app.db, other)).toEqual([]);
    expect(await unlinkSignIn(app.db, membership, linked.signIn.id, acme.userId)).toBe('not_found');

    const [only] = await withOrg(app.db, acme.orgId, (tx) => listSignIns(tx, acme.memberId));
    expect(await unlinkSignIn(app.db, membership, only!.id, acme.userId)).toBe('last');
    expect(await actions(acme.orgId)).toEqual(['member_sign_in.linked', 'member_sign_in.removed']);
  });
});

describe('sign-in isolation', () => {
  it('shows a user only their own sign-ins without an organization', async () => {
    const acme = await seedOrg(app.db, 'acme-own-sign-ins');
    await seedOrg(app.db, 'globex-own-sign-ins');
    const mine = await withUser(app.db, acme.userId, (tx) => tx.select().from(memberSignIns));
    expect(mine.map((s) => s.userId)).toEqual([acme.userId]);
    expect(await app.db.select().from(memberSignIns)).toEqual([]);
  });

  it("cannot add a sign-in to another organization's member", async () => {
    const acme = await seedOrg(app.db, 'acme-sign-in-rls');
    const globex = await seedOrg(app.db, 'globex-sign-in-rls');
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.insert(memberSignIns).values({
          orgId: globex.orgId,
          memberId: globex.memberId,
          userId: user(),
          email: 'x@y.z',
        }),
      ),
      /row-level security policy/,
    );
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx
          .insert(memberSignIns)
          .values({ orgId: acme.orgId, memberId: globex.memberId, userId: user(), email: 'x@y.z' }),
      ),
      /member_sign_ins_member_fk/,
    );
  });

  it('gives each sign-in to exactly one member', async () => {
    const acme = await seedOrg(app.db, 'acme-unique-sign-in');
    const globex = await seedOrg(app.db, 'globex-unique-sign-in');
    await expectDbError(
      withOrg(app.db, globex.orgId, (tx) =>
        tx.insert(memberSignIns).values({
          orgId: globex.orgId,
          memberId: globex.memberId,
          userId: acme.userId,
          email: 'a@b.c',
        }),
      ),
      /member_sign_ins_user_key/,
    );
    const orgs = await withOrg(app.db, globex.orgId, (tx) => tx.select().from(organizations));
    expect(orgs).toHaveLength(1);
  });
});
