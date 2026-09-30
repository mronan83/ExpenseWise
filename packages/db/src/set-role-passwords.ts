import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connectionConfig } from './connection.ts';
import { setRolePasswords } from './role-passwords.ts';

// Runs after migrations in deployed environments (.github/workflows/db-migrate.yml).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  const app = process.env.EXPENSEWISE_APP_DB_PASSWORD;
  const relay = process.env.EXPENSEWISE_RELAY_DB_PASSWORD;
  if (!url || !app || !relay) {
    console.error(
      'Set DATABASE_MIGRATION_URL, EXPENSEWISE_APP_DB_PASSWORD and EXPENSEWISE_RELAY_DB_PASSWORD.',
    );
    process.exit(1);
  }
  const client = new pg.Client(connectionConfig(url));
  await client.connect();
  try {
    await setRolePasswords(client, { expensewise_app: app, expensewise_relay: relay });
    console.log('Runtime role passwords set; neither role can bypass row-level security.');
  } finally {
    await client.end();
  }
}
