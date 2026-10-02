import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { connectAs, expectDbError } from './helpers.ts';

// The nightly backup writes a heartbeat so the Free plan never pauses the project
// (ADR-0014). It runs as the schema owner; nothing else may reach the ops schema.
const OUTSIDERS = ['expensewise_app', 'expensewise_relay', 'anon', 'authenticated', 'service_role'];

const owner = connectAs('owner');
const app = connectAs('app');
afterAll(() => Promise.all([owner.pool.end(), app.pool.end()]));

const beat = sql`
  insert into ops.heartbeat (id, beat_at, source) values (1, now(), 'test')
  on conflict (id) do update set beat_at = excluded.beat_at, source = excluded.source`;

describe('heartbeat', () => {
  it('takes the nightly write as one row, however often it runs', async () => {
    await owner.db.execute(beat);
    await owner.db.execute(beat);
    const { rows } = await owner.db.execute<{ n: number }>(
      sql`select count(*)::int as n from ops.heartbeat`,
    );
    expect(rows[0]?.n).toBe(1);
    await expectDbError(
      owner.db.execute(sql`insert into ops.heartbeat (id, beat_at, source) values (2, now(), 'x')`),
      /check constraint/,
    );
  });

  it('is out of reach of the app, the relay and the Data API roles', async () => {
    const { rows } = await owner.db.execute<{ role: string }>(sql`
      select r.role
        from unnest(${`{${OUTSIDERS.join(',')}}`}::text[]) as r(role)
        join pg_roles pr on pr.rolname = r.role
       where has_schema_privilege(r.role, 'ops', 'USAGE')
          or has_table_privilege(r.role, 'ops.heartbeat', 'SELECT')
          or has_table_privilege(r.role, 'ops.heartbeat', 'INSERT')`);
    expect(rows).toEqual([]);
    await expectDbError(app.db.execute(sql`select * from ops.heartbeat`), /permission denied/);
  });
});
