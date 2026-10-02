import { newId } from '@expensewise/domain';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  deleteProviderKey,
  getProviderKey,
  listProviderKeys,
  markProviderKeyVerified,
  saveProviderKey,
} from '../src/ai-keys.ts';
import { withOrg, withUser } from '../src/client.ts';
import { ensureOwnerOrganization, findMemberships } from '../src/members.ts';
import { aiProviderKeys, auditEvents, members, organizations } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const user = () => `user_${newId()}`;

describe('owner organization on first sign-in', () => {
  it('creates a one-person organization with the user as owner, and an audit event', async () => {
    const userId = user();
    const first = await ensureOwnerOrganization(app.db, { userId, email: 'riley@example.com' });
    expect(first.created).toBe(true);
    expect(first.membership.role).toBe('owner');

    const { orgId } = first.membership;
    const [org] = await withOrg(app.db, orgId, (tx) => tx.select().from(organizations));
    expect(org).toMatchObject({ name: "riley's organization", homeCurrency: 'USD' });
    const events = await withOrg(app.db, orgId, (tx) => tx.select().from(auditEvents));
    expect(events.map((e) => e.action)).toEqual(['organization.created']);
  });

  it('returns the existing membership on later sign-ins', async () => {
    const userId = user();
    const first = await ensureOwnerOrganization(app.db, { userId, email: 'a@example.com' });
    const again = await ensureOwnerOrganization(app.db, { userId, email: 'a@example.com' });
    expect(again).toEqual({ membership: first.membership, created: false });
  });

  it('creates exactly one organization when first sign-ins race', async () => {
    const userId = user();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ensureOwnerOrganization(app.db, { userId, email: 'b@x.io' })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.membership.orgId)).size).toBe(1);
    expect(await findMemberships(app.db, userId)).toHaveLength(1);
  });
});

describe('membership lookup', () => {
  it('shows a user only their own memberships, across organizations', async () => {
    const acme = await seedOrg(app.db, 'acme-lookup');
    const [acmeMember] = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(members));
    const mine = await findMemberships(app.db, acmeMember!.userId);
    expect(mine).toEqual([{ orgId: acme.orgId, memberId: acme.memberId, role: 'owner' }]);
    expect(await findMemberships(app.db, user())).toEqual([]);
  });

  it('shows no member rows at all without a user or an organization', async () => {
    expect(await app.db.select().from(members)).toEqual([]);
    const someoneElse = await withUser(app.db, user(), (tx) => tx.select().from(members));
    expect(someoneElse).toEqual([]);
  });

  it('never lets the membership policy write: it is read-only', async () => {
    const acme = await seedOrg(app.db, 'acme-readonly');
    const [m] = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(members));
    const moved = await withUser(app.db, m!.userId, (tx) =>
      tx.update(members).set({ displayName: 'hijacked' }).returning({ id: members.id }),
    );
    expect(moved).toEqual([]);
  });
});

describe('AI provider keys', () => {
  const write = (memberId: string, hint = 'wAA1') => ({
    provider: 'anthropic' as const,
    ciphertext: 'v1.ciphertext-placeholder',
    keyHint: hint,
    authScheme: 'api_key' as const,
    verifiedAt: new Date('2026-10-02T12:00:00Z'),
    memberId,
  });

  it('saves, replaces, verifies and removes a key within one organization', async () => {
    const acme = await seedOrg(app.db, 'acme-keys');
    await withOrg(app.db, acme.orgId, (tx) =>
      saveProviderKey(tx, acme.orgId, write(acme.memberId)),
    );
    const replaced = await withOrg(app.db, acme.orgId, (tx) =>
      saveProviderKey(tx, acme.orgId, { ...write(acme.memberId, 'zz99'), authScheme: 'bearer' }),
    );
    expect(replaced).toMatchObject({
      provider: 'anthropic',
      keyHint: 'zz99',
      authScheme: 'bearer',
    });
    expect(await withOrg(app.db, acme.orgId, (tx) => listProviderKeys(tx))).toHaveLength(1);

    const later = new Date('2026-10-03T09:00:00Z');
    await withOrg(app.db, acme.orgId, (tx) => markProviderKeyVerified(tx, 'anthropic', later));
    const stored = await withOrg(app.db, acme.orgId, (tx) => getProviderKey(tx, 'anthropic'));
    expect(stored?.verifiedAt?.toISOString()).toBe(later.toISOString());

    expect(await withOrg(app.db, acme.orgId, (tx) => deleteProviderKey(tx, 'anthropic'))).toBe(
      true,
    );
    expect(await withOrg(app.db, acme.orgId, (tx) => deleteProviderKey(tx, 'anthropic'))).toBe(
      false,
    );
  });

  it("keeps one organization's keys away from every other", async () => {
    const acme = await seedOrg(app.db, 'acme-keys-iso');
    const globex = await seedOrg(app.db, 'globex-keys-iso');
    await withOrg(app.db, acme.orgId, (tx) =>
      saveProviderKey(tx, acme.orgId, write(acme.memberId)),
    );

    expect(await withOrg(app.db, globex.orgId, (tx) => listProviderKeys(tx))).toEqual([]);
    expect(await app.db.select().from(aiProviderKeys)).toEqual([]);
    expect(await withOrg(app.db, globex.orgId, (tx) => deleteProviderKey(tx, 'anthropic'))).toBe(
      false,
    );
    await expectDbError(
      withOrg(app.db, globex.orgId, (tx) => saveProviderKey(tx, acme.orgId, write(acme.memberId))),
      /row-level security policy/,
    );
  });

  it('stores at most four characters of the key as its hint', async () => {
    const acme = await seedOrg(app.db, 'acme-keys-hint');
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        saveProviderKey(tx, acme.orgId, write(acme.memberId, 'sk-ant-full-key')),
      ),
      /ai_provider_keys_hint_short/,
    );
  });

  it('keeps a key attributed to a member of the same organization', async () => {
    const acme = await seedOrg(app.db, 'acme-keys-fk');
    const globex = await seedOrg(app.db, 'globex-keys-fk');
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) => saveProviderKey(tx, acme.orgId, write(globex.memberId))),
      /ai_provider_keys_updated_by_fk/,
    );
    // The application role cannot read the raw table without an organization either.
    expect(
      (await app.db.execute(sql`select count(*)::int as n from ai_provider_keys`)).rows[0],
    ).toEqual({ n: 0 });
  });
});
