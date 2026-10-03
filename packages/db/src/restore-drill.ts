import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import pg from 'pg';
import { connectionConfig } from './connection.ts';
import { migrationsFolder, runMigrations } from './migrate.ts';
import { snapshotSchema, type SchemaSnapshot } from './schema-snapshot.ts';

/*
 * The database half of the monthly restore drill (ADR-0014; scripts/backup/restore-drill.sh).
 * Each check reads a database restored from the nightly backup and says what it found in
 * counts and table names only, never data: the drill's logs are public.
 */

/** What the nightly backup records next to each dump (scripts/backup/backup.sh). */
export interface DumpManifest {
  readonly date: string;
  readonly dumpedAt: string;
  readonly databaseBytes: number;
  readonly serverVersion?: string;
  readonly migrations: { readonly applied: number; readonly latest: number | string | null };
  readonly rows: Readonly<Record<string, number>>;
  readonly sha256: Readonly<Record<string, string>>;
}

export interface DrillCheck {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: string;
}

/**
 * Tables whose rows Supabase's dump leaves out on purpose. Each holds a platform service's own
 * migration history, which a new project writes for itself, so its count there differs from
 * production's without anything being lost.
 */
export const PLATFORM_MANAGED_TABLES = [
  'auth.schema_migrations',
  'storage.migrations',
  'supabase_functions.migrations',
] as const;

const qualified = (client: pg.ClientBase, name: string) => {
  const [schema, table] = name.includes('.') ? name.split('.', 2) : ['public', name];
  return `${client.escapeIdentifier(schema!)}.${client.escapeIdentifier(table!)}`;
};

const count = async (client: pg.ClientBase, table: string, where = '', values: unknown[] = []) =>
  Number(
    (
      await client.query<{ n: string }>(
        `select count(*) as n from ${qualified(client, table)} ${where}`,
        values,
      )
    ).rows[0]!.n,
  );

const listed = (items: readonly string[], max = 6) =>
  items.length <= max
    ? items.join('; ')
    : `${items.slice(0, max).join('; ')}; and ${items.length - max} more`;

/** Every table's row count equals the count the backup recorded when it dumped. */
export async function checkRowCounts(
  client: pg.ClientBase,
  manifest: DumpManifest,
): Promise<DrillCheck> {
  const skip = new Set<string>(PLATFORM_MANAGED_TABLES);
  const tables = Object.keys(manifest.rows)
    .filter((t) => !skip.has(t))
    .sort();
  const differ: string[] = [];
  for (const table of tables) {
    const exists = (
      await client.query<{ r: string | null }>('select to_regclass($1) as r', [table])
    ).rows[0]!.r;
    if (!exists) {
      differ.push(`${table} is missing`);
      continue;
    }
    const restored = await count(client, table);
    const recorded = manifest.rows[table]!;
    if (restored !== recorded) differ.push(`${table} has ${restored}, the dump had ${recorded}`);
  }
  const rows = tables.reduce((n, t) => n + manifest.rows[t]!, 0);
  return {
    check: 'Row counts',
    ok: differ.length === 0,
    detail:
      differ.length === 0
        ? `all ${tables.length} tables match the dump (${rows} rows)`
        : `${differ.length} of ${tables.length} tables differ: ${listed(differ)}`,
  };
}

interface AppliedMigration {
  readonly hash: string;
  readonly createdAt: number;
}

/** This commit's migrations, oldest first, with the tag each file is named by. */
export function repositoryMigrations(): { tag: string; hash: string; folderMillis: number }[] {
  const journal = JSON.parse(
    readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
  ) as {
    entries: { tag: string }[];
  };
  return readMigrationFiles({ migrationsFolder }).map((m, i) => ({
    tag: journal.entries[i]!.tag,
    hash: m.hash,
    folderMillis: m.folderMillis,
  }));
}

/**
 * The migrations the restored database records are this commit's first ones, file for file:
 * none of them has been edited since production applied it.
 */
export async function checkMigrations(
  client: pg.ClientBase,
  manifest: DumpManifest,
): Promise<DrillCheck> {
  const applied: AppliedMigration[] = (
    await client.query<{ hash: string; created_at: string }>(
      'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
    )
  ).rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));
  const repo = repositoryMigrations();
  const problems: string[] = [];
  if (applied.length !== manifest.migrations.applied) {
    problems.push(
      `the dump recorded ${manifest.migrations.applied}, the restore has ${applied.length}`,
    );
  }
  if (applied.length > repo.length) {
    problems.push(`${applied.length - repo.length} applied migrations are not in this commit`);
  }
  applied.slice(0, repo.length).forEach((m, i) => {
    const file = repo[i]!;
    if (m.hash !== file.hash || m.createdAt !== file.folderMillis) {
      problems.push(`${file.tag} differs from the file production applied`);
    }
  });
  return {
    check: 'Migrations',
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `${applied.length} of this commit's ${repo.length} were applied when the dump was taken, each matching its file`
        : listed(problems),
  };
}

/** Applies this commit's newer migrations, as the Release run would after a real restore. */
export async function bringForward(ownerUrl: string, appliedBefore: number): Promise<DrillCheck> {
  const pending = repositoryMigrations().length - appliedBefore;
  try {
    const { dataApiObjects } = await runMigrations(ownerUrl);
    const migrated =
      pending > 0
        ? `${pending} newer migration${pending === 1 ? '' : 's'} applied to the restored data`
        : 'already at this commit’s migrations';
    // Expected after every restore into a new project (lockDownDataApi), so not a failure.
    const lockedDown =
      dataApiObjects > 0
        ? `; took back ${dataApiObjects} tables, sequences and functions the restore gave Supabase's Data API roles, as the release does`
        : '';
    return { check: 'Brought forward', ok: true, detail: `${migrated}${lockedDown}` };
  } catch (error) {
    return {
      check: 'Brought forward',
      ok: false,
      detail: `a newer migration failed on the restored data: ${(error as Error).message.split('\n')[0]}`,
    };
  }
}

/** The restored schema, once brought forward, is the one the migrations build (schema.json). */
export async function checkSchema(
  client: pg.ClientBase,
  expected: SchemaSnapshot,
): Promise<DrillCheck> {
  const actual = await snapshotSchema(client);
  const differ: string[] = [];
  const compare = <T extends { name: string }>(kind: string, a: readonly T[], b: readonly T[]) => {
    const want = new Map(b.map((x) => [x.name, JSON.stringify(x)]));
    const have = new Map(a.map((x) => [x.name, JSON.stringify(x)]));
    for (const [name, json] of want) {
      if (!have.has(name)) differ.push(`${kind} ${name} is missing`);
      else if (have.get(name) !== json) differ.push(`${kind} ${name} differs`);
    }
    for (const name of have.keys()) if (!want.has(name)) differ.push(`${kind} ${name} is extra`);
  };
  compare('table', actual.tables, expected.tables);
  compare('view', actual.views, expected.views);
  compare('enum', actual.enums, expected.enums);
  compare('function', actual.functions, expected.functions);
  compare('role', actual.roles, expected.roles);
  return {
    check: 'Schema',
    ok: differ.length === 0,
    detail:
      differ.length === 0
        ? `matches packages/db/schema.json: ${actual.tables.length} tables, ${actual.functions.length} functions, row-level security and grants included`
        : listed(differ),
  };
}

/** The tables row-level security scopes to one organization: those with org_id, and organizations. */
async function tenantTables(client: pg.ClientBase): Promise<{ table: string; key: string }[]> {
  const { rows } = await client.query<{ table: string; key: string }>(
    `select c.relname as table, case when c.relname = 'organizations' then 'id' else 'org_id' end as key
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and (c.relname = 'organizations'
             or exists (select 1 from pg_attribute a
                         where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped))
      order by 1`,
  );
  return rows;
}

/** Row-level security is on for every table in public. */
export async function checkRowSecurity(client: pg.ClientBase): Promise<DrillCheck> {
  const { rows } = await client.query<{ table: string }>(
    `select c.relname as table
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity
      order by 1`,
  );
  const total = await client.query<{ n: string }>(
    `select count(*) as n from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')`,
  );
  return {
    check: 'Row-level security',
    ok: rows.length === 0,
    detail:
      rows.length === 0
        ? `on for all ${total.rows[0]!.n} tables in public`
        : `off for ${listed(rows.map((r) => r.table))}`,
  };
}

/**
 * Signed in as expensewise_app, each organization sees exactly its own rows, every row
 * belongs to an organization that can see it, and nothing is visible without one.
 */
export async function checkIsolation(owner: pg.ClientBase, appUrl: string): Promise<DrillCheck> {
  const tenant = await tenantTables(owner);
  const orgs = (await owner.query<{ id: string }>('select id from public.organizations')).rows;
  const app = new pg.Client(connectionConfig(appUrl));
  await app.connect();
  const problems: string[] = [];
  try {
    const role = (
      await app.query<{ superuser: boolean; bypass: boolean }>(
        `select rolsuper as superuser, rolbypassrls as bypass from pg_roles where rolname = current_user`,
      )
    ).rows[0];
    if (!role || role.superuser || role.bypass) {
      return {
        check: 'Isolation',
        ok: false,
        detail: 'expensewise_app bypasses row-level security',
      };
    }

    const readable = (
      await owner.query<{ table: string }>(
        `select c.relname as table from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')
            and has_table_privilege('expensewise_app', c.oid, 'SELECT')
          order by 1`,
      )
    ).rows.map((r) => r.table);
    for (const table of readable) {
      const seen = await count(app, table);
      if (seen > 0) problems.push(`${table} shows ${seen} rows with no organization chosen`);
    }
    // A tenant table the app can't read has nothing to leak.
    const tables = tenant.filter((t) => readable.includes(t.table));

    const seenTotal = new Map<string, number>();
    for (const { id } of orgs) {
      await app.query('begin');
      try {
        await app.query(`select set_config('app.org_id', $1, true)`, [id]);
        for (const { table, key } of tables) {
          const { rows } = await app.query<{ n: string; foreign: string }>(
            `select count(*) as n, count(*) filter (where ${app.escapeIdentifier(key)} <> $1) as foreign
               from ${qualified(app, table)}`,
            [id],
          );
          const foreign = Number(rows[0]!.foreign);
          if (foreign > 0)
            problems.push(`${table} shows one organization ${foreign} rows of another`);
          seenTotal.set(table, (seenTotal.get(table) ?? 0) + Number(rows[0]!.n));
        }
      } finally {
        await app.query('rollback');
      }
    }
    for (const { table } of tables) {
      const total = await count(owner, table);
      const seen = seenTotal.get(table) ?? 0;
      if (seen !== total) {
        problems.push(`${table} has ${total} rows, but its organizations see ${seen}`);
      }
    }
  } finally {
    await app.end();
  }
  return {
    check: 'Isolation',
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `signed in as expensewise_app: ${tenant.length} tables, ${orgs.length} organization${orgs.length === 1 ? '' : 's'}, each sees only its own rows and nothing shows without one`
        : listed(problems),
  };
}
