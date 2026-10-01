import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { enqueueOutbox } from '../src/outbox.ts';
import { outboxEvents } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const relay = connectAs('relay');
afterAll(async () => {
  await app.pool.end();
  await relay.pool.end();
});

describe('outbox', () => {
  const ids: string[] = [];

  beforeAll(async () => {
    for (const name of ['acme-outbox', 'globex-outbox']) {
      const { orgId } = await seedOrg(app.db, name);
      ids.push(
        await withOrg(app.db, orgId, (tx) =>
          enqueueOutbox(tx, orgId, 'receipt.uploaded', { receiptId: `${name}-r1` }),
        ),
      );
    }
  });

  it('lets the relay claim events across organizations, once', async () => {
    const first = await relay.db.execute<{ id: string; attempts: number }>(
      sql`select id, attempts from claim_outbox_batch(100)`,
    );
    const mine = first.rows.filter((r) => ids.includes(r.id));
    expect(mine.map((r) => r.id).sort()).toEqual([...ids].sort());
    expect(mine.every((r) => r.attempts === 1)).toBe(true);

    const second = await relay.db.execute<{ id: string }>(
      sql`select id from claim_outbox_batch(100)`,
    );
    expect(second.rows.filter((r) => ids.includes(r.id))).toEqual([]);

    const published = await relay.db.execute<{ count: number }>(
      sql`select mark_outbox_published(${`{${ids.join(',')}}`}::uuid[]) as count`,
    );
    expect(published.rows[0]?.count).toBe(2);
  });

  it('keeps the relay away from table data and the app away from the relay functions', async () => {
    await expectDbError(relay.db.select().from(outboxEvents), /permission denied/);
    await expectDbError(
      app.db.execute(sql`select * from claim_outbox_batch(1)`),
      /permission denied/,
    );
  });
});
