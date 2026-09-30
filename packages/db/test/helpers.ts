import { newId } from '@expensewise/domain';
import { expect, inject } from 'vitest';
import { createDatabase, withOrg, type Database } from '../src/client.ts';
import { members, organizations } from '../src/schema.ts';

export function connectAs(role: 'owner' | 'app' | 'relay') {
  const urls = { owner: inject('ownerUrl'), app: inject('appUrl'), relay: inject('relayUrl') };
  return createDatabase(urls[role]);
}

export async function seedOrg(db: Database, name: string) {
  const orgId = newId();
  const memberId = newId();
  await withOrg(db, orgId, async (tx) => {
    await tx.insert(organizations).values({ id: orgId, name, homeCurrency: 'USD' });
    await tx.insert(members).values({
      id: memberId,
      orgId,
      userId: `user_${memberId}`,
      email: `${name}@example.com`,
      displayName: name,
      role: 'owner',
    });
  });
  return { orgId, memberId };
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
