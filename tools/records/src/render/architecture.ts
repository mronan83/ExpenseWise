import {
  BACKGROUND,
  COMPONENTS,
  CONTEXT_DIAGRAM,
  FLOWS,
  PRINCIPLES,
  QUALITY,
  SERVICES,
  SETTINGS,
  SUMMARY,
  WORKFLOWS,
} from '../architecture.ts';
import { FEATURES } from '../features.ts';
import {
  commitsTouching,
  fileAt,
  filesAt,
  githubWorkflows,
  migrations,
  testCounts,
  workspacePackages,
} from '../inventory.ts';
import { adrs, apiOperations, fileText, webRoutes, workflowIds } from '../repo.ts';
import { GAPS } from '../tracing.ts';
import {
  draftBanner,
  esc,
  ext,
  frame,
  githubCommit,
  githubFile,
  inline,
  mermaid,
  pill,
  refLink,
  short,
  slip,
  table,
  type PageContext,
} from './shared.ts';

const PAGE = 'architecture' as const;
export const ARCHITECTURE_TITLE = 'ExpenseWise Technical Architecture';
export const ARCHITECTURE_SOURCE = 'tools/records/src/architecture.ts';

interface Operation {
  readonly method: string;
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
}

const operationsOf = (contract: string | undefined): Operation[] => {
  if (!contract) return [];
  const parsed = JSON.parse(contract) as {
    paths: Record<string, Record<string, { tags?: string[]; summary?: string }>>;
  };
  return Object.entries(parsed.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({
      method: method.toUpperCase(),
      path,
      tag: op.tags?.[0] ?? 'Other',
      summary: op.summary ?? '',
    })),
  );
};

/** What the inventory gained or lost since the last release, and whether the text changed. */
function releaseChanges(ctx: PageContext, T: (s: string) => string): string {
  if (!ctx.release) return '';
  const since = ctx.release.since;
  const list = (label: string, before: readonly string[], after: readonly string[]) => {
    const added = after.filter((x) => !before.includes(x));
    const removed = before.filter((x) => !after.includes(x));
    return [
      ...added.map(
        (x) => `<li>${pill('ch-added', 'Added')} ${esc(label)} <code>${esc(x)}</code></li>`,
      ),
      ...removed.map(
        (x) => `<li>${pill('ch-removed', 'Removed')} ${esc(label)} <code>${esc(x)}</code></li>`,
      ),
    ];
  };
  const opKey = (o: Operation) => `${o.method} ${o.path}`;
  const items = [
    ...list(
      'API operation',
      operationsOf(fileAt(since, 'packages/api/openapi.json')).map(opKey),
      apiOperations(),
    ),
    ...list('page', gitRoutes(since), webRoutes()),
    ...list(
      'decision',
      filesAt(since, 'docs/adr').filter((f) => /^\d{4}-/.test(f) && !f.startsWith('0000')),
      adrs().map((a) => a.path.slice('docs/adr/'.length)),
    ),
    ...list(
      'migration',
      (
        JSON.parse(
          fileAt(since, 'packages/db/migrations/meta/_journal.json') ?? '{"entries":[]}',
        ) as {
          entries: { tag: string }[];
        }
      ).entries.map((e) => e.tag),
      migrations(),
    ),
    ...list(
      'workflow',
      filesAt(since, '.github/workflows'),
      githubWorkflows().map((w) => w.file),
    ),
  ];
  const revised = commitsTouching(since, ctx.recordsSha, ARCHITECTURE_SOURCE);
  const text = !fileAt(since, ARCHITECTURE_SOURCE)
    ? '<p>First edition: the written half is new in this release.</p>'
    : revised.length
      ? `<p>The written half was revised in ${revised.length} ${revised.length === 1 ? 'commit' : 'commits'}: ${revised.map((c) => `${ext(githubCommit(ctx, c.sha), `<code>${short(c.sha)}</code>`)} ${T(c.subject)}`).join('; ')}.</p>`
      : '<p>The written half needed no revision in this release.</p>';
  return `<div class="callout" role="status"><p class="eyebrow">Changed in this release</p>
<p class="note">Since ${ext(githubCommit(ctx, since), `<code>${short(since)}</code>`)}. Assessed at every release; read from the repository, not written by hand.</p>
${items.length ? `<ul class="changes">${items.join('')}</ul>` : '<p>No component, operation, page, decision, migration or workflow was added or removed.</p>'}
${text}</div>`;
}

/** The app's pages at an earlier commit, as routes. */
function gitRoutes(sha: string): string[] {
  const walk = (dir: string): string[] =>
    filesAt(sha, dir).flatMap((name) => {
      const path = `${dir}/${name}`;
      if (name === 'page.tsx') return [path];
      return name.includes('.') ? [] : walk(path);
    });
  return walk('apps/web/app').map((p) => {
    const route = p.slice('apps/web/app'.length, -'/page.tsx'.length);
    return route === '' ? '/' : route;
  });
}

export function renderArchitecture(ctx: PageContext): string {
  const T = (text: string) => inline(ctx, PAGE, text);
  const refs = (ids: readonly string[]) =>
    ids.length
      ? `<span class="refs">${ids.map((id) => refLink(ctx, PAGE, id)).join(' ')}</span>`
      : '';
  const packages = workspacePackages();
  const ops = operationsOf(fileText('packages/api/openapi.json'));
  const routes = webRoutes();
  const functions = workflowIds();
  const workflows = githubWorkflows();
  const tests = testCounts();
  const decisions = adrs();
  const migrationTags = migrations();
  const openGaps = GAPS.filter((g) => !g.closed);

  const hero = `<header class="hero">
  <p class="eyebrow">ExpenseWise · Technical architecture</p>
  ${draftBanner(ctx)}
  <div class="hero-top">
    <div class="hero-text">
      <h1>Technical architecture</h1>
      <p class="meta">As live in production at ${ext(githubCommit(ctx, ctx.productionSha), `<code>${short(ctx.productionSha)}</code>`)} · ${esc(ctx.date)} · read from ${ext(githubCommit(ctx, ctx.recordsSha), `<code>${short(ctx.recordsSha)}</code>`)}</p>
      <p class="lede">${T(SUMMARY)}</p>
      <p class="source">The written half is ${ext(githubFile(ctx, ARCHITECTURE_SOURCE), `<code>${ARCHITECTURE_SOURCE}</code>`)}; everything under Inventory, and every count, is read from the repository when the page is built. A test fails when a package, setting, workflow or background function has no description, so nothing arrives undescribed.${ctx.urls.dataModel ? ` The schema has its own page: ${ext(ctx.urls.dataModel, 'data model')}.` : ''}</p>
    </div>
    ${slip(
      'Build sheet',
      [
        { label: 'Packages', value: packages.length },
        { label: 'API operations', value: ops.length },
        { label: 'Pages', value: routes.length },
        { label: 'Background functions', value: functions.length },
        { label: 'GitHub workflows', value: workflows.length },
        { label: 'Migrations', value: migrationTags.length },
        { label: 'Decision records', value: decisions.length },
        { label: 'Tests', value: tests.reduce((n, t) => n + t.cases, 0) },
      ],
      `${esc(short(ctx.recordsSha))} · ${esc(ctx.date)}`,
    )}
  </div>
  ${releaseChanges(ctx, T)}
</header>`;

  const principles = `<section id="principles" aria-labelledby="principles-h"><h2 id="principles-h">Principles, as built</h2>
<p class="note">The eight design principles (${ext(githubFile(ctx, 'docs/05-architecture.md'), 'architecture §6.1')}), with how the code meets each today and where it falls short.</p>
${table(
  ['', 'Principle', 'As built', 'Falls short', 'Decided in'],
  PRINCIPLES.map(
    (p) =>
      `<tr id="${p.id}"><td class="id">${p.id}</td><td class="nowrap"><b>${esc(p.name)}</b></td><td class="wide">${T(p.built)}</td><td class="wide">${p.short ? T(p.short) : '<span class="ok">—</span>'}</td><td>${refs(p.refs)}</td></tr>`,
  ),
)}</section>`;

  const context = `<section id="context" aria-labelledby="context-h"><h2 id="context-h">System context</h2>
<p class="note">One environment shown. Every browser request carries the person’s own token, so the database applies their organization; only the release and the backup hold the schema owner’s connection.</p>
${mermaid(CONTEXT_DIAGRAM, 'System context: the browser, the Next.js app on Vercel, Supabase, Inngest, the AI providers and GitHub Actions')}
<h3>Components</h3>
${table(
  ['Component', 'Technology', 'Responsibility', 'Where'],
  COMPONENTS.map((c) => {
    const names = c.where
      .map((path) => packages.find((p) => p.path === path))
      .filter(Boolean)
      .map((p) => `<code>${esc(p!.path)}</code><div class="sub">${esc(p!.name)}</div>`)
      .join('');
    return `<tr><td class="nowrap"><b>${esc(c.name)}</b></td><td>${esc(c.technology)}</td><td class="wide">${T(c.responsibility)}</td><td class="nowrap">${names}</td></tr>`;
  }),
)}
<h3>Services we buy</h3>
${table(
  ['Service', 'What it does for us'],
  SERVICES.map(
    (s) => `<tr><td class="nowrap"><b>${esc(s.name)}</b></td><td>${T(s.role)}</td></tr>`,
  ),
)}</section>`;

  // Package graph: internal dependencies only, drawn from package.json.
  const internal = new Set(packages.map((p) => p.name));
  const node = (name: string) => name.replace(/^@expensewise\//, '').replace(/[^a-z0-9]/g, '_');
  const graph = [
    'flowchart BT',
    ...packages.map(
      (p) =>
        `  ${node(p.name)}["${p.name.replace(/^@expensewise\//, '')}<br/><small>${p.path}</small>"]`,
    ),
    ...packages.flatMap((p) =>
      Object.keys(p.dependencies)
        .filter((d) => internal.has(d))
        .map((d) => `  ${node(p.name)} --> ${node(d)}`),
    ),
  ].join('\n');
  const external = (p: (typeof packages)[number]) =>
    Object.entries(p.dependencies)
      .filter(([d]) => !internal.has(d))
      .map(([d, v]) => `<code>${esc(d)}</code> <span class="ver">${esc(v)}</span>`)
      .join('<br>');
  const modules = `<section id="packages" aria-labelledby="packages-h"><h2 id="packages-h">Packages and how they depend</h2>
<p class="note">Arrows point at what a package uses. Nothing points back up: the domain uses nothing of ours, and only the web app uses everything. Read from each <code>package.json</code>.</p>
${mermaid(graph, 'Workspace packages and the packages each depends on')}
${table(
  ['Package', 'Path', 'Uses of ours', 'Outside dependencies'],
  packages.map(
    (p) =>
      `<tr><td class="nowrap"><code>${esc(p.name)}</code></td><td class="nowrap"><code>${esc(p.path)}</code></td><td>${
        Object.keys(p.dependencies)
          .filter((d) => internal.has(d))
          .map((d) => `<code>${esc(d.replace(/^@expensewise\//, ''))}</code>`)
          .join(' ') || '—'
      }</td><td class="deps">${external(p) || '—'}</td></tr>`,
  ),
)}</section>`;

  const flows = `<section id="flows" aria-labelledby="flows-h"><h2 id="flows-h">Key flows</h2>
${FLOWS.map(
  (f) =>
    `<div class="flow" id="flow-${f.id}"><h3>${esc(f.title)}</h3><p>${T(f.about)}</p>${mermaid(f.diagram, f.title)}<p class="note">Decided in ${refs(f.refs)}</p></div>`,
).join('\n')}</section>`;

  const screens = new Map<string, string>();
  for (const f of FEATURES) for (const s of f.screens ?? []) screens.set(s, f.id);
  const apis = new Map<string, string>();
  for (const f of FEATURES) for (const a of f.api ?? []) apis.set(a, f.id);
  const tags = [...new Set(ops.map((o) => o.tag))];
  const surface = `<section id="surface" aria-labelledby="surface-h"><h2 id="surface-h">API and pages</h2>
<p class="note">Every operation in the generated contract (<code>packages/api/openapi.json</code>), grouped as the contract groups them, with the feature that claims it on the ${ctx.urls.traceability ? ext(ctx.urls.traceability, 'traceability page') : 'traceability page'}.</p>
${table(
  ['Method', 'Path', 'What it does', 'Feature'],
  tags.flatMap((tag) => [
    `<tr class="group"><td colspan="4">${esc(tag)}</td></tr>`,
    ...ops
      .filter((o) => o.tag === tag)
      .map(
        (o) =>
          `<tr><td class="method m-${o.method.toLowerCase()}">${o.method}</td><td class="nowrap"><code>${esc(o.path)}</code></td><td>${esc(o.summary)}</td><td>${apis.has(`${o.method} ${o.path}`) ? refLink(ctx, PAGE, apis.get(`${o.method} ${o.path}`)!) : ''}</td></tr>`,
      ),
  ]),
  'ops',
)}
<h3>Pages (${routes.length})</h3>
${table(
  ['Route', 'Feature'],
  routes.map(
    (r) =>
      `<tr><td><code>${esc(r)}</code></td><td>${screens.has(r) ? refLink(ctx, PAGE, screens.get(r)!) : ''}</td></tr>`,
  ),
)}</section>`;

  const background = `<section id="background" aria-labelledby="background-h"><h2 id="background-h">Background work</h2>
<p class="note">Functions Inngest runs through <code>/api/inngest</code>. Every slow or external step happens here, never in a request.</p>
${table(
  ['Function', 'What it does'],
  functions.map(
    (id) =>
      `<tr><td class="nowrap"><code>${esc(id)}</code></td><td>${T(BACKGROUND[id] ?? '')}</td></tr>`,
  ),
)}</section>`;

  const settings = `<section id="settings" aria-labelledby="settings-h"><h2 id="settings-h">Environments and settings</h2>
${table(
  ['Environment', 'App', 'Database', 'Changes arrive'],
  [
    '<tr><td><b>Local</b></td><td><code>next dev</code></td><td>Postgres 16 in Docker (<code>pnpm db:up</code>), migrated by the tests</td><td>On save</td></tr>',
    '<tr><td><b>Preview</b></td><td>A Vercel preview for each push</td><td>Production’s, today (GAP-02)</td><td>On every push to a pull request</td></tr>',
    '<tr><td><b>Production</b></td><td>Vercel, <code>expensewise-theta.vercel.app</code></td><td>Supabase, Free plan</td><td>On merge, after migrations</td></tr>',
  ].map(T),
)}
<p class="note">Every setting the code or the pipeline reads. Values are never shown here or anywhere else.</p>
${table(
  ['Setting', 'Kind', 'Where it is set', 'Used for'],
  SETTINGS.map(
    (s) =>
      `<tr><td class="nowrap">${s.names.map((n) => `<code>${esc(n)}</code>`).join('<br>')}</td><td class="nowrap">${pill(`k-${s.kind.split(' ')[0]!.toLowerCase()}`, s.kind)}</td><td>${T(s.where)}</td><td class="wide">${T(s.use)}</td></tr>`,
  ),
)}</section>`;

  const delivery = `<section id="delivery" aria-labelledby="delivery-h"><h2 id="delivery-h">Delivery and gates</h2>
<p class="note">GitHub Actions is the only way a change reaches production. Jobs and triggers are read from each workflow file.</p>
${table(
  ['Workflow', 'Runs on', 'Jobs', 'What it is for'],
  workflows.map(
    (w) =>
      `<tr><td class="nowrap"><b>${esc(w.name)}</b><div class="sub"><code>${esc(w.file)}</code></div></td><td>${w.triggers.map(esc).join(', ')}</td><td>${w.jobs.map((j) => esc(j.name)).join('<br>')}</td><td class="wide">${T(WORKFLOWS[w.file] ?? '')}</td></tr>`,
  ),
)}</section>`;

  const quality = `<section id="quality" aria-labelledby="quality-h"><h2 id="quality-h">Quality attributes</h2>
${table(
  ['Attribute', 'How the architecture provides it', 'Where it falls short', 'Records'],
  QUALITY.map(
    (q) =>
      `<tr><td class="nowrap"><b>${esc(q.attribute)}</b></td><td class="wide">${T(q.how)}</td><td class="wide">${T(q.short)}</td><td>${refs(q.refs)}</td></tr>`,
  ),
)}</section>`;

  const risks = `<section id="risks" aria-labelledby="risks-h"><h2 id="risks-h">Risks and technical debt</h2>
<p class="note">The open gaps from the records, each with the backlog item that closes it. Read from <code>tools/records/src/tracing.ts</code>.</p>
${table(
  ['Gap', 'What is wrong', 'Severity', 'Closed by'],
  openGaps.map(
    (g) =>
      `<tr><td class="id">${refLink(ctx, PAGE, g.id)}</td><td class="wide">${T(g.title)}</td><td>${pill(`sv-${g.severity.toLowerCase()}`, g.severity)}</td><td>${refLink(ctx, PAGE, `#${g.backlog}`)}</td></tr>`,
  ),
)}</section>`;

  const inventory = `<section id="inventory" aria-labelledby="inventory-h"><h2 id="inventory-h">Inventory</h2>
<p class="note">Read from the repository when this page was built. Nothing here is written by hand.</p>
<h3>Tests</h3>
${table(
  ['Kind', 'Files', 'Tests'],
  tests.map(
    (t) =>
      `<tr><td>${esc(t.kind)}</td><td class="num">${t.files}</td><td class="num">${t.cases}</td></tr>`,
  ),
)}
<p class="note">Tests counted in the source; a parameterized test counts once. CI runs every one on every pull request.</p>
<h3>Migrations (${migrationTags.length})</h3>
<p>From <code>${esc(migrationTags[0] ?? '')}</code> to <code>${esc(migrationTags.at(-1) ?? '')}</code>. The schema they build is on the ${ctx.urls.dataModel ? ext(ctx.urls.dataModel, 'data model page') : 'data model page'}.</p>
<h3>Decision records (${decisions.length})</h3>
${table(
  ['Record', 'Decision', 'Status'],
  decisions.map(
    (a) =>
      `<tr><td class="id">${ext(githubFile(ctx, a.path), a.id, 'ref')}</td><td>${esc(a.title)}</td><td>${a.superseded ? pill('st-deferred', 'Superseded') : pill('st-verified', 'In force')}</td></tr>`,
  ),
)}</section>`;

  const toc = `<nav class="toc" aria-label="Contents"><p class="eyebrow">Contents</p><ol>
  <li><a href="#principles">Principles, as built</a></li>
  <li><a href="#context">System context</a></li>
  <li><a href="#packages">Packages</a></li>
  <li><a href="#flows">Key flows</a></li>
  <li><a href="#surface">API and pages</a></li>
  <li><a href="#background">Background work</a></li>
  <li><a href="#settings">Environments and settings</a></li>
  <li><a href="#delivery">Delivery and gates</a></li>
  <li><a href="#quality">Quality attributes</a></li>
  <li><a href="#risks">Risks and debt</a></li>
  <li><a href="#inventory">Inventory</a></li>
</ol></nav>`;

  const body = `<div class="page">
${hero}
<div class="layout">
${toc}
<main>
${principles}
${context}
${modules}
${flows}
${surface}
${background}
${settings}
${delivery}
${quality}
${risks}
${inventory}
</main>
</div>
<p class="foot">Built by <code>tools/records</code> at ${ext(githubCommit(ctx, ctx.recordsSha), `<code>${short(ctx.recordsSha)}</code>`)} and republished after each successful release. <code>git log ${ARCHITECTURE_SOURCE}</code> is the history of the written half; this page has none of its own.</p>
</div>`;

  return frame(ARCHITECTURE_TITLE, PAGES_CSS, body, '');
}

/** Shared by the architecture and data model pages. */
export const PAGES_CSS = `
.hero-text { display: grid; gap: 12px; min-width: 0; }
ul.changes { margin: 0; padding: 0; list-style: none; display: grid; gap: 4px; font-size: 0.92rem; }
.ch-added { background: var(--ok-wash); color: var(--ok); }
.ch-removed { background: var(--bad-wash); color: var(--bad); }
.ch-changed { background: var(--warn-wash); color: var(--warn); }
.ok { color: var(--ok); }
td.num { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; width: 1%; white-space: nowrap; }
td.deps { font-size: 0.84rem; min-width: 14rem; }
.ver { color: var(--ink-3); font-family: var(--mono); font-size: 0.8rem; }
tr.group td { background: var(--paper); font: 600 0.8rem/1.3 var(--display); letter-spacing: 0.02em; color: var(--ink-2); }
td.method { font: 600 0.74rem/1.4 var(--mono); letter-spacing: 0.04em; white-space: nowrap; width: 1%; }
.m-get { color: var(--ok); } .m-post { color: var(--carbon); } .m-put, .m-patch { color: var(--warn); } .m-delete { color: var(--bad); }
.k-secret { background: var(--bad-wash); color: var(--bad); }
.k-public { background: var(--carbon-wash); color: var(--carbon); }
.k-set, .k-constant { background: var(--quiet); color: var(--ink-2); }
.k-tooling { background: transparent; color: var(--ink-2); border-color: var(--rule-strong); }
.flow { display: grid; gap: 10px; }
h3 { margin-top: 6px; }
`;
