import { readFileSync } from 'node:fs';
import pg from 'pg';
import { expect, inject, it } from 'vitest';
import { snapshotJson, snapshotSchema } from '../src/schema-snapshot.ts';

it('is what packages/db/schema.json says, so the data model page is current', async () => {
  const client = new pg.Client({ connectionString: inject('ownerUrl') });
  await client.connect();
  try {
    const built = snapshotJson(await snapshotSchema(client));
    const committed = readFileSync(new URL('../schema.json', import.meta.url), 'utf8');
    expect(
      built,
      'The migrations changed the schema: run `pnpm db:snapshot` and commit schema.json.',
    ).toBe(committed);
  } finally {
    await client.end();
  }
});
