/**
 * Writes schema.json, the schema the migrations build, for the data model page:
 *
 *   pnpm db:snapshot
 *
 * Builds a throwaway database exactly as the integration tests do (Supabase's roles first,
 * then every migration), reads its catalog and drops it. Needs DATABASE_URL, a Postgres
 * superuser connection, as the integration tests do.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { snapshotJson, snapshotSchema } from '../src/schema-snapshot.ts';
import setup from '../test/global-setup.ts';

const out = fileURLToPath(new URL('../schema.json', import.meta.url));
const provided: Record<string, string> = {};
const teardown = await setup({
  provide: (key: string, value: string) => {
    provided[key] = value;
  },
} as unknown as TestProject);
try {
  const client = new pg.Client({ connectionString: provided.ownerUrl });
  await client.connect();
  try {
    writeFileSync(out, snapshotJson(await snapshotSchema(client)));
  } finally {
    await client.end();
  }
  console.log(`Wrote ${out}.`);
} finally {
  await teardown();
}
