import { isUuid } from '@expensewise/domain';
import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.ts';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function createDatabase(connectionString: string): { db: Database; pool: pg.Pool } {
  const pool = new pg.Pool({ connectionString });
  return { db: drizzle(pool, { schema }), pool };
}

/**
 * Runs `work` in a transaction bound to one organization. Row-level security reads
 * `app.org_id`, so every query inside sees and writes only that organization's rows.
 * The setting is transaction-local and cannot leak to the next user of the connection.
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
