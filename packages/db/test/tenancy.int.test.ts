import { newId } from '@expensewise/domain';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRowSecurityApplies, withOrg } from '../src/client.ts';
import { expenses, organizations, trips } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
const owner = connectAs('owner');
afterAll(async () => {
  await app.pool.end();
  await owner.pool.end();
});

const readyExpense = (orgId: string, memberId: string, merchant: string) => ({
  orgId,
  memberId,
  status: 'ready' as const,
  source: 'manual' as const,
  merchant,
  transactionDate: '2026-09-24',
  amountMinor: 650,
  currency: 'USD',
});

describe('tenant isolation, connected as expensewise_app', () => {
  let acme: { orgId: string; memberId: string };
  let globex: { orgId: string; memberId: string };

  beforeAll(async () => {
    acme = await seedOrg(app.db, 'acme');
    globex = await seedOrg(app.db, 'globex');
    await withOrg(app.db, acme.orgId, (tx) =>
      tx.insert(expenses).values(readyExpense(acme.orgId, acme.memberId, 'Blue Bottle')),
    );
    await withOrg(app.db, globex.orgId, (tx) =>
      tx.insert(expenses).values(readyExpense(globex.orgId, globex.memberId, 'Shell')),
    );
  });

  it('sees only its own organization', async () => {
    const rows = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(expenses));
    expect(rows.map((r) => r.merchant)).toEqual(['Blue Bottle']);
    const orgs = await withOrg(app.db, acme.orgId, (tx) => tx.select().from(organizations));
    expect(orgs.map((o) => o.id)).toEqual([acme.orgId]);
  });

  it('sees nothing at all without an organization context', async () => {
    expect(await app.db.select().from(expenses)).toEqual([]);
    expect(await app.db.select().from(organizations)).toEqual([]);
  });

  it('cannot insert rows for another organization', async () => {
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.insert(expenses).values(readyExpense(globex.orgId, globex.memberId, 'Smuggled')),
      ),
      /row-level security policy/,
    );
  });

  it('cannot move its rows into another organization', async () => {
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.update(expenses).set({ orgId: globex.orgId }).where(eq(expenses.orgId, acme.orgId)),
      ),
      /row-level security policy/,
    );
  });

  it("cannot point at another organization's rows through a foreign key", async () => {
    const globexTrip = newId();
    await withOrg(app.db, globex.orgId, (tx) =>
      tx.insert(trips).values({
        id: globexTrip,
        orgId: globex.orgId,
        memberId: globex.memberId,
        name: 'Houston',
        startDate: '2026-09-22',
        endDate: '2026-09-25',
      }),
    );
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx
          .insert(expenses)
          .values({ ...readyExpense(acme.orgId, acme.memberId, 'Hotel'), tripId: globexTrip }),
      ),
      /expenses_trip_fk/,
    );
  });

  it('refuses a Ready expense with no amount', async () => {
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx
          .insert(expenses)
          .values({ ...readyExpense(acme.orgId, acme.memberId, 'X'), amountMinor: null }),
      ),
      /expenses_complete_when_ready/,
    );
  });

  it('refuses a converted amount without its rate provenance', async () => {
    await expectDbError(
      withOrg(app.db, acme.orgId, (tx) =>
        tx.insert(expenses).values({
          ...readyExpense(acme.orgId, acme.memberId, 'Tokyo taxi'),
          homeAmountMinor: 816,
          fxRate: '0.0068',
        }),
      ),
      /expenses_fx_complete/,
    );
  });
});

describe('policy coverage', () => {
  it('puts a forced tenant policy on every table that holds org data', async () => {
    const { rows } = await owner.db.execute<{
      table: string;
      rls: boolean;
      forced: boolean;
      policies: number;
    }>(sql`
      select c.relname as "table",
             c.relrowsecurity as rls,
             c.relforcerowsecurity as forced,
             (select count(*)::int from pg_policies p
               where p.schemaname = 'public' and p.tablename = c.relname) as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and (c.relname = 'organizations' or exists (
               select 1 from information_schema.columns col
                where col.table_schema = 'public' and col.table_name = c.relname
                  and col.column_name = 'org_id'))
       order by 1`);

    expect(rows.length).toBeGreaterThanOrEqual(12);
    for (const row of rows) {
      expect(row.rls, `${row.table} has RLS enabled`).toBe(true);
      expect(row.policies, `${row.table} has a policy`).toBeGreaterThan(0);
      // The outbox is the one deliberate exception; see migration 0001.
      expect(row.forced, `${row.table} forces RLS`).toBe(row.table !== 'outbox_events');
    }
  });
});

describe('runtime role guard', () => {
  it('accepts expensewise_app, which row-level security applies to', async () => {
    await expect(assertRowSecurityApplies(app.db)).resolves.toBeUndefined();
  });

  it('refuses a role that bypasses row-level security', async () => {
    await expect(assertRowSecurityApplies(owner.db)).rejects.toThrow(/bypasses row-level security/);
  });

  it('gives the application role statement and idle-transaction timeouts', async () => {
    const timeout = await app.db.execute<{ statement_timeout: string }>(
      sql`show statement_timeout`,
    );
    const idle = await app.db.execute<{ idle_in_transaction_session_timeout: string }>(
      sql`show idle_in_transaction_session_timeout`,
    );
    expect(timeout.rows[0]?.statement_timeout).toBe('15s');
    expect(idle.rows[0]?.idle_in_transaction_session_timeout).toBe('30s');
  });
});
