import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { REPO_ROOT } from './repo.ts';

/*
 * What the architecture and data model pages read from the repository, so their inventory is
 * never written by hand. Each reader is plain file access; the git readers answer for an
 * earlier commit, for the pages' "changed in this release" sections.
 */

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
const SKIP = new Set(['node_modules', '.next', '.turbo', 'coverage', 'dist', '.git', '.data']);

function walk(dir: string, keep: (path: string) => boolean): string[] {
  const root = join(REPO_ROOT, dir);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (abs: string) => {
    for (const name of readdirSync(abs)) {
      if (SKIP.has(name)) continue;
      const path = join(abs, name);
      if (statSync(path).isDirectory()) visit(path);
      else {
        const rel = relative(REPO_ROOT, path).split(sep).join('/');
        if (keep(rel)) out.push(rel);
      }
    }
  };
  visit(root);
  return out.sort();
}

export interface WorkspacePackage {
  readonly path: string;
  readonly name: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly devDependencies: Readonly<Record<string, string>>;
}

/** Every package in the pnpm workspace (pnpm-workspace.yaml), by path. */
export function workspacePackages(): WorkspacePackage[] {
  const globs = [...read('pnpm-workspace.yaml').matchAll(/^ {2}- (\S+)$/gm)]
    .map((m) => m[1]!)
    .filter((g) => !g.startsWith("'"));
  const dirs = globs.flatMap((g) =>
    g.endsWith('/*')
      ? readdirSync(join(REPO_ROOT, g.slice(0, -2)))
          .map((d) => `${g.slice(0, -2)}/${d}`)
          .filter((d) => existsSync(join(REPO_ROOT, d, 'package.json')))
      : existsSync(join(REPO_ROOT, g, 'package.json'))
        ? [g]
        : [],
  );
  return dirs.sort().map((path) => {
    const pkg = JSON.parse(read(`${path}/package.json`)) as {
      name: string;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      path,
      name: pkg.name,
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
    };
  });
}

const SOURCE = /\.(ts|tsx|mts|mjs)$/;
const NOT_TEST = (p: string) => !/\.(test|spec)\.tsx?$/.test(p) && !p.includes('/test/');

/**
 * Every setting the code or the pipeline reads, with where: `process.env.X`, `process.env['X']`
 * and the web app's `env('X')` in source; `env.X` in the release script; `secrets.X` in the
 * GitHub workflows.
 */
export function settingsRead(): Map<string, string[]> {
  const found = new Map<string, Set<string>>();
  const add = (name: string, file: string) => {
    const files = found.get(name) ?? new Set<string>();
    files.add(file);
    found.set(name, files);
  };
  const code = [
    ...walk('apps', (p) => SOURCE.test(p) && NOT_TEST(p)),
    ...walk('packages', (p) => SOURCE.test(p) && NOT_TEST(p)),
    ...walk('tools', (p) => SOURCE.test(p) && NOT_TEST(p)),
    ...walk('evals/src', (p) => SOURCE.test(p) && NOT_TEST(p)),
  ];
  for (const file of code) {
    const text = read(file);
    for (const m of text.matchAll(
      /process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]|\benv\(['"]([A-Z][A-Z0-9_]+)['"]\)/g,
    )) {
      add(m[1] ?? m[2] ?? m[3]!, file);
    }
  }
  for (const file of walk('.github/scripts', (p) => SOURCE.test(p))) {
    for (const m of read(file).matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) add(m[1]!, file);
  }
  for (const file of walk('.github/workflows', (p) => p.endsWith('.yml'))) {
    for (const m of read(file).matchAll(/\bsecrets\.([A-Z][A-Z0-9_]+)/g)) add(m[1]!, file);
  }
  return new Map([...found].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, [...v]]));
}

export interface GithubWorkflow {
  readonly file: string;
  readonly name: string;
  readonly triggers: readonly string[];
  readonly jobs: readonly { readonly id: string; readonly name: string }[];
}

/** The GitHub Actions workflows: name, triggers and jobs. */
export function githubWorkflows(): GithubWorkflow[] {
  return walk('.github/workflows', (p) => p.endsWith('.yml')).map((path) => {
    const text = read(path);
    const onBlock = /\non:\n((?: {2}.*\n?)+)/.exec(text)?.[1] ?? '';
    const triggers = [...onBlock.matchAll(/^ {2}([a-z_]+):/gm)].map((m) =>
      m[1]!.replace(/_/g, ' '),
    );
    const jobsBlock = text.slice(text.indexOf('\njobs:'));
    const jobs = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*\n {4}name: (.+)$/gm)].map(
      (m) => ({ id: m[1]!, name: m[2]!.trim().replace(/^['"]|['"]$/g, '') }),
    );
    return {
      file: path.slice('.github/workflows/'.length),
      name: /^name: (.+)$/m.exec(text)?.[1]?.trim() ?? path,
      triggers,
      jobs,
    };
  });
}

/** The migrations, in order, from Drizzle's journal. */
export function migrations(): string[] {
  const journal = JSON.parse(read('packages/db/migrations/meta/_journal.json')) as {
    entries: { tag: string }[];
  };
  return journal.entries.map((e) => e.tag);
}

export interface TestCount {
  readonly kind: string;
  readonly files: number;
  readonly cases: number;
}

const cases = (files: readonly string[]) =>
  files.reduce(
    (n, f) => n + [...read(f).matchAll(/^\s*(?:it|test)(?:\.each\([^)]*\))?\(/gm)].length,
    0,
  );

/** Test files and test cases by kind. Cases are counted in the source; `each` counts once. */
export function testCounts(): TestCount[] {
  const kinds: [string, string[]][] = [
    ['Unit and property', walk('packages', (p) => /\/src\/.*\.test\.ts$/.test(p))],
    ['Integration, on a real Postgres', walk('packages/db/test', (p) => p.endsWith('.test.ts'))],
    [
      'API, on in-memory stores',
      walk('packages', (p) => /\/test\/.*\.test\.ts$/.test(p) && !p.startsWith('packages/db/')),
    ],
    ['End-to-end and accessibility', walk('apps/web/e2e', (p) => p.endsWith('.spec.ts'))],
    ['Records and pages', walk('tools', (p) => /\/src\/.*\.test\.ts$/.test(p))],
    ['Evals', walk('evals/src', (p) => p.endsWith('.test.ts'))],
  ];
  return kinds.map(([kind, files]) => ({ kind, files: files.length, cases: cases(files) }));
}

/** The Drizzle variable and table name of each table in packages/db/src/schema.ts. */
export function drizzleTables(): Map<string, string> {
  const text = read('packages/db/src/schema.ts');
  return new Map(
    [...text.matchAll(/export const (\w+) = pgTable\(\s*'([\w.]+)'/g)].map((m) => [m[2]!, m[1]!]),
  );
}

/**
 * Notes on columns, from the comments above them in packages/db/src/schema.ts:
 * table → column → note.
 */
export function columnNotes(): Map<string, Map<string, string>> {
  const notes = new Map<string, Map<string, string>>();
  let table: string | undefined;
  let awaitingName = false;
  let pending: string[] = [];
  let inBlock = false;
  for (const line of read('packages/db/src/schema.ts').split('\n')) {
    const trimmed = line.trim();
    const sameLine = /pgTable\(\s*'([\w.]+)'/.exec(line);
    if (sameLine) {
      table = sameLine[1];
      pending = [];
      continue;
    }
    if (/pgTable\(\s*$/.test(line)) {
      awaitingName = true;
      continue;
    }
    if (awaitingName) {
      table = /^'([\w.]+)',$/.exec(trimmed)?.[1];
      awaitingName = false;
      pending = [];
      continue;
    }
    if (line === ');') {
      table = undefined;
      continue;
    }
    if (inBlock) {
      inBlock = !trimmed.endsWith('*/');
      pending.push(trimmed.replace(/^\*\/?\s?/, '').replace(/\s?\*\/$/, ''));
      continue;
    }
    if (trimmed.startsWith('/**')) {
      inBlock = !trimmed.endsWith('*/');
      pending = [trimmed.replace(/^\/\*\*\s?/, '').replace(/\s?\*\/$/, '')];
      continue;
    }
    if (trimmed.startsWith('//')) {
      pending.push(trimmed.replace(/^\/\/\s?/, ''));
      continue;
    }
    const column = /^\s+\w+: \w+\('([a-z0-9_]+)'/.exec(line);
    if (column && table && pending.length > 0) {
      const byColumn = notes.get(table) ?? new Map<string, string>();
      byColumn.set(column[1]!, pending.filter(Boolean).join(' ').trim());
      notes.set(table, byColumn);
    }
    pending = [];
  }
  return notes;
}

/** How the app's code uses a table: written, only read, or not at all yet. */
export type TableUse = 'written' | 'read' | 'unused';

export function tableUse(): Map<string, TableUse> {
  const code = walk('packages', (p) => /\/src\/.*\.ts$/.test(p) && NOT_TEST(p))
    .filter((p) => p !== 'packages/db/src/schema.ts')
    .map(read)
    .join('\n');
  return new Map(
    [...drizzleTables()].map(([table, variable]) => {
      const written = new RegExp(`\\.(insert|update|delete)\\(${variable}\\)`).test(code);
      const readIt = new RegExp(`\\b(from|Join|join)\\(${variable}\\b|\\b${variable}\\.\\w+`).test(
        code,
      );
      return [table, written ? 'written' : readIt ? 'read' : 'unused'];
    }),
  );
}

const git = (...args: string[]) =>
  execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/** A file as it was at a commit, or undefined where it didn't exist. */
export function fileAt(sha: string, path: string): string | undefined {
  try {
    return git('show', `${sha}:${path}`);
  } catch {
    return undefined;
  }
}

/** File names in a directory at a commit. */
export function filesAt(sha: string, dir: string): string[] {
  try {
    return git('ls-tree', '--name-only', `${sha}:${dir}`).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** The commits between two that touched a path, oldest first: sha and subject. */
export function commitsTouching(
  since: string,
  until: string,
  path: string,
): { sha: string; subject: string }[] {
  try {
    return git('log', '--reverse', '--format=%H%x09%s', `${since}..${until}`, '--', path)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha, subject] = line.split('\t') as [string, string];
        return { sha, subject };
      });
  } catch {
    return [];
  }
}
