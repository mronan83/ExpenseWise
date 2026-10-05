/**
 * The second factor everywhere through the API on a real database, as expensewise_app (#85,
 * ADR-0044): whether a sign-in has an authenticator comes from Supabase Auth's record of
 * factors, read as each request resolves its caller. Plain Postgres has no Supabase Auth, so
 * this stands in for its auth.mfa_factors in this run's database, and leaves it there: the
 * other tests' users aren't Supabase users and have no factor. A bearer token signs in as the
 * user it names; one ending in "@aal2" is a session that passed the code. A person's other
 * email, with no authenticator of its own while another of theirs has one, is held until it adds
 * its own (#88). Run with `pnpm test:integration`.
 */
import { randomUUID } from 'node:crypto';
import { createDatabase } from '@expensewise/db';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createApi } from '../src/app.ts';
import { dbWorkspaceStore } from '../src/workspace.ts';

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
    relayUrl: string;
  }
}

const { db, pool } = createDatabase(inject('appUrl'));
const owner = createDatabase(inject('ownerUrl'));
afterAll(async () => {
  await pool.end();
  await owner.pool.end();
});

const AAL2 = '@aal2';
const apiWith = (flagOverrides: string) =>
  createApi({
    version: 'int',
    verifyToken: (token) => {
      const userId = token.replace(AAL2, '');
      return Promise.resolve({
        userId,
        email: `${userId}@example.com`,
        assuranceLevel: token.endsWith(AAL2) ? 'aal2' : 'aal1',
        sessionId: 's',
        issuedAt: new Date(),
      });
    },
    workspace: dbWorkspaceStore(db),
    flagOverrides,
  });
const on = apiWith('security.second-factor=on');
const off = apiWith('');

const call = async (
  api: ReturnType<typeof apiWith>,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) => {
  const res = await api.request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as { code?: string; email?: string } | null,
  };
};

const addFactor = async (userId: string) => {
  const id = randomUUID();
  await owner.pool.query(
    `insert into auth.mfa_factors (id, user_id, friendly_name, status)
     values ($1::uuid, $2::uuid, 'Phone', 'verified')`,
    [id, userId],
  );
  return id;
};
const removeFactor = (id: string) =>
  owner.pool.query('delete from auth.mfa_factors where id = $1::uuid', [id]);

beforeAll(async () => {
  // Supabase's layout of the columns read; made by its auth service there.
  await owner.pool.query('create schema if not exists auth');
  await owner.pool.query(`
    do $$ begin
      create type auth.factor_status as enum ('unverified', 'verified');
    exception when duplicate_object then null;
    end $$`);
  await owner.pool.query(`
    create table if not exists auth.mfa_factors (
      id uuid primary key,
      user_id uuid not null,
      friendly_name text,
      factor_type text not null default 'totp',
      status auth.factor_status not null,
      created_at timestamptz not null default now()
    )`);
});

describe('the second factor everywhere, on a real database (#85)', () => {
  it('holds every request of someone with an authenticator until they pass the code, and lets go once it is removed', async () => {
    const alex = randomUUID();
    expect((await call(off, alex, 'POST', '/v1/me/organization')).status).toBe(201);
    const phone = await addFactor(alex);

    // On: a password alone reaches nothing but who they are and the switches.
    expect(await call(on, alex, 'GET', '/v1/me/sign-ins')).toMatchObject({
      status: 403,
      body: { code: 'second_factor_required' },
    });
    expect(await call(on, alex, 'POST', '/v1/me/organization')).toMatchObject({
      status: 403,
      body: { code: 'second_factor_required' },
    });
    expect((await call(on, alex, 'GET', '/v1/features')).status).toBe(200);
    expect((await call(on, alex, 'GET', '/v1/me')).status).toBe(200);
    expect((await call(on, `${alex}${AAL2}`, 'GET', '/v1/me/sign-ins')).status).toBe(200);

    // Off: nothing changes.
    expect((await call(off, alex, 'GET', '/v1/me/sign-ins')).status).toBe(200);

    // Removed in Supabase Auth, by its person or by the owner for a lost phone: let go at once.
    await removeFactor(phone);
    expect((await call(on, alex, 'GET', '/v1/me/sign-ins')).status).toBe(200);
  });

  it('asks nothing more of someone with no authenticator', async () => {
    const sam = randomUUID();
    expect((await call(on, sam, 'POST', '/v1/me/organization')).status).toBe(201);
    expect((await call(on, sam, 'GET', '/v1/me/sign-ins')).status).toBe(200);
  });

  it('needs the code to link another sign-in from someone with an authenticator, whatever the switch', async () => {
    const riley = randomUUID();
    expect((await call(off, riley, 'POST', '/v1/me/organization')).status).toBe(201);
    await addFactor(riley);
    const link = (token: string) =>
      call(off, token, 'POST', '/v1/me/sign-ins', { accessToken: randomUUID() });

    expect(await link(riley)).toMatchObject({
      status: 403,
      body: { code: 'second_factor_required' },
    });
    const signIns = await call(off, `${riley}${AAL2}`, 'GET', '/v1/me/sign-ins');
    expect(signIns.body).toMatchObject({ signIns: [{ current: true }] });
    expect((await link(`${riley}${AAL2}`)).status).toBe(201);
  });
});

describe('a person’s other email, on a real database (#88)', () => {
  /** A person who signs in with two emails, the second linked to the first's member. */
  const twoEmails = async () => {
    const first = randomUUID();
    const second = randomUUID();
    expect((await call(off, first, 'POST', '/v1/me/organization')).status).toBe(201);
    expect(
      (await call(off, first, 'POST', '/v1/me/sign-ins', { accessToken: second })).status,
    ).toBe(201);
    return { first, second };
  };

  it('holds the email with no authenticator of its own until it adds one and passes it, while it is on', async () => {
    const { first, second } = await twoEmails();
    // Neither has one yet: nothing is held.
    expect((await call(on, second, 'GET', '/v1/me/sign-ins')).status).toBe(200);

    await addFactor(first);
    // The other email: held, whatever its session says, naming it.
    for (const token of [second, `${second}${AAL2}`]) {
      expect(await call(on, token, 'GET', '/v1/me/sign-ins')).toMatchObject({
        status: 403,
        body: { code: 'authenticator_required', email: `${second}@example.com` },
      });
    }
    expect(await call(on, second, 'POST', '/v1/me/organization')).toMatchObject({
      status: 403,
      body: { code: 'authenticator_required' },
    });
    // What adding one in Settings › Sign-ins reads still answers.
    expect((await call(on, second, 'GET', '/v1/features')).status).toBe(200);
    expect((await call(on, second, 'GET', '/v1/me')).status).toBe(200);
    // The email with it is asked for its code, as before (#85).
    expect(await call(on, first, 'GET', '/v1/me/sign-ins')).toMatchObject({
      status: 403,
      body: { code: 'second_factor_required' },
    });
    expect((await call(on, `${first}${AAL2}`, 'GET', '/v1/me/sign-ins')).status).toBe(200);

    // Off: nothing changes.
    expect((await call(off, second, 'GET', '/v1/me/sign-ins')).status).toBe(200);

    // It adds its own: now it is asked for its code, and opens once it is in.
    await addFactor(second);
    expect(await call(on, second, 'GET', '/v1/me/sign-ins')).toMatchObject({
      status: 403,
      body: { code: 'second_factor_required' },
    });
    expect((await call(on, `${second}${AAL2}`, 'GET', '/v1/me/sign-ins')).status).toBe(200);
  });

  it('frees the other emails at once when the person’s only authenticator is removed', async () => {
    const { first, second } = await twoEmails();
    const phone = await addFactor(first);
    expect((await call(on, second, 'GET', '/v1/me/sign-ins')).body?.code).toBe(
      'authenticator_required',
    );
    // Removed in Supabase Auth, by its person or by the owner for a lost phone.
    await removeFactor(phone);
    expect((await call(on, second, 'GET', '/v1/me/sign-ins')).status).toBe(200);
    expect((await call(on, first, 'GET', '/v1/me/sign-ins')).status).toBe(200);
  });
});
