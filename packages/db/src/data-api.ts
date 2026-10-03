import { sql } from 'drizzle-orm';
import type { Database } from './client.ts';

/** The roles Supabase's Data API (PostgREST) connects as. ExpenseWise never uses it (ADR-0013). */
export const DATA_API_ROLES = ['anon', 'authenticated', 'service_role'] as const;

const ROLES = `{${DATA_API_ROLES.join(',')}}`;

/** How many tables, sequences and functions in public each Data API role can use. */
async function heldByDataApi(db: Database): Promise<number> {
  const { rows } = await db.execute<{ n: string }>(sql`
    select count(distinct (g.grantee, g.object)) as n from (
      select (aclexplode(c.relacl)).grantee, c.oid as object
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relacl is not null
      union all
      select (aclexplode(p.proacl)).grantee, p.oid
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proacl is not null
    ) g
    join pg_roles r on r.oid = g.grantee
   where r.rolname = any(${ROLES}::text[])`);
  return Number(rows[0]!.n);
}

/**
 * Takes back everything Supabase's Data API roles hold in public, and the default privileges
 * that would hand them new objects. Migration 0002 did this once; it runs on every release,
 * because grants can come back without a migration. A restore brings them back: the dump
 * records only the grants each object holds, so as a new project recreates each table, its
 * default privileges give these roles everything again. Returns how many tables, sequences
 * and functions they could use before. On plain Postgres the roles don't exist and this does
 * nothing.
 */
export async function lockDownDataApi(db: Database): Promise<number> {
  const held = await heldByDataApi(db);
  // A DO block takes no parameters; the roles are constants.
  await db.execute(
    sql.raw(`
    DO $$
    DECLARE
      data_api_role text;
    BEGIN
      FOREACH data_api_role IN ARRAY '${ROLES}'::text[] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = data_api_role) THEN
          EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', data_api_role);
          EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', data_api_role);
          EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', data_api_role);
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', data_api_role);
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', data_api_role);
          EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', data_api_role);
        END IF;
      END LOOP;
    END
    $$`),
  );
  return held;
}
