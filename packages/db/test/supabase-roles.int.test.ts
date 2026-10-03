import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { DATA_API_ROLES, lockDownDataApi } from '../src/data-api.ts';
import { connectAs, expectDbError } from './helpers.ts';

// Supabase's Data API (PostgREST) connects as these roles. ExpenseWise serves data only
// through its own API, so they must have no way into our tables or functions (ADR-0013).

const owner = connectAs('owner');
afterAll(() => owner.pool.end());

describe('Supabase Data API roles', () => {
  it('hold no privileges on any table or sequence in public', async () => {
    const { rows } = await owner.db.execute<{
      role: string;
      object: string;
      privilege: string;
    }>(sql`
      select r.role, c.relname as object, p.privilege
        from unnest(${`{${DATA_API_ROLES.join(',')}}`}::text[]) as r(role)
        cross join pg_class c
        join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
        cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p(privilege)
       where c.relkind in ('r', 'S')
         and case c.relkind
               when 'S' then p.privilege = 'SELECT' and has_sequence_privilege(r.role, c.oid, 'USAGE')
               else has_table_privilege(r.role, c.oid, p.privilege)
             end`);
    expect(rows).toEqual([]);
  });

  it('cannot execute our functions', async () => {
    const { rows } = await owner.db.execute<{ role: string; fn: string }>(sql`
      select r.role, p.proname as fn
        from unnest(${`{${DATA_API_ROLES.join(',')}}`}::text[]) as r(role)
        cross join pg_proc p
        join pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
       where has_function_privilege(r.role, p.oid, 'EXECUTE')`);
    expect(rows).toEqual([]);
  });

  it('are refused at query time too', async () => {
    for (const role of DATA_API_ROLES) {
      await expectDbError(
        owner.db.transaction(async (tx) => {
          await tx.execute(sql.raw(`set local role ${role}`));
          await tx.execute(sql`select * from expenses`);
        }),
        /permission denied/,
      );
    }
  });

  it('lose grants that come back without a migration, as after a restore', async () => {
    await owner.db.execute(sql`grant select, truncate on expenses to anon`);
    await owner.db.execute(sql`grant execute on function claim_outbox_batch(integer) to anon`);
    expect(await lockDownDataApi(owner.db)).toBe(2);
    const { rows } = await owner.db.execute<{ table: boolean; fn: boolean }>(sql`
      select has_table_privilege('anon', 'expenses', 'SELECT') as table,
             has_function_privilege('anon', 'claim_outbox_batch(integer)', 'EXECUTE') as fn`);
    expect(rows).toEqual([{ table: false, fn: false }]);
    expect(await lockDownDataApi(owner.db)).toBe(0);
  });
});
