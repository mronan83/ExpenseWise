import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, from this file's place in tools/records/src. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const read = (path: string) => readFileSync(join(REPO_ROOT, path), 'utf8');
export const exists = (path: string) => existsSync(join(REPO_ROOT, path));

const SKIP = new Set(['node_modules', '.next', '.turbo', 'coverage', 'dist', '.git']);

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

/**
 * Every test file, by alias: `db/tenancy.int` is packages/db/test/tenancy.int.test.ts,
 * `domain/lifecycle/expense` is packages/domain/src/lifecycle/expense.test.ts, `e2e/shell` is
 * apps/web/e2e/shell.spec.ts, `evals/score` is evals/src/score.test.ts and `records/render`
 * is tools/records/src/render.test.ts.
 */
export function testFiles(): Map<string, string> {
  const files = [
    ...walk('packages', (p) => /\/(src|test)\/.*\.test\.ts$/.test(p)),
    ...walk('apps/web/e2e', (p) => p.endsWith('.spec.ts')),
    ...walk('evals/src', (p) => p.endsWith('.test.ts')),
    ...walk('tools', (p) => /\/src\/.*\.test\.ts$/.test(p)),
  ];
  const aliases = new Map<string, string>();
  for (const file of files) {
    const alias = aliasOf(file);
    const clash = aliases.get(alias);
    if (clash) throw new Error(`${file} and ${clash} share the alias ${alias}`);
    aliases.set(alias, file);
  }
  return aliases;
}

export function aliasOf(file: string): string {
  const strip = (s: string) => s.replace(/\.int\.test\.ts$/, '.int').replace(/\.test\.ts$/, '');
  let m = /^packages\/([^/]+)\/(?:src|test)\/(.+)$/.exec(file);
  if (m) return `${m[1]}/${strip(m[2]!)}`;
  m = /^apps\/web\/e2e\/(.+)\.spec\.ts$/.exec(file);
  if (m) return `e2e/${m[1]}`;
  m = /^evals\/src\/(.+)$/.exec(file);
  if (m) return `evals/${strip(m[1]!)}`;
  m = /^tools\/([^/]+)\/src\/(.+)$/.exec(file);
  if (m) return `${m[1]}/${strip(m[2]!)}`;
  throw new Error(`No alias for ${file}`);
}

export const fileText = read;

/** CI jobs a check can name: `ci:<job id>` in ci.yml, plus `ci:codeql`. */
export function ciJobs(): Set<string> {
  const ci = read('.github/workflows/ci.yml');
  const jobs = ci.slice(ci.indexOf('\njobs:'));
  const ids = [...jobs.matchAll(/^ {2}([a-z][a-z0-9-]*):\s*$/gm)].map((m) => `ci:${m[1]}`);
  if (exists('.github/workflows/codeql.yml')) ids.push('ci:codeql');
  return new Set(ids);
}

/** Every operation in the generated contract, as `GET /v1/receipts`. */
export function apiOperations(): string[] {
  const contract = JSON.parse(read('packages/api/openapi.json')) as {
    paths: Record<string, Record<string, unknown>>;
  };
  return Object.entries(contract.paths).flatMap(([path, methods]) =>
    Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`),
  );
}

/** Every page in the web app, as its route: `/`, `/receipts/[id]`. */
export function webRoutes(): string[] {
  return walk('apps/web/app', (p) => p.endsWith('/page.tsx')).map((p) => {
    const route = p.slice('apps/web/app'.length, -'/page.tsx'.length);
    return route === '' ? '/' : route;
  });
}

/** Every workflow function id. */
export function workflowIds(): string[] {
  return walk('packages/workflows/src', (p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
    .flatMap((p) => [...read(p).matchAll(/createFunction\(\s*\{\s*id:\s*'([^']+)'/g)])
    .map((m) => m[1]!);
}

export interface AdrFile {
  readonly id: string;
  readonly path: string;
  readonly title: string;
  readonly superseded: boolean;
}

export function adrs(): AdrFile[] {
  return readdirSync(join(REPO_ROOT, 'docs/adr'))
    .filter((name) => /^\d{4}-.+\.md$/.test(name) && !name.startsWith('0000'))
    .sort()
    .map((name) => {
      const path = `docs/adr/${name}`;
      const text = read(path);
      return {
        id: `ADR-${name.slice(0, 4)}`,
        path,
        title: /^# ADR-\d{4}: (.+)$/m.exec(text)?.[1] ?? name,
        superseded: /\*\*Status:\*\* Superseded/.test(text),
      };
    });
}

/** Decision ids in the register (docs/README.md). */
export function decisionIds(): Set<string> {
  return new Set([...read('docs/README.md').matchAll(/^\| (D-\d+) \|/gm)].map((m) => m[1]!));
}

export interface Capability {
  readonly area: string;
  readonly phase: string;
  readonly name: string;
  /** `Area · Capability`, as requirements name it. */
  readonly key: string;
}

/** Every cell of the capability map, the scope contract. */
export function capabilityMap(): Capability[] {
  const text = read('docs/02-capability-map.md');
  const phases = ['P1', 'P2', 'P3', 'P4'];
  const rows = text
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| Area') && !line.startsWith('| ---'),
    );
  return rows.flatMap((line) => {
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    const area = cells[0]!;
    return cells.slice(2, 6).flatMap((cell, i) =>
      cell
        .split('<br>')
        .map((name) => name.trim())
        .filter((name) => name !== '' && name !== '–')
        .map((name) => ({ area, phase: phases[i]!, name, key: `${area} · ${name}` })),
    );
  });
}

/** The docs a source reference can name, by key. */
export const DOCS: Record<string, string> = {
  vision: 'docs/01-vision-and-scope.md',
  capmap: 'docs/02-capability-map.md',
  journeys: 'docs/03-journeys-and-workflows.md',
  design: 'docs/04-app-design.md',
  arch: 'docs/05-architecture.md',
  delivery: 'docs/06-delivery-lifecycle.md',
  roadmap: 'docs/07-roadmap.md',
  risks: 'docs/08-risk-register.md',
};
