import { fileAt } from './inventory.ts';
import { fileText } from './repo.ts';

/*
 * The schema snapshot (packages/db/schema.json), as the data model page reads it. The shape is
 * @expensewise/db's SchemaSnapshot; it is repeated here so the records don't depend on the
 * database package.
 */

export interface SnapshotTable {
  readonly name: string;
  readonly rls: { readonly enabled: boolean; readonly forced: boolean };
  readonly columns: readonly {
    readonly name: string;
    readonly type: string;
    readonly nullable: boolean;
    readonly default: string | null;
  }[];
  readonly primaryKey: readonly string[];
  readonly foreignKeys: readonly {
    readonly name: string;
    readonly columns: readonly string[];
    readonly table: string;
    readonly references: readonly string[];
  }[];
  readonly uniques: readonly { readonly name: string; readonly columns: readonly string[] }[];
  readonly checks: readonly { readonly name: string; readonly definition: string }[];
  readonly indexes: readonly { readonly name: string; readonly definition: string }[];
  readonly policies: readonly {
    readonly name: string;
    readonly command: string;
    readonly permissive: boolean;
    readonly roles: readonly string[];
    readonly using: string | null;
    readonly check: string | null;
  }[];
  readonly triggers: readonly { readonly name: string; readonly definition: string }[];
  readonly grants: Readonly<Record<string, readonly string[]>>;
}

export interface Snapshot {
  readonly tables: readonly SnapshotTable[];
  readonly views: readonly { readonly name: string; readonly definition: string }[];
  readonly enums: readonly { readonly name: string; readonly values: readonly string[] }[];
  readonly functions: readonly {
    readonly name: string;
    readonly arguments: string;
    readonly returns: string;
    readonly security: 'definer' | 'invoker';
    readonly volatility: string;
    readonly executableBy: readonly string[];
  }[];
  readonly roles: readonly {
    readonly name: string;
    readonly superuser: boolean;
    readonly bypassRls: boolean;
  }[];
}

export const SNAPSHOT_PATH = 'packages/db/schema.json';

export const schemaSnapshot = (): Snapshot => JSON.parse(fileText(SNAPSHOT_PATH)) as Snapshot;

/** The snapshot at an earlier commit, or undefined before snapshots existed. */
export function schemaSnapshotAt(sha: string): Snapshot | undefined {
  const text = fileAt(sha, SNAPSHOT_PATH);
  return text ? (JSON.parse(text) as Snapshot) : undefined;
}

/** Every named object: constraints, indexes, policies, triggers and functions. */
export function snapshotObjectNames(s: Snapshot): Set<string> {
  const names = new Set<string>();
  for (const t of s.tables) {
    t.foreignKeys.forEach((k) => names.add(k.name));
    t.uniques.forEach((k) => names.add(k.name));
    t.checks.forEach((k) => names.add(k.name));
    t.indexes.forEach((k) => names.add(k.name));
    t.policies.forEach((k) => names.add(k.name));
    t.triggers.forEach((k) => names.add(k.name));
  }
  s.functions.forEach((f) => names.add(f.name));
  return names;
}

export interface SchemaChange {
  readonly kind: 'added' | 'removed' | 'changed';
  readonly what: string;
  readonly detail: string;
}

/** What changed between two snapshots, table by table and object by object. */
export function schemaChanges(before: Snapshot, after: Snapshot): SchemaChange[] {
  const out: SchemaChange[] = [];
  const byName = <T extends { name: string }>(xs: readonly T[]) =>
    new Map(xs.map((x) => [x.name, x]));
  const diff = <T extends { name: string }>(
    label: string,
    a: readonly T[],
    b: readonly T[],
    describe: (x: T) => string,
    within = '',
  ) => {
    const was = byName(a);
    const now = byName(b);
    for (const [name, x] of now) {
      const old = was.get(name);
      const where = `${within}${label} ${name}`;
      if (!old) out.push({ kind: 'added', what: where, detail: describe(x) });
      else if (JSON.stringify(old) !== JSON.stringify(x)) {
        out.push({ kind: 'changed', what: where, detail: `${describe(old)} → ${describe(x)}` });
      }
    }
    for (const [name, x] of was) {
      if (!now.has(name))
        out.push({ kind: 'removed', what: `${within}${label} ${name}`, detail: describe(x) });
    }
  };
  const was = byName(before.tables);
  for (const t of after.tables) {
    const old = was.get(t.name);
    if (!old) {
      out.push({ kind: 'added', what: `table ${t.name}`, detail: `${t.columns.length} columns` });
      continue;
    }
    const at = `${t.name}: `;
    diff(
      'column',
      old.columns,
      t.columns,
      (c) => `${c.type}${c.nullable ? '' : ' not null'}${c.default ? ` default ${c.default}` : ''}`,
      at,
    );
    diff(
      'foreign key',
      old.foreignKeys,
      t.foreignKeys,
      (k) => `(${k.columns.join(', ')}) → ${k.table}`,
      at,
    );
    diff('unique', old.uniques, t.uniques, (k) => `(${k.columns.join(', ')})`, at);
    diff('check', old.checks, t.checks, (k) => k.definition, at);
    diff('index', old.indexes, t.indexes, (k) => k.definition, at);
    diff('policy', old.policies, t.policies, (p) => `${p.command} using ${p.using ?? '—'}`, at);
    diff('trigger', old.triggers, t.triggers, (k) => k.definition, at);
    if (JSON.stringify(old.grants) !== JSON.stringify(t.grants)) {
      out.push({ kind: 'changed', what: `${at}grants`, detail: JSON.stringify(t.grants) });
    }
    if (JSON.stringify(old.rls) !== JSON.stringify(t.rls)) {
      out.push({ kind: 'changed', what: `${at}row-level security`, detail: JSON.stringify(t.rls) });
    }
  }
  for (const t of before.tables) {
    if (!after.tables.some((x) => x.name === t.name)) {
      out.push({ kind: 'removed', what: `table ${t.name}`, detail: `${t.columns.length} columns` });
    }
  }
  diff('enum', before.enums, after.enums, (e) => e.values.join(', '));
  diff(
    'function',
    before.functions,
    after.functions,
    (f) => `${f.arguments} → ${f.returns}, ${f.security}`,
  );
  diff('view', before.views, after.views, () => 'view');
  return out;
}
