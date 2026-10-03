import type pg from 'pg';

/**
 * The schema the migrations build, read from Postgres's own catalog: what the database
 * enforces, including what Drizzle doesn't model (row-level security, grants, functions).
 * Committed as packages/db/schema.json and checked against a freshly migrated database in
 * the integration tests, so the data model page is never older than the migrations.
 */
export interface SchemaSnapshot {
  readonly tables: readonly TableSnapshot[];
  readonly views: readonly { readonly name: string; readonly definition: string }[];
  readonly enums: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly functions: readonly FunctionSnapshot[];
  readonly roles: readonly RoleSnapshot[];
}

export interface TableSnapshot {
  readonly name: string;
  readonly rls: { readonly enabled: boolean; readonly forced: boolean };
  readonly columns: readonly ColumnSnapshot[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly ForeignKeySnapshot[];
  readonly uniques: readonly { readonly name: string; readonly columns: readonly string[] }[];
  readonly checks: readonly { readonly name: string; readonly definition: string }[];
  readonly indexes: readonly { readonly name: string; readonly definition: string }[];
  readonly policies: readonly PolicySnapshot[];
  readonly triggers: readonly { readonly name: string; readonly definition: string }[];
  /** Table privileges by role, for the roles that matter here. */
  readonly grants: Readonly<Record<string, readonly string[]>>;
}

export interface ColumnSnapshot {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default: string | null;
}

export interface ForeignKeySnapshot {
  readonly name: string;
  readonly columns: readonly string[];
  readonly table: string;
  readonly references: readonly string[];
}

export interface PolicySnapshot {
  readonly name: string;
  readonly command: string;
  readonly permissive: boolean;
  readonly roles: readonly string[];
  readonly using: string | null;
  readonly check: string | null;
}

export interface FunctionSnapshot {
  readonly name: string;
  readonly arguments: string;
  readonly returns: string;
  readonly security: 'definer' | 'invoker';
  readonly volatility: 'immutable' | 'stable' | 'volatile';
  readonly executableBy: readonly string[];
}

export interface RoleSnapshot {
  readonly name: string;
  readonly superuser: boolean;
  readonly bypassRls: boolean;
}

/** The roles whose rights the page shows: ours, and the ones Supabase creates. */
export const SNAPSHOT_ROLES = [
  'expensewise_app',
  'expensewise_relay',
  'anon',
  'authenticated',
  'service_role',
] as const;

const VOLATILITY = { i: 'immutable', s: 'stable', v: 'volatile' } as const;

/** Our schemas: `public` for the app, `ops` for what only the schema owner touches. */
export const SNAPSHOT_SCHEMAS = ['public', 'ops'] as const;
const SCHEMAS = [...SNAPSHOT_SCHEMAS];

/** A relation's name, qualified by its schema outside `public`. */
const QUALIFIED = (rel: string, ns = 'n') =>
  `(case when ${ns}.nspname = 'public' then '' else ${ns}.nspname || '.' end) || ${rel}.relname`;

/** Reads the public schema. Needs a connection that can see every table and role. */
export async function snapshotSchema(client: pg.ClientBase): Promise<SchemaSnapshot> {
  const q = async <T>(text: string, values: unknown[] = []) =>
    (await client.query(text, values)).rows as T[];

  const roles = (
    await q<{ rolname: string }>('select rolname from pg_roles where rolname = any($1)', [
      [...SNAPSHOT_ROLES],
    ])
  )
    .map((r) => r.rolname)
    .sort();

  const tables = await q<{ name: string; enabled: boolean; forced: boolean }>(
    `select ${QUALIFIED('c')} as name, c.relrowsecurity as enabled, c.relforcerowsecurity as forced
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and c.relkind in ('r', 'p')
      order by 1`,
    [SCHEMAS],
  );
  const columns = await q<{
    table: string;
    name: string;
    type: string;
    notnull: boolean;
    default: string | null;
  }>(
    `select ${QUALIFIED('c')} as table, a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as notnull, pg_get_expr(d.adbin, d.adrelid) as default
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where n.nspname = any($1) and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
      order by 1, a.attnum`,
    [SCHEMAS],
  );
  const constraints = await q<{
    table: string;
    name: string;
    type: string;
    definition: string;
    columns: string[];
    ref_table: string | null;
    ref_columns: string[];
  }>(
    `select ${QUALIFIED('c')} as table, k.conname as name, k.contype::text as type,
            pg_get_constraintdef(k.oid) as definition,
            array(select a.attname::text from unnest(k.conkey) with ordinality u(n, o)
                    join pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.o) as columns,
            (select ${QUALIFIED('f', 'fn')} from pg_namespace fn where fn.oid = f.relnamespace) as ref_table,
            array(select a.attname::text from unnest(k.confkey) with ordinality u(n, o)
                    join pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.o) as ref_columns
       from pg_constraint k
       join pg_class c on c.oid = k.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       left join pg_class f on f.oid = k.confrelid
      where n.nspname = any($1)
      order by 1, k.conname`,
    [SCHEMAS],
  );
  const indexes = await q<{ table: string; name: string; definition: string }>(
    `select ${QUALIFIED('t')} as table, i.relname as name, pg_get_indexdef(i.oid) as definition
       from pg_index x
       join pg_class i on i.oid = x.indexrelid
       join pg_class t on t.oid = x.indrelid
       join pg_namespace n on n.oid = t.relnamespace
      where n.nspname = any($1)
        and not exists (select 1 from pg_constraint k where k.conindid = x.indexrelid)
      order by 1, i.relname`,
    [SCHEMAS],
  );
  const policies = await q<{
    table: string;
    name: string;
    permissive: string;
    roles: string[];
    cmd: string;
    using: string | null;
    check: string | null;
  }>(
    `select (case when schemaname = 'public' then '' else schemaname || '.' end) || tablename as table,
            policyname as name, permissive, roles::text[] as roles, cmd, qual as using, with_check as check
       from pg_policies where schemaname = any($1)
      order by 1, policyname`,
    [SCHEMAS],
  );
  const triggers = await q<{ table: string; name: string; definition: string }>(
    `select ${QUALIFIED('c')} as table, t.tgname as name, pg_get_triggerdef(t.oid) as definition
       from pg_trigger t
       join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = any($1) and not t.tgisinternal
      order by 1, t.tgname`,
    [SCHEMAS],
  );
  const grants = await q<{ table: string; grantee: string; privilege: string }>(
    `select (case when table_schema = 'public' then '' else table_schema || '.' end) || table_name as table,
            grantee, privilege_type as privilege
       from information_schema.role_table_grants
      where table_schema = any($2) and grantee = any($1)
      order by 1, grantee, privilege_type`,
    [roles, SCHEMAS],
  );
  const views = await q<{ name: string; definition: string }>(
    `select viewname as name, definition from pg_views where schemaname = 'public' order by viewname`,
  );
  const enums = await q<{ name: string; values: string[] }>(
    `select t.typname as name,
            array(select e.enumlabel::text from pg_enum e where e.enumtypid = t.oid
                   order by e.enumsortorder) as values
       from pg_type t join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public' and t.typtype = 'e'
      order by t.typname`,
  );
  const functions = await q<{
    name: string;
    arguments: string;
    returns: string;
    definer: boolean;
    volatility: keyof typeof VOLATILITY;
    executable_by: string[];
  }>(
    `select p.proname as name, pg_get_function_identity_arguments(p.oid) as arguments,
            pg_get_function_result(p.oid) as returns, p.prosecdef as definer,
            p.provolatile::text as volatility,
            array(select r from unnest($1::text[]) r
                   where has_function_privilege(r, p.oid, 'EXECUTE') order by r) as executable_by
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
      order by p.proname, 2`,
    [roles],
  );
  const roleRows = await q<{ name: string; superuser: boolean; bypass_rls: boolean }>(
    `select rolname as name, rolsuper as superuser, rolbypassrls as bypass_rls
       from pg_roles where rolname = any($1) and rolname like 'expensewise%'
      order by rolname`,
    [roles],
  );

  const of = <T extends { table: string }>(rows: readonly T[], table: string) =>
    rows.filter((r) => r.table === table);

  return {
    tables: tables.map((t) => {
      const mine = of(constraints, t.name);
      return {
        name: t.name,
        rls: { enabled: t.enabled, forced: t.forced },
        columns: of(columns, t.name).map((c) => ({
          name: c.name,
          type: c.type,
          nullable: !c.notnull,
          default: c.default,
        })),
        primaryKey: mine.find((k) => k.type === 'p')?.columns ?? [],
        foreignKeys: mine
          .filter((k) => k.type === 'f')
          .map((k) => ({
            name: k.name,
            columns: k.columns,
            table: k.ref_table ?? '',
            references: k.ref_columns,
          })),
        uniques: mine
          .filter((k) => k.type === 'u')
          .map((k) => ({ name: k.name, columns: k.columns })),
        checks: mine
          .filter((k) => k.type === 'c')
          .map((k) => ({ name: k.name, definition: k.definition })),
        indexes: of(indexes, t.name).map(({ name, definition }) => ({ name, definition })),
        policies: of(policies, t.name).map((p) => ({
          name: p.name,
          command: p.cmd,
          permissive: p.permissive === 'PERMISSIVE',
          roles: [...p.roles].sort(),
          using: p.using,
          check: p.check,
        })),
        triggers: of(triggers, t.name).map(({ name, definition }) => ({ name, definition })),
        grants: Object.fromEntries(
          roles
            .map((r): [string, string[]] => [
              r,
              of(grants, t.name)
                .filter((g) => g.grantee === r)
                .map((g) => g.privilege),
            ])
            .filter(([, privileges]) => privileges.length > 0),
        ),
      };
    }),
    views,
    enums,
    functions: functions.map((f) => ({
      name: f.name,
      arguments: f.arguments,
      returns: f.returns,
      security: f.definer ? 'definer' : 'invoker',
      volatility: VOLATILITY[f.volatility],
      executableBy: f.executable_by,
    })),
    roles: roleRows.map((r) => ({ name: r.name, superuser: r.superuser, bypassRls: r.bypass_rls })),
  };
}

/** The snapshot as committed: stable JSON with a trailing newline. */
export const snapshotJson = (snapshot: SchemaSnapshot) => `${JSON.stringify(snapshot, null, 2)}\n`;
