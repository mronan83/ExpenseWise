import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { problems } from './integrity.ts';
import { PAGE_URLS, PRODUCTION_URL, REPOSITORY } from './pages.ts';
import { renderArchitecture } from './render/architecture.ts';
import { renderBacklog } from './render/backlog.ts';
import { renderDataModel } from './render/data-model.ts';
import { renderStories } from './render/stories.ts';
import type { PageContext } from './render/shared.ts';
import { renderTraceability } from './render/traceability.ts';
import { REPO_ROOT } from './repo.ts';

/**
 * Builds the five pages for publication after a successful release: traceability, backlog,
 * technical architecture, data model, and user stories and acceptance criteria.
 *
 *   pnpm records:pages --out <dir> [--since <previous production commit>]
 *
 * `--draft "<why>"` marks the pages as built from records still in review, such as a
 * pull request the product owner wants to read before it merges.
 * It reads which commit production serves from its health check, and refuses to build while
 * the records and the code disagree, or while production serves a commit this checkout
 * doesn't have.
 */
const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    out: { type: 'string' },
    since: { type: 'string' },
    production: { type: 'string' },
    date: { type: 'string' },
    draft: { type: 'string' },
  },
});

const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();

async function main() {
  if (!values.out) throw new Error('Pass --out <dir> for the pages.');
  const found = problems();
  if (found.length > 0) {
    throw new Error(`The records disagree with the code:\n  ${found.join('\n  ')}`);
  }

  let served = values.production;
  if (!served) {
    const health = (await fetch(`${PRODUCTION_URL}/api/v1/health?records=${Date.now()}`).then((r) =>
      r.json(),
    )) as { version?: string };
    if (!health.version) throw new Error('Production did not report its version.');
    served = health.version;
  }
  const productionSha = git('rev-parse', '--verify', `${served}^{commit}`);
  const recordsSha = git('rev-parse', 'HEAD');
  try {
    git('merge-base', '--is-ancestor', productionSha, recordsSha);
  } catch {
    throw new Error(
      `Production serves ${productionSha.slice(0, 7)}, which this checkout doesn't contain. Check out main at or after it.`,
    );
  }

  const since = values.since ? git('rev-parse', '--verify', `${values.since}^{commit}`) : undefined;
  const commits = since
    ? git('log', '--first-parent', '--format=%H%x09%s', `${since}..${productionSha}`)
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [sha, subject] = line.split('\t') as [string, string];
          return { sha, subject };
        })
    : [];

  const ctx: PageContext = {
    repo: REPOSITORY,
    recordsSha,
    productionSha,
    date: values.date ?? new Date().toISOString().slice(0, 10),
    urls: PAGE_URLS,
    ...(values.draft ? { draft: values.draft } : {}),
    ...(since ? { release: { since, commits } } : {}),
  };
  const out = resolve(values.out);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'traceability.html'), renderTraceability(ctx));
  writeFileSync(join(out, 'backlog.html'), renderBacklog(ctx));
  writeFileSync(join(out, 'architecture.html'), renderArchitecture(ctx));
  writeFileSync(join(out, 'data-model.html'), renderDataModel(ctx));
  writeFileSync(join(out, 'stories.html'), renderStories(ctx));
  console.log(
    `Built five pages in ${out}: production ${productionSha.slice(0, 7)}, records ${recordsSha.slice(0, 7)}.`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
