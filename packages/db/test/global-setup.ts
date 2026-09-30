import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../src/migrate.ts';

// Test-only credentials for the roles migration 0001 creates as NOLOGIN.
const APP_PASSWORD = 'expensewise-app-test';
const RELAY_PASSWORD = 'expensewise-relay-test';

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
  await runMigrations(ownerUrl);
  await run(ownerUrl, [
    `ALTER ROLE expensewise_app WITH LOGIN PASSWORD '${APP_PASSWORD}'`,
    `ALTER ROLE expensewise_relay WITH LOGIN PASSWORD '${RELAY_PASSWORD}'`,
  ]);

  project.provide('ownerUrl', ownerUrl);
  project.provide('appUrl', withCredentials(ownerUrl, 'expensewise_app', APP_PASSWORD));
  project.provide('relayUrl', withCredentials(ownerUrl, 'expensewise_relay', RELAY_PASSWORD));

  return async () => {
    await run(baseUrl, [`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
  };
}
