import { newId } from '@expensewise/domain';
import { expect, inject } from 'vitest';
import { createDatabase, withOrg, type Database } from '../src/client.ts';
import { members, memberSignIns, organizations } from '../src/schema.ts';

export function connectAs(role: 'owner' | 'app' | 'relay') {
  const urls = { owner: inject('ownerUrl'), app: inject('appUrl'), relay: inject('relayUrl') };
  return createDatabase(urls[role]);
}

export async function seedOrg(db: Database, name: string) {
  const orgId = newId();
  const memberId = newId();
  const userId = `user_${memberId}`;
  const email = `${name}@example.com`;
  await withOrg(db, orgId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name, homeCurrency: 'USD' });
    await tx.insert(members).values({
      id: memberId,
      orgId,
      userId,
      email,
      displayName: name,
      role: 'owner',
    });
    await tx.insert(memberSignIns).values({ orgId, memberId, userId, email });
  });
  return { orgId, memberId, userId };
}

/** Drizzle wraps driver errors; check the whole cause chain for the Postgres message. */
export async function expectDbError(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error, 'expected the database to reject the statement').not.toBeNull();
  const messages: string[] = [];
  for (let cur: unknown = error; cur instanceof Error; cur = cur.cause) messages.push(cur.message);
  expect(messages.join('\n')).toMatch(pattern);
}
