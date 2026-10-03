import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.ts';
import { describeConnection, retryWhilePoolerRejectsPassword } from './connection.ts';
import { lockDownDataApi } from './data-api.ts';
import { fileMissingReceiptExpenses } from './receipts.ts';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies pending migrations, then the data steps that need application code, such as the
 * hash-chained audit events. Each data step is safe to run on every release. Run as the
 * schema owner, never as expensewise_app. Returns what the data steps did.
 */
export async function runMigrations(
  connectionString: string,
): Promise<{ filedExpenses: number; dataApiObjects: number }> {
  const { db, pool } = createDatabase(connectionString);
  try {
    await migrate(db, { migrationsFolder });
    // Receipts captured before #6 get the expense they prove (ADR-0022).
    const filedExpenses = await fileMissingReceiptExpenses(db);
    // Supabase's Data API roles get nothing, even after a restore has given it back (ADR-0013).
    const dataApiObjects = await lockDownDataApi(db);
    return { filedExpenses, dataApiObjects };
  } finally {
    await pool.end();
  }
}

/** Logs where a CLI is about to connect, without the password. */
export function logConnection(connectionString: string): void {
  const { user, host, port, database, corrections } = describeConnection(connectionString);
  console.log(`Connecting as ${user} to ${host}:${port}/${database}.`);
  for (const correction of corrections) console.log(`Note: ${correction}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Migrations run as the schema owner. Deployed environments keep that connection in
  // DATABASE_MIGRATION_URL so it never reaches the app runtime; locally DATABASE_URL is fine.
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error(
      'Set DATABASE_MIGRATION_URL (or DATABASE_URL locally) to the schema owner connection.',
    );
    process.exit(1);
  }
  logConnection(url);
  const done = await retryWhilePoolerRejectsPassword(url, () => runMigrations(url), {
    log: console.log,
  });
  console.log('Migrations applied.');
  if (done.filedExpenses > 0) {
    console.log(`Filed an expense for ${done.filedExpenses} receipt(s) captured before expenses.`);
  }
  if (done.dataApiObjects > 0) {
    console.log(
      `Took back ${done.dataApiObjects} table(s), sequence(s) and function(s) Supabase's Data API roles could use.`,
    );
  }
}
