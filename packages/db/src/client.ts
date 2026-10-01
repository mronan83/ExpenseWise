import { isUuid } from '@expensewise/domain';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { connectionConfig } from './connection.ts';
import * as schema from './schema.ts';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseOptions {
  /**
   * Connections per process. Serverless functions behind Supabase's transaction pooler
   * should use 1–3; the pg default of 10 per instance exhausts the pooler quickly.
   */
  readonly max?: number;
  /** TLS override. Supabase hosts get verified TLS automatically (see connectionConfig). */
  readonly ssl?: pg.PoolConfig['ssl'];
}

export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({
    ...connectionConfig(connectionString),
    max: options.max,
    ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
  });
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * Refuses to serve tenant data as a role that ignores row-level security. On Supabase the
 * `postgres` role has BYPASSRLS, so a runtime pointed at it would silently switch tenant
 * isolation off. Call once at startup; the API must connect as expensewise_app (ADR-0013).
 */
export async function assertRowSecurityApplies(db: Database): Promise<void> {
  const { rows } = await db.execute<{ role: string; superuser: boolean; bypass: boolean }>(sql`
    select current_user as role, rolsuper as superuser, rolbypassrls as bypass
      from pg_roles where rolname = current_user`);
  const role = rows[0];
  if (!role || role.superuser || role.bypass) {
    throw new Error(
      `Refusing to serve tenant data as "${role?.role ?? 'unknown'}": this role bypasses ` +
        'row-level security. Connect as expensewise_app.',
    );
  }
}

/**
 * Runs `work` in a transaction bound to one organization. Row-level security reads
 * `app.org_id`, so every query inside sees and writes only that organization's rows.
 * The setting is transaction-local, which is also what makes it safe behind a
 * transaction-mode connection pooler.
 */
export async function withOrg<T>(
  db: Database,
  orgId: string,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!isUuid(orgId)) throw new Error(`withOrg needs an organization UUID, got "${orgId}"`);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return work(tx);
  });
}
