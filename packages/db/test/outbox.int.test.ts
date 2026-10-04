import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { claimOutboxBatch, enqueueOutbox, markOutboxPublished } from '../src/outbox.ts';
import { outboxEvents } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const relay = connectAs('relay');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await relay.pool.end();
  await owner.pool.end();
});

/**
 * Claims batch after batch until the relay holds every one of these events, as the relay does
 * over successive runs. The other test files share this database and enqueue events no relay
 * claims, so more than one batch of older events can stand ahead of these.
 */
async function claimUntilHeld(wanted: readonly string[]) {
  const held: Awaited<ReturnType<typeof claimOutboxBatch>> = [];
  for (;;) {
    const batch = await claimOutboxBatch(relay.db, 100);
    held.push(...batch.filter((e) => wanted.includes(e.id)));
    if (held.length === wanted.length || batch.length === 0) return held;
  }
}

describe('outbox', () => {
  const ids: string[] = [];
  const orgs: string[] = [];

  beforeAll(async () => {
    for (const name of ['acme-outbox', 'globex-outbox']) {
      const { orgId } = await seedOrg(app.db, name);
      orgs.push(orgId);
      ids.push(
        await withOrg(app.db, orgId, (tx) =>
          enqueueOutbox(tx, orgId, 'receipt.uploaded', { receiptId: `${name}-r1` }),
        ),
      );
    }
  });

  it('lets the relay claim events across organizations, once, then mark them published', async () => {
    const first = await claimUntilHeld(ids);
    expect(first.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(first.every((e) => e.attempts === 1)).toBe(true);
    expect(first.map((e) => e.orgId).sort()).toEqual([...orgs].sort());
    expect(first.map((e) => e.topic)).toEqual(['receipt.uploaded', 'receipt.uploaded']);
    expect(first.map((e) => e.payload.receiptId).sort()).toEqual([
      'acme-outbox-r1',
      'globex-outbox-r1',
    ]);
    expect(first.every((e) => !Number.isNaN(Date.parse(e.createdAt)))).toBe(true);

    const second = await claimOutboxBatch(relay.db, 100);
    expect(second.filter((e) => ids.includes(e.id))).toEqual([]);

    expect(await markOutboxPublished(relay.db, ids)).toBe(2);
    expect(await markOutboxPublished(relay.db, ids)).toBe(0);
    expect(await markOutboxPublished(relay.db, [])).toBe(0);
  });

  it('claims an unpublished event again once its claim has expired', async () => {
    const { orgId } = await seedOrg(app.db, 'initech-outbox');
    const id = await withOrg(app.db, orgId, (tx) =>
      enqueueOutbox(tx, orgId, 'receipt.uploaded', { receiptId: 'initech-r1' }),
    );
    expect((await claimUntilHeld([id])).map((e) => e.id)).toEqual([id]);

    // A relay that crashed after claiming: age the claim past its 5-minute lease.
    await owner.db.execute(
      sql`update outbox_events set claimed_at = now() - interval '6 minutes' where id = ${id}`,
    );
    const [reclaimed] = await claimUntilHeld([id]);
    expect(reclaimed?.attempts).toBe(2);
    expect(await markOutboxPublished(relay.db, [id])).toBe(1);
  });

  it('keeps the relay away from table data and the app away from the relay functions', async () => {
    await expectDbError(relay.db.select().from(outboxEvents), /permission denied/);
    await expectDbError(
      app.db.execute(sql`select * from claim_outbox_batch(1)`),
      /permission denied/,
    );
  });
});
