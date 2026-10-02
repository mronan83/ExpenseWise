import { afterAll, describe, expect, inject, it } from 'vitest';
import pg from 'pg';
import { canSignIn, roleConnectionString, setRolePasswords } from '../src/role-passwords.ts';

const ownerUrl = inject('ownerUrl');
const appUrl = inject('appUrl');
const relayUrl = inject('relayUrl');
const passwords = {
  expensewise_app: decodeURIComponent(new URL(appUrl).password),
  expensewise_relay: decodeURIComponent(new URL(relayUrl).password),
};

const owner = new pg.Client({ connectionString: ownerUrl });
const connected = owner.connect();
afterAll(() => owner.end());

/** The stored SCRAM verifiers. Readable here because the local owner is a superuser. */
async function verifiers(): Promise<Record<string, string>> {
  await connected;
  const { rows } = await owner.query<{ rolname: string; rolpassword: string }>(
    `select rolname, rolpassword from pg_authid where rolname like 'expensewise_%'`,
  );
  return Object.fromEntries(rows.map((r) => [r.rolname, r.rolpassword]));
}

describe('setting runtime role passwords', () => {
  it('can tell a working password from a wrong one', async () => {
    expect(await canSignIn(appUrl)).toBe(true);
    const wrong = roleConnectionString(ownerUrl, 'expensewise_app', 'not-the-password-at-all-1234');
    expect(await canSignIn(wrong)).toBe(false);
  });

  it('leaves a role alone when it already signs in, so a pooler cache stays valid', async () => {
    const before = await verifiers();
    await setRolePasswords(owner, passwords, {
      alreadyWorks: (role, password) => canSignIn(roleConnectionString(ownerUrl, role, password)),
    });
    expect(await verifiers()).toEqual(before);
  });

  it('sets the password again when the role cannot sign in, and it still works', async () => {
    const before = await verifiers();
    await setRolePasswords(owner, passwords, { alreadyWorks: () => Promise.resolve(false) });
    const after = await verifiers();
    expect(after.expensewise_app).not.toBe(before.expensewise_app);
    expect(await canSignIn(appUrl)).toBe(true);
    expect(await canSignIn(relayUrl)).toBe(true);
  });
});
