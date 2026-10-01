import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/migrate.ts';
import { setRolePasswords } from '../src/role-passwords.ts';

// Test-only credentials for the roles migration 0001 creates as NOLOGIN.
const APP_PASSWORD = 'expensewise-app-test-password';
const RELAY_PASSWORD = 'expensewise-relay-test-password';

declare module 'vitest' {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
    relayUrl: string;
  }
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

async function run(connectionString: string, statements: string[]): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    for (const statement of statements) await client.query(statement);
  } finally {
    await client.end();
  }
}

/** Creates a throwaway database, migrates it, and hands each role's URL to the tests. */
export default async function setup(project: TestProject) {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) {
    throw new Error(
      'Integration tests need DATABASE_URL (a Postgres superuser connection). ' +
        'Run `pnpm db:up` and export the URL it prints.',
    );
  }
  const database = `expensewise_test_${randomBytes(4).toString('hex')}`;
  await run(baseUrl, [`CREATE DATABASE ${database}`]);

  const ownerUrl = withDatabase(baseUrl, database);
  // Recreate what Supabase does before we ever migrate: Data API roles, with default
  // privileges that hand them every new table in public. Migration 0002 must undo this.
  await run(ownerUrl, [
    `DO $$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
     END $$`,
    'GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role',
    'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role',
  ]);
  await runMigrations(ownerUrl);
  // The same path deployed environments use: SCRAM verifiers, never plain passwords.
  const owner = new pg.Client({ connectionString: ownerUrl });
  await owner.connect();
  try {
    await setRolePasswords(owner, {
      expensewise_app: APP_PASSWORD,
      expensewise_relay: RELAY_PASSWORD,
    });
  } finally {
    await owner.end();
  }

  project.provide('ownerUrl', ownerUrl);
  project.provide('appUrl', withCredentials(ownerUrl, 'expensewise_app', APP_PASSWORD));
  project.provide('relayUrl', withCredentials(ownerUrl, 'expensewise_relay', RELAY_PASSWORD));

  return async () => {
    await run(baseUrl, [`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
  };
}
