import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { connectionConfig, retryWhilePoolerRejectsPassword } from './connection.ts';
import { logConnection } from './migrate.ts';
import { canSignIn, roleConnectionString, setRolePasswords } from './role-passwords.ts';

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
  logConnection(url);
  await retryWhilePoolerRejectsPassword(
    url,
    async () => {
      // A client can't reconnect after a failed connect, so each attempt gets its own.
      const client = new pg.Client(connectionConfig(url));
      try {
        await client.connect();
        await setRolePasswords(
          client,
          { expensewise_app: app, expensewise_relay: relay },
          {
            // Re-setting a working password breaks the role behind Supabase's pooler.
            alreadyWorks: (role, password) =>
              canSignIn(roleConnectionString(url, role, password), console.log),
            log: console.log,
          },
        );
      } finally {
        await client.end().catch(() => undefined);
      }
    },
    { log: console.log },
  );
  console.log('Runtime roles can sign in; neither can bypass row-level security.');
}
