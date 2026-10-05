import { randomUUID } from 'node:crypto';
import { inviteExpiresAt, newId } from '@expensewise/domain';
import { and, asc, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrg, withUser, type Transaction } from '../src/client.ts';
import { memberForSender, recordInboundEmail } from '../src/inbound.ts';
import { letSignInIn, recordPassedCode, withdrawSignIn } from '../src/let-in.ts';
import {
  ensureOwnerOrganization,
  findSignedInMember,
  signInHasAuthenticator,
  signInStanding,
} from '../src/members.ts';
import { acceptInvite, createInvite, inviteTokenHash, newInviteToken } from '../src/people.ts';
import { auditEvents, letInSignIns, members, memberSignIns, organizations } from '../src/schema.ts';
import { listSignIns, unlinkSignIn } from '../src/sign-ins.ts';
import { connectAs, expectDbError } from './helpers.ts';

/*
 * How the API learns whether a sign-in has a second factor (#85, ADR-0044): from Supabase
 * Auth's own record of factors, through one function the app may call and nothing else; and
 * whether the person it belongs to has one on any email they sign in with, so another of their
 * emails with none is held until it adds its own (#88, Q43); which of their emails they let in,
 * the only ones that sign in once they have one (#90, Q44); and which they first signed in with,
 * the only one let in on its own (#91, Q45). These tests run on plain Postgres,
 * which has no Supabase Auth; the second half stands in for it with the columns of
 * auth.mfa_factors the function reads, as Supabase lays them out, in this test's database only.
 */

const owner = connectAs('owner');
const app = connectAs('app');
afterAll(async () => {
  await owner.pool.end();
  await app.pool.end();
});

/** What the app is told about a sign-in, as expensewise_app. */
const asks = (userId: string) => app.db.transaction((tx) => signInHasAuthenticator(tx, userId));
/** What the app is told about a sign-in and the person it belongs to, as expensewise_app. */
const asksOfPerson = (userId: string) =>
  app.db.transaction(async (tx) => {
    const { authenticator, personAuthenticator } = await signInStanding(tx, userId);
    return { authenticator, personAuthenticator };
  });
/** Where a sign-in stands, as the app is told it on that sign-in's own request. */
const standing = (userId: string) => withUser(app.db, userId, (tx) => signInStanding(tx, userId));

/** An organization whose owner signs in as a Supabase Auth user, by its UUID. */
async function seedSignedIn(name: string) {
  const orgId = newId();
  const memberId = newId();
  const userId = randomUUID();
  await withOrg(owner.db, orgId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name, homeCurrency: 'USD' });
    await tx.insert(members).values({
      id: memberId,
      orgId,
      userId,
      email: `${name}@example.com`,
      displayName: name,
      role: 'owner',
    });
    await tx
      .insert(memberSignIns)
      .values({ orgId, memberId, userId, email: `${name}@example.com` });
  });
  return { orgId, memberId, userId };
}

/** Another email the same person signs in with, linked to their member (ADR-0016). */
async function linkAnother(person: { orgId: string; memberId: string }, name: string) {
  const userId = randomUUID();
  await withOrg(owner.db, person.orgId, (tx) =>
    tx.insert(memberSignIns).values({
      orgId: person.orgId,
      memberId: person.memberId,
      userId,
      email: `${name}@example.com`,
    }),
  );
  return userId;
}

describe('on plain Postgres, with no Supabase Auth', () => {
  it('knows no authenticator, as no one could have added one', async () => {
    const { rows } = await owner.db.execute<{ found: string | null }>(
      sql`select to_regclass('auth.mfa_factors')::text as found`,
    );
    expect(rows).toEqual([{ found: null }]);
    const acme = await seedSignedIn('acme-plain');
    expect(await asks(acme.userId)).toBe(false);
    expect(await findSignedInMember(app.db, acme.userId)).toEqual({
      orgId: acme.orgId,
      memberId: acme.memberId,
      role: 'owner',
      authenticator: false,
      personAuthenticator: false,
      letIn: 'no',
      personLetIn: 'none',
      firstSignIn: true,
    });
  });

  it('knows no person with an authenticator either, however many emails they sign in with', async () => {
    const acme = await seedSignedIn('acme-plain-person');
    const other = await linkAnother(acme, 'acme-plain-other');
    expect(await asksOfPerson(acme.userId)).toEqual({
      authenticator: false,
      personAuthenticator: false,
    });
    expect(await asksOfPerson(other)).toEqual({ authenticator: false, personAuthenticator: false });
  });
});

describe('with Supabase Auth’s record of factors', () => {
  beforeAll(async () => {
    // Supabase's own layout of the columns read, made by its auth service there; here only.
    await owner.db.execute(sql`create schema if not exists auth`);
    await owner.db.execute(sql`create type auth.factor_status as enum ('unverified', 'verified')`);
    await owner.db.execute(sql`
      create table auth.mfa_factors (
        id uuid primary key,
        user_id uuid not null,
        friendly_name text,
        factor_type text not null default 'totp',
        status auth.factor_status not null,
        secret text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )`);
  });
  afterAll(async () => {
    await owner.db.execute(sql`drop schema if exists auth cascade`);
  });

  const addFactor = async (userId: string, status: 'unverified' | 'verified') => {
    const id = randomUUID();
    await owner.db.execute(sql`
      insert into auth.mfa_factors (id, user_id, friendly_name, status, secret)
      values (${id}::uuid, ${userId}::uuid, 'Phone', ${status}, 'never-read')`);
    return id;
  };
  const removeFactor = (id: string) =>
    owner.db.execute(sql`delete from auth.mfa_factors where id = ${id}::uuid`);

  it('counts only a verified factor of that sign-in, as Supabase Auth keeps it', async () => {
    const alex = randomUUID();
    const sam = randomUUID();
    expect(await asks(alex)).toBe(false);

    // Half-added: Supabase keeps it unverified until its first code.
    const pending = await addFactor(alex, 'unverified');
    expect(await asks(alex)).toBe(false);

    const phone = await addFactor(alex, 'verified');
    expect(await asks(alex)).toBe(true);
    // Someone else's factor is never theirs.
    expect(await asks(sam)).toBe(false);

    await removeFactor(pending);
    expect(await asks(alex)).toBe(true);
    await removeFactor(phone);
    expect(await asks(alex)).toBe(false);
  });

  it('answers on the next question once the last one is removed, so no one stays locked out', async () => {
    const acme = await seedSignedIn('acme-removed');
    const phone = await addFactor(acme.userId, 'verified');
    expect(await findSignedInMember(app.db, acme.userId)).toMatchObject({
      orgId: acme.orgId,
      authenticator: true,
    });
    // As when its person removes it, or the owner does for someone who lost their phone.
    await removeFactor(phone);
    expect(await findSignedInMember(app.db, acme.userId)).toMatchObject({
      orgId: acme.orgId,
      authenticator: false,
    });
  });

  it('knows no factor for a user id that is not a Supabase Auth user', async () => {
    expect(await asks(`user_${newId()}`)).toBe(false);
    expect(await asks('')).toBe(false);
  });

  it('gives the app one answer and nothing else of Supabase Auth: it can neither read nor change a factor', async () => {
    const alex = randomUUID();
    await addFactor(alex, 'verified');
    await expectDbError(
      app.db.execute(sql`select secret from auth.mfa_factors`),
      /permission denied/,
    );
    // So a session that skipped the code can't clear what says it has one.
    await expectDbError(
      app.db.execute(sql`delete from auth.mfa_factors where user_id = ${alex}::uuid`),
      /permission denied/,
    );
    expect(await asks(alex)).toBe(true);
    const { rows } = await owner.db.execute<{ role: string; can: boolean }>(sql`
      select r.role, has_function_privilege(r.role, 'sign_in_has_authenticator(text)', 'EXECUTE') as can
        from unnest(array['expensewise_app', 'expensewise_relay', 'anon', 'authenticated', 'service_role']) as r(role)
       order by r.role`);
    expect(rows).toEqual([
      { role: 'anon', can: false },
      { role: 'authenticated', can: false },
      { role: 'expensewise_app', can: true },
      { role: 'expensewise_relay', can: false },
      { role: 'service_role', can: false },
    ]);
  });

  it('knows a person has an authenticator from a verified factor on any email they sign in with, and only theirs', async () => {
    const acme = await seedSignedIn('acme-person');
    const work = await linkAnother(acme, 'acme-person-work');
    const someoneElse = await seedSignedIn('acme-someone-else');
    expect(await asksOfPerson(work)).toEqual({ authenticator: false, personAuthenticator: false });

    // Half-added on the person's first email: not yet.
    await addFactor(acme.userId, 'unverified');
    expect(await asksOfPerson(work)).toEqual({ authenticator: false, personAuthenticator: false });

    await addFactor(acme.userId, 'verified');
    // The email with it, and the other with none: the one held until it adds its own (#88).
    expect(await asksOfPerson(acme.userId)).toEqual({
      authenticator: true,
      personAuthenticator: true,
    });
    expect(await asksOfPerson(work)).toEqual({ authenticator: false, personAuthenticator: true });
    expect(await findSignedInMember(app.db, work)).toEqual({
      orgId: acme.orgId,
      memberId: acme.memberId,
      role: 'owner',
      authenticator: false,
      personAuthenticator: true,
      letIn: 'no',
      personLetIn: 'none',
      firstSignIn: false,
    });
    // Someone else's is never theirs, nor theirs someone else's.
    expect(await asksOfPerson(someoneElse.userId)).toEqual({
      authenticator: false,
      personAuthenticator: false,
    });

    // The other email adds its own: it has one too.
    await addFactor(work, 'verified');
    expect(await asksOfPerson(work)).toEqual({ authenticator: true, personAuthenticator: true });
  });

  it('frees a person’s other emails on the next question once their only authenticator is removed, or the email is unlinked', async () => {
    const acme = await seedSignedIn('acme-person-removed');
    const work = await linkAnother(acme, 'acme-person-removed-work');
    const phone = await addFactor(acme.userId, 'verified');
    expect(await findSignedInMember(app.db, work)).toMatchObject({ personAuthenticator: true });

    // As when its person removes it, or the owner does for someone who lost their phone.
    await removeFactor(phone);
    expect(await findSignedInMember(app.db, work)).toMatchObject({
      authenticator: false,
      personAuthenticator: false,
    });

    // Unlinked, an email is no longer theirs, and knows nothing of their authenticator.
    await addFactor(acme.userId, 'verified');
    expect(await asksOfPerson(work)).toEqual({ authenticator: false, personAuthenticator: true });
    await withOrg(owner.db, acme.orgId, (tx) =>
      tx.delete(memberSignIns).where(eq(memberSignIns.userId, work)),
    );
    expect(await asksOfPerson(work)).toEqual({ authenticator: false, personAuthenticator: false });
  });

  it('gives the app one answer about the person and no sight of their other emails', async () => {
    const acme = await seedSignedIn('acme-person-private');
    const work = await linkAnother(acme, 'acme-person-private-work');
    await addFactor(acme.userId, 'verified');
    // Before an organization is chosen the app sees only the token's own sign-in, so the
    // person's other emails are read by the owner-run function, which answers yes or no.
    const seen = await withUser(app.db, work, (tx) =>
      tx.select({ email: memberSignIns.email }).from(memberSignIns),
    );
    expect(seen).toEqual([{ email: 'acme-person-private-work@example.com' }]);
    expect(await asksOfPerson(work)).toEqual({ authenticator: false, personAuthenticator: true });
    const { rows } = await owner.db.execute<{ role: string; can: boolean }>(sql`
      select r.role, has_function_privilege(r.role, 'person_has_authenticator(text)', 'EXECUTE') as can
        from unnest(array['expensewise_app', 'expensewise_relay', 'anon', 'authenticated', 'service_role']) as r(role)
       order by r.role`);
    expect(rows).toEqual([
      { role: 'anon', can: false },
      { role: 'authenticated', can: false },
      { role: 'expensewise_app', can: true },
      { role: 'expensewise_relay', can: false },
      { role: 'service_role', can: false },
    ]);
    // A sign-in no member has, or one that isn't a Supabase Auth user, has no person here.
    expect(await asksOfPerson(randomUUID())).toEqual({
      authenticator: false,
      personAuthenticator: false,
    });
    expect(await asksOfPerson(`user_${newId()}`)).toEqual({
      authenticator: false,
      personAuthenticator: false,
    });
  });

  /* Only an email a person lets in signs in, once they have an authenticator (#90, Q44). */
  describe('letting a person’s emails in (#90)', () => {
    const passed = { assuranceLevel: 'aal2' };
    const password = { assuranceLevel: 'aal1' };
    const membership = (p: { orgId: string; memberId: string }) => ({
      orgId: p.orgId,
      memberId: p.memberId,
      role: 'owner' as const,
    });
    /** A person with two emails, the first with an authenticator. */
    async function twoEmails(name: string) {
      const person = await seedSignedIn(name);
      const work = await linkAnother(person, `${name}-work`);
      await addFactor(person.userId, 'verified');
      const signIns = await withOrg(owner.db, person.orgId, (tx) =>
        tx
          .select({ id: memberSignIns.id, userId: memberSignIns.userId })
          .from(memberSignIns)
          .where(eq(memberSignIns.memberId, person.memberId)),
      );
      const idOf = (userId: string) => signIns.find((s) => s.userId === userId)!.id;
      return {
        ...person,
        member: membership(person),
        work,
        firstId: idOf(person.userId),
        workId: idOf(work),
      };
    }
    const letInEvents = (orgId: string) =>
      owner.db
        .select({
          action: auditEvents.action,
          entityId: auditEvents.entityId,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(
          and(eq(auditEvents.orgId, orgId), like(auditEvents.action, 'member_sign_in.let_in%')),
        )
        .orderBy(asc(auditEvents.sequence));
    /** A write to who is let in, straight to the table as the app, at `level`, as `userId`. */
    const asApp = (
      orgId: string,
      userId: string,
      level: string,
      work: (tx: Transaction) => Promise<unknown>,
    ) =>
      withOrg(
        app.db,
        orgId,
        async (tx) => {
          await tx.execute(sql`select set_config('app.assurance_level', ${level}, true)`);
          await work(tx);
        },
        { userId },
      );

    it('lets in the email a person first signed in with once it passes its code, once, with its audit event', async () => {
      const p = await twoEmails('let-in-first');
      expect(await standing(p.userId)).toEqual({
        authenticator: true,
        personAuthenticator: true,
        letIn: 'no',
        personLetIn: 'none',
        firstSignIn: true,
      });
      const actor = { userId: p.userId, ...passed };
      expect(await recordPassedCode(app.db, p.member, actor)).toBe('let_in_first');
      expect(await recordPassedCode(app.db, p.member, actor)).toBe('let_in');
      expect(await standing(p.userId)).toMatchObject({
        letIn: 'yes',
        personLetIn: 'with_authenticator',
      });
      // The other email isn't let in, and its own authenticator, added now, doesn't make it the first.
      await addFactor(p.work, 'verified');
      expect(await standing(p.work)).toMatchObject({
        letIn: 'no',
        personLetIn: 'with_authenticator',
      });
      expect(await recordPassedCode(app.db, p.member, { userId: p.work, ...passed })).toBe(
        'not_let_in',
      );
      expect(await standing(p.work)).toMatchObject({ letIn: 'no' });
      expect(await letInEvents(p.orgId)).toEqual([
        {
          action: 'member_sign_in.let_in',
          entityId: p.firstId,
          payload: { memberId: p.memberId, first: true },
        },
      ]);
    });

    it('lets another email in from one let in that passed its code, to wait 24 hours for its own, and keeps it let in once it passes it', async () => {
      const p = await twoEmails('let-in-another');
      const actor = { userId: p.userId, ...passed };
      await recordPassedCode(app.db, p.member, actor);
      const result = await letSignInIn(app.db, p.member, p.workId, actor);
      expect(result).toMatchObject({
        status: 'let_in',
        signIn: { id: p.workId, letIn: 'waiting' },
      });
      const [row] = await owner.db
        .execute<{ hours: number }>(
          sql`select extract(epoch from lapses_at - let_in_at)::int / 3600 as hours from let_in_sign_ins where sign_in_id = ${p.workId}`,
        )
        .then((r) => r.rows);
      expect(row?.hours).toBe(24);
      expect(await letSignInIn(app.db, p.member, p.workId, actor)).toMatchObject({
        status: 'already_let_in',
      });
      // Waiting, with no authenticator of its own: the one held until it adds one (#88).
      expect(await standing(p.work)).toEqual({
        authenticator: false,
        personAuthenticator: true,
        letIn: 'waiting',
        personLetIn: 'with_authenticator',
        firstSignIn: false,
      });
      // It adds its own and passes its code: let in for good.
      await addFactor(p.work, 'verified');
      expect(await recordPassedCode(app.db, p.member, { userId: p.work, ...passed })).toBe(
        'passed',
      );
      expect(await standing(p.work)).toMatchObject({ authenticator: true, letIn: 'yes' });
      const listed = await withOrg(app.db, p.orgId, (tx) => listSignIns(tx, p.memberId));
      expect(listed.map((s) => [s.userId, s.letIn, s.letInLapsesAt])).toEqual([
        [p.userId, 'yes', null],
        [p.work, 'yes', null],
      ]);
      expect((await letInEvents(p.orgId)).map((e) => [e.action, e.entityId])).toEqual([
        ['member_sign_in.let_in', p.firstId],
        ['member_sign_in.let_in', p.workId],
        ['member_sign_in.let_in_confirmed', p.workId],
      ]);
    });

    it('lets letting in lapse after 24 hours unless it passes its own code, and lets it in again', async () => {
      const p = await twoEmails('let-in-lapse');
      const actor = { userId: p.userId, ...passed };
      await recordPassedCode(app.db, p.member, actor);
      await letSignInIn(app.db, p.member, p.workId, actor);
      // A day later.
      await owner.db.execute(
        sql`update let_in_sign_ins set lapses_at = now() - interval '1 minute' where sign_in_id = ${p.workId}`,
      );
      expect(await standing(p.work)).toMatchObject({ letIn: 'no' });
      await addFactor(p.work, 'verified');
      expect(await recordPassedCode(app.db, p.member, { userId: p.work, ...passed })).toBe(
        'not_let_in',
      );
      expect(await letSignInIn(app.db, p.member, p.workId, actor)).toMatchObject({
        status: 'let_in',
      });
      expect(await standing(p.work)).toMatchObject({ letIn: 'waiting' });
    });

    it('withdraws an email let in, from one let in that passed its code, and never itself', async () => {
      const p = await twoEmails('let-in-withdraw');
      const actor = { userId: p.userId, ...passed };
      await recordPassedCode(app.db, p.member, actor);
      await letSignInIn(app.db, p.member, p.workId, actor);
      expect(await withdrawSignIn(app.db, p.member, p.firstId, actor)).toBe('current');
      expect(await withdrawSignIn(app.db, p.member, p.workId, actor)).toBe('withdrawn');
      expect(await withdrawSignIn(app.db, p.member, p.workId, actor)).toBe('not_let_in');
      expect(await standing(p.work)).toMatchObject({ letIn: 'no' });
      // An email not let in lets no one in, and withdraws no one.
      const work = { userId: p.work, ...passed };
      await addFactor(p.work, 'verified');
      expect(await letSignInIn(app.db, p.member, p.firstId, work)).toEqual({
        status: 'actor_not_let_in',
      });
      expect(await withdrawSignIn(app.db, p.member, p.firstId, work)).toBe('actor_not_let_in');
      expect(await letSignInIn(app.db, p.member, p.workId, work)).toEqual({ status: 'current' });
      expect((await letInEvents(p.orgId)).map((e) => e.action)).toEqual([
        'member_sign_in.let_in',
        'member_sign_in.let_in',
        'member_sign_in.let_in_withdrawn',
      ]);
    });

    it('never lets a session that skipped the code change who is let in, in the database too', async () => {
      const p = await twoEmails('let-in-aal1');
      await expectDbError(
        recordPassedCode(app.db, p.member, { userId: p.userId, ...password }),
        /let_in: it needs a session that passed the code/,
      );
      await recordPassedCode(app.db, p.member, { userId: p.userId, ...passed });
      await expectDbError(
        letSignInIn(app.db, p.member, p.workId, { userId: p.userId, ...password }),
        /let_in: it needs a session that passed the code/,
      );
      await letSignInIn(app.db, p.member, p.workId, { userId: p.userId, ...passed });
      await expectDbError(
        withdrawSignIn(app.db, p.member, p.workId, { userId: p.userId, ...password }),
        /let_in: it needs a session that passed the code/,
      );
      expect(await standing(p.work)).toMatchObject({ letIn: 'waiting' });
    });

    it('keeps every change to the person themselves, from an email let in with its own authenticator, in the database too', async () => {
      const p = await twoEmails('let-in-rules');
      const someoneElse = await seedSignedIn('let-in-rules-else');
      await addFactor(someoneElse.userId, 'verified');
      // The other email, with no authenticator, can't make itself the first.
      await expectDbError(
        asApp(p.orgId, p.work, 'aal2', (tx) =>
          tx
            .insert(letInSignIns)
            .values({ orgId: p.orgId, signInId: p.workId, passedAt: new Date() }),
        ),
        /let_in: it needs an email with an authenticator of its own/,
      );
      await recordPassedCode(app.db, p.member, { userId: p.userId, ...passed });
      // Once one is let in, no other lets itself in, even with an authenticator of its own.
      await addFactor(p.work, 'verified');
      await expectDbError(
        asApp(p.orgId, p.work, 'aal2', (tx) =>
          tx
            .insert(letInSignIns)
            .values({ orgId: p.orgId, signInId: p.workId, passedAt: new Date() }),
        ),
        /let_in: an email lets itself in only as the first/,
      );
      // While none is let in, no email but the one the person first signed in with lets itself
      // in, even with an authenticator of its own (#91).
      await withOrg(owner.db, p.orgId, (tx) =>
        tx.delete(letInSignIns).where(eq(letInSignIns.signInId, p.firstId)),
      );
      await expectDbError(
        asApp(p.orgId, p.work, 'aal2', (tx) =>
          tx
            .insert(letInSignIns)
            .values({ orgId: p.orgId, signInId: p.workId, passedAt: new Date() }),
        ),
        /let_in: only the email the person first signed in with is let in first/,
      );
      // An email not let in lets no one in. (Before #91 the other email let itself in here;
      // now only the schema owner can put it there.)
      await withOrg(owner.db, p.orgId, (tx) =>
        tx
          .insert(letInSignIns)
          .values({ orgId: p.orgId, signInId: p.workId, passedAt: new Date() }),
      );
      const third = await linkAnother(p, 'let-in-rules-third');
      const [thirdRow] = await withOrg(owner.db, p.orgId, (tx) =>
        tx
          .select({ id: memberSignIns.id })
          .from(memberSignIns)
          .where(eq(memberSignIns.userId, third)),
      );
      await expectDbError(
        asApp(p.orgId, p.userId, 'aal2', (tx) =>
          tx.insert(letInSignIns).values({
            orgId: p.orgId,
            signInId: thirdRow!.id,
            lapsesAt: new Date(Date.now() + 3_600_000),
          }),
        ),
        /let_in: only an email let in that passed its code lets another in/,
      );
      // Nobody else's person, and an email let in can't withdraw itself.
      await expectDbError(
        asApp(p.orgId, someoneElse.userId, 'aal2', (tx) =>
          tx.delete(letInSignIns).where(eq(letInSignIns.signInId, p.workId)),
        ),
        /let_in: only the person themselves changes it/,
      );
      await expectDbError(
        asApp(p.orgId, p.work, 'aal2', (tx) =>
          tx.delete(letInSignIns).where(eq(letInSignIns.signInId, p.workId)),
        ),
        /let_in: only an email let in that passed its code withdraws another/,
      );
    });

    /** The runbook's reset of who is let in, as the schema owner, from any of the person's UIDs. */
    const resetLetIn = (userId: string) =>
      owner.db.execute(sql`
        delete from let_in_sign_ins
         where sign_in_id in (
           select theirs.id from member_sign_ins this
             join member_sign_ins theirs on theirs.org_id = this.org_id and theirs.member_id = this.member_id
            where this.user_id = ${userId})`);
    /** The runbook's naming of the email a person first signed in with, as the schema owner. */
    const nameFirst = (userId: string) =>
      owner.db.execute(sql`
        update members m set user_id = s.user_id, email = s.email
          from member_sign_ins s
         where s.user_id = ${userId} and m.org_id = s.org_id and m.id = s.member_id`);

    it('lets the schema owner reset who is let in, as the runbook does, and the email first signed in with is let in first again', async () => {
      const p = await twoEmails('let-in-reset');
      await recordPassedCode(app.db, p.member, { userId: p.userId, ...passed });
      await addFactor(p.work, 'verified');
      await resetLetIn(p.userId);
      expect(await standing(p.userId)).toMatchObject({ letIn: 'no', personLetIn: 'none' });
      // Before #91 the next of their emails to pass its code was the first; now only theirs is.
      expect(await recordPassedCode(app.db, p.member, { userId: p.work, ...passed })).toBe(
        'not_let_in',
      );
      expect(await recordPassedCode(app.db, p.member, { userId: p.userId, ...passed })).toBe(
        'let_in_first',
      );
    });

    it('lets in only the email a person first signed in with, never another that passes its code first, and records nothing for it (#91)', async () => {
      const p = await twoEmails('first-only');
      await addFactor(p.work, 'verified');
      expect(await standing(p.work)).toEqual({
        authenticator: true,
        personAuthenticator: true,
        letIn: 'no',
        personLetIn: 'none',
        firstSignIn: false,
      });
      expect(await recordPassedCode(app.db, p.member, { userId: p.work, ...passed })).toBe(
        'not_let_in',
      );
      expect(await standing(p.work)).toMatchObject({ letIn: 'no', personLetIn: 'none' });
      expect(await letInEvents(p.orgId)).toEqual([]);
      // The email they first signed in with is let in once it passes its code, then lets the
      // other in, which keeps its own authenticator and stays let in once it passes it.
      expect(await recordPassedCode(app.db, p.member, { userId: p.userId, ...passed })).toBe(
        'let_in_first',
      );
      await letSignInIn(app.db, p.member, p.workId, { userId: p.userId, ...passed });
      expect(await recordPassedCode(app.db, p.member, { userId: p.work, ...passed })).toBe(
        'passed',
      );
      expect((await letInEvents(p.orgId)).map((e) => [e.action, e.entityId])).toEqual([
        ['member_sign_in.let_in', p.firstId],
        ['member_sign_in.let_in', p.workId],
        ['member_sign_in.let_in_confirmed', p.workId],
      ]);
    });

    it('knows which email a person first signed in with: the one their member was made with, on their first sign-in or by an invite, never one linked later (#91)', async () => {
      // On their first sign-in, which makes their organization.
      const alex = randomUUID();
      await ensureOwnerOrganization(app.db, { userId: alex, email: 'first-alex@example.com' });
      expect(await findSignedInMember(app.db, alex)).toMatchObject({ firstSignIn: true });
      expect(await standing(alex)).toMatchObject({ firstSignIn: true });

      // By an invite link, from an empty organization of their own made on an earlier sign-in.
      const sam = randomUUID();
      await ensureOwnerOrganization(app.db, { userId: sam, email: 'first-sam@example.com' });
      const token = newInviteToken();
      const at = new Date();
      const inviter = (await findSignedInMember(app.db, alex))!;
      await withOrg(app.db, inviter.orgId, (tx) =>
        createInvite(
          tx,
          inviter.orgId,
          {
            role: 'member',
            label: null,
            tokenHash: inviteTokenHash(token),
            madeAt: at,
            expiresAt: inviteExpiresAt(at),
            memberId: inviter.memberId,
          },
          alex,
        ),
      );
      const joined = await acceptInvite(
        app.db,
        inviteTokenHash(token),
        { userId: sam, email: 'first-sam@example.com' },
        at,
      );
      expect(joined).toMatchObject({ status: 'joined' });
      const samAsMember = (await findSignedInMember(app.db, sam))!;
      expect(samAsMember).toMatchObject({
        orgId: inviter.orgId,
        role: 'member',
        firstSignIn: true,
      });

      // An email linked later is never the first, for either.
      const samWork = await linkAnother(samAsMember, 'first-sam-work');
      expect(await findSignedInMember(app.db, samWork)).toMatchObject({ firstSignIn: false });
      expect(await standing(samWork)).toMatchObject({ firstSignIn: false });
      const alexWork = await linkAnother(inviter, 'first-alex-work');
      expect(await standing(alexWork)).toMatchObject({ firstSignIn: false });
    });

    it('lets no other email be let in first once the one first signed in with is unlinked, until the schema owner names another, as the runbook does (#91)', async () => {
      const p = await twoEmails('first-unlinked');
      await addFactor(p.work, 'verified');
      // Unlinked from the other email, before either was let in.
      expect(await unlinkSignIn(app.db, p.member, p.firstId, p.work)).toBe('removed');
      expect(await standing(p.work)).toEqual({
        authenticator: true,
        personAuthenticator: true,
        letIn: 'no',
        personLetIn: 'none',
        firstSignIn: false,
      });
      expect(await recordPassedCode(app.db, p.member, { userId: p.work, ...passed })).toBe(
        'not_let_in',
      );
      await expectDbError(
        asApp(p.orgId, p.work, 'aal2', (tx) =>
          tx
            .insert(letInSignIns)
            .values({ orgId: p.orgId, signInId: p.workId, passedAt: new Date() }),
        ),
        /let_in: only the email the person first signed in with is let in first/,
      );
      // The owner names the email they still use, and resets who is let in.
      await nameFirst(p.work);
      await resetLetIn(p.work);
      expect(await standing(p.work)).toMatchObject({ firstSignIn: true });
      expect(await recordPassedCode(app.db, p.member, { userId: p.work, ...passed })).toBe(
        'let_in_first',
      );
    });

    it('never lets the app change which email a member first signed in with, whatever its session, in the database too (#91)', async () => {
      const p = await twoEmails('first-kept');
      await recordPassedCode(app.db, p.member, { userId: p.userId, ...passed });
      for (const level of ['aal1', 'aal2']) {
        await expectDbError(
          asApp(p.orgId, p.userId, level, (tx) =>
            tx.update(members).set({ userId: p.work }).where(eq(members.id, p.memberId)),
          ),
          /first_sign_in: only the schema owner changes which email a member first signed in with/,
        );
      }
      // Anything else of the member the app changes as before.
      await asApp(p.orgId, p.userId, 'aal1', (tx) =>
        tx.update(members).set({ displayName: 'Still first' }).where(eq(members.id, p.memberId)),
      );
      expect(await standing(p.userId)).toMatchObject({ firstSignIn: true, letIn: 'yes' });
      expect(await standing(p.work)).toMatchObject({ firstSignIn: false });
    });

    it('takes letting in away with the sign-in, when it is unlinked', async () => {
      const p = await twoEmails('let-in-unlink');
      const actor = { userId: p.userId, ...passed };
      await recordPassedCode(app.db, p.member, actor);
      await letSignInIn(app.db, p.member, p.workId, actor);
      expect(await unlinkSignIn(app.db, p.member, p.workId, p.userId)).toBe('removed');
      const left = await owner.db
        .select({ signInId: letInSignIns.signInId })
        .from(letInSignIns)
        .where(eq(letInSignIns.orgId, p.orgId));
      expect(left).toEqual([{ signInId: p.firstId }]);
    });

    it('files email from an address not let in, as from any of the person’s', async () => {
      const p = await twoEmails('let-in-email');
      await recordPassedCode(app.db, p.member, { userId: p.userId, ...passed });
      expect(await standing(p.work)).toMatchObject({
        letIn: 'no',
        personLetIn: 'with_authenticator',
      });
      const sender = await memberForSender(app.db, 'Let-In-Email-Work@Example.com');
      expect(sender).toEqual({ orgId: p.orgId, memberId: p.memberId, userId: p.work });
      const receiptId = newId();
      const result = await withOrg(app.db, p.orgId, (tx) =>
        recordInboundEmail(
          tx,
          p.orgId,
          {
            id: newId(),
            memberId: sender!.memberId,
            provider: 'bird',
            providerMessageId: `rem_${newId()}`,
            fromAddress: 'let-in-email-work@example.com',
            subject: 'Your Uber receipt',
            sentAt: null,
            status: 'filed',
            bodyText: null,
          },
          [
            {
              receiptId,
              storageKey: `orgs/${p.orgId}/receipts/${receiptId}`,
              contentType: 'application/pdf',
              byteSize: 20_000,
              sha256: 'e'.repeat(64),
            },
          ],
          sender!.userId,
        ),
      );
      expect(result).toMatchObject({ status: 'recorded', receiptIds: [receiptId] });
    });

    it('tells the app where a sign-in stands and nothing of the person’s other emails', async () => {
      const p = await twoEmails('let-in-private');
      await recordPassedCode(app.db, p.member, { userId: p.userId, ...passed });
      // Before an organization is chosen the app sees its own sign-in and no let-in row.
      const seen = await withUser(app.db, p.work, async (tx) => ({
        signIns: await tx.select({ email: memberSignIns.email }).from(memberSignIns),
        letIn: await tx.select().from(letInSignIns),
      }));
      expect(seen).toEqual({ signIns: [{ email: 'let-in-private-work@example.com' }], letIn: [] });
      const { rows } = await owner.db.execute<{ role: string; own: boolean; person: boolean }>(sql`
        select r.role,
               has_function_privilege(r.role, 'sign_in_let_in(text)', 'EXECUTE') as own,
               has_function_privilege(r.role, 'person_let_in(text)', 'EXECUTE') as person
          from unnest(array['expensewise_app', 'expensewise_relay', 'anon', 'authenticated', 'service_role']) as r(role)
         order by r.role`);
      expect(rows).toEqual([
        { role: 'anon', own: false, person: false },
        { role: 'authenticated', own: false, person: false },
        { role: 'expensewise_app', own: true, person: true },
        { role: 'expensewise_relay', own: false, person: false },
        { role: 'service_role', own: false, person: false },
      ]);
      expect(await standing(randomUUID())).toEqual({
        authenticator: false,
        personAuthenticator: false,
        letIn: 'no',
        personLetIn: 'none',
        firstSignIn: false,
      });
    });
  });
});
