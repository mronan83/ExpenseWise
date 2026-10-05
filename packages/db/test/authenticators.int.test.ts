import { randomUUID } from 'node:crypto';
import { newId } from '@expensewise/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrg, withUser } from '../src/client.ts';
import {
  findSignedInMember,
  signInAuthenticators,
  signInHasAuthenticator,
} from '../src/members.ts';
import { members, memberSignIns, organizations } from '../src/schema.ts';
import { connectAs, expectDbError } from './helpers.ts';

/*
 * How the API learns whether a sign-in has a second factor (#85, ADR-0044): from Supabase
 * Auth's own record of factors, through one function the app may call and nothing else; and
 * whether the person it belongs to has one on any email they sign in with, so another of their
 * emails with none is held until it adds its own (#88, Q43). These tests run on plain Postgres,
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
  app.db.transaction((tx) => signInAuthenticators(tx, userId));

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
});
