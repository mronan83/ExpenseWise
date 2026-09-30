import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDatabase } from './client.ts';

export const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/** Applies pending migrations. Run as the schema owner, never as expensewise_app. */
export async function runMigrations(connectionString: string): Promise<void> {
  const { db, pool } = createDatabase(connectionString);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await pool.end();
  }
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
  await runMigrations(url);
  console.log('Migrations applied.');
}
