import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { createDatabase, withOrg } from '../src/client.ts';
import { migrationsFolder } from '../src/migrate.ts';
import {
  bringForward,
  checkIsolation,
  checkMigrations,
  checkRowCounts,
  checkRowSecurity,
  checkSchema,
  repositoryMigrations,
  type DumpManifest,
} from '../src/restore-drill.ts';
import type { SchemaSnapshot } from '../src/schema-snapshot.ts';
import { expenses } from '../src/schema.ts';
import { run, SUPABASE_DEFAULTS, withDatabase } from './global-setup.ts';
import { seedOrg } from './helpers.ts';

/*
 * The drill's checks, on a database of their own: a restore of a dump taken one migration
 * ago, then each way the drill should fail. The shared test database can't be used, because
 * other files write to it while these count rows.
 */
const name = `restore_drill_${randomBytes(4).toString('hex')}`;
const ownerUrl = withDatabase(inject('ownerUrl'), name);
const appUrl = withDatabase(inject('appUrl'), name);
const expected = JSON.parse(
  readFileSync(fileURLToPath(new URL('../schema.json', import.meta.url)), 'utf8'),
) as SchemaSnapshot;
const migrations = repositoryMigrations();

const owner = new pg.Client({ connectionString: ownerUrl });
const app = createDatabase(appUrl);

const manifest = (overrides: Partial<DumpManifest> = {}): DumpManifest => ({
  date: '2026-10-03',
  dumpedAt: '2026-10-03T09:20:00Z',
  databaseBytes: 1,
  migrations: { applied: migrations.length - 1, latest: null },
  rows: {},
  sha256: {},
  ...overrides,
});

const counts = async () => {
  const { rows } = await owner.query<{ name: string }>(
    `select n.nspname || '.' || c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname in ('public', 'ops', 'drizzle') and c.relkind = 'r'`,
  );
  const out: Record<string, number> = {};
  for (const { name: table } of rows) {
    const [schema, rel] = table.split('.');
    out[table] = Number(
      (await owner.query<{ n: string }>(`select count(*) as n from "${schema}"."${rel}"`)).rows[0]!
        .n,
    );
  }
  return out;
};

beforeAll(async () => {
  await run(inject('ownerUrl'), [`CREATE DATABASE ${name}`]);
  await run(ownerUrl, SUPABASE_DEFAULTS);
  // The dump was taken before this commit's latest migration.
  const older = mkdtempSync(join(tmpdir(), 'migrations-'));
  try {
    cpSync(migrationsFolder, older, { recursive: true });
    const journalPath = join(older, 'meta/_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, -1);
    writeFileSync(journalPath, JSON.stringify(journal));
    const { db, pool } = createDatabase(ownerUrl);
    try {
      await migrate(db, { migrationsFolder: older });
    } finally {
      await pool.end();
    }
  } finally {
    rmSync(older, { recursive: true, force: true });
  }
  await owner.connect();
});

afterAll(async () => {
  await owner.end();
  await app.pool.end();
  await run(inject('ownerUrl'), [`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
});

describe('restore drill', () => {
  it('finds the restored migrations are this commit’s first ones, then brings them forward', async () => {
    const found = await checkMigrations(owner, manifest());
    expect(found).toMatchObject({ ok: true });
    expect(found.detail).toContain(
      `${migrations.length - 1} of this commit's ${migrations.length}`,
    );

    const forward = await bringForward(ownerUrl, migrations.length - 1);
    expect(forward).toEqual({
      check: 'Brought forward',
      ok: true,
      detail: '1 newer migration applied to the restored data',
    });
    expect(await checkSchema(owner, expected)).toMatchObject({ ok: true });
    expect(await checkRowSecurity(owner)).toMatchObject({ ok: true });
  });

  describe('with two organizations restored', () => {
    beforeAll(async () => {
      for (const org of ['acme', 'globex']) {
        const { orgId, memberId } = await seedOrg(app.db, org);
        await withOrg(app.db, orgId, (tx) =>
          tx.insert(expenses).values({
            orgId,
            memberId,
            status: 'ready',
            source: 'manual',
            merchant: org,
            transactionDate: '2026-09-24',
            amountMinor: 650,
            currency: 'USD',
          }),
        );
      }
    });

    it('matches row counts, leaving out the tables Supabase keeps for itself', async () => {
      const rows = { ...(await counts()), 'auth.schema_migrations': 82 };
      expect(await checkRowCounts(owner, manifest({ rows }))).toMatchObject({ ok: true });

      const short = await checkRowCounts(
        owner,
        manifest({ rows: { ...rows, 'public.expenses': 3, 'public.gone': 1 } }),
      );
      expect(short.ok).toBe(false);
      expect(short.detail).toContain('public.expenses has 2, the dump had 3');
      expect(short.detail).toContain('public.gone is missing');
    });

    it('finds each organization sees only its own rows', async () => {
      const result = await checkIsolation(owner, appUrl);
      expect(result).toMatchObject({ ok: true });
      expect(result.detail).toContain('2 organizations');
    });

    it('fails when a policy lets rows leak', async () => {
      await owner.query('create policy drill_leak on expenses for select using (true)');
      try {
        const result = await checkIsolation(owner, appUrl);
        expect(result.ok).toBe(false);
        expect(result.detail).toContain('expenses shows 2 rows with no organization chosen');
        expect(result.detail).toContain('expenses shows one organization 1 rows of another');
        expect(await checkSchema(owner, expected)).toMatchObject({
          ok: false,
          detail: 'table expenses differs',
        });
      } finally {
        await owner.query('drop policy drill_leak on expenses');
      }
    });

    it('fails when row-level security is off for a table', async () => {
      await owner.query('alter table trips disable row level security');
      try {
        expect(await checkRowSecurity(owner)).toEqual({
          check: 'Row-level security',
          ok: false,
          detail: 'off for trips',
        });
      } finally {
        await owner.query('alter table trips enable row level security');
      }
    });

    it('fails when a migration was edited after production applied it', async () => {
      const first = migrations[0]!;
      await owner.query('update drizzle.__drizzle_migrations set hash = $1 where hash = $2', [
        '0'.repeat(64),
        first.hash,
      ]);
      try {
        const result = await checkMigrations(
          owner,
          manifest({ migrations: { applied: migrations.length, latest: null } }),
        );
        expect(result).toMatchObject({
          ok: false,
          detail: `${first.tag} differs from the file production applied`,
        });
      } finally {
        await owner.query('update drizzle.__drizzle_migrations set hash = $1 where hash = $2', [
          first.hash,
          '0'.repeat(64),
        ]);
      }
    });
  });
});
