import {
  EXPENSE_STATUSES,
  REPORT_STATUSES,
  transitionExpense,
  transitionReport,
  type ExpenseEvent,
  type ReportEvent,
} from '@expensewise/domain';
import { DOMAINS, FUNCTIONS, ROLES, RULES, TABLES } from '../data-model.ts';
import {
  columnNotes,
  commitsTouching,
  fileAt,
  migrations,
  tableUse,
  type TableUse,
} from '../inventory.ts';
import { schemaChanges, schemaSnapshot, schemaSnapshotAt, type SnapshotTable } from '../schema.ts';
import { PAGES_CSS } from './architecture.ts';
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

const PAGE = 'data-model' as const;
export const DATA_MODEL_TITLE = 'ExpenseWise Data Model';
export const DATA_MODEL_SOURCE = 'tools/records/src/data-model.ts';

const USE: Record<TableUse, { label: string; cls: string }> = {
  written: { label: 'Written by the app', cls: 'u-written' },
  read: { label: 'Read, not yet written', cls: 'u-read' },
  unused: { label: 'Not used yet', cls: 'u-unused' },
};

/** Every transition the domain allows, found by trying each event on each status. */
function lifecycle<S extends string, E extends { type: string }>(
  statuses: readonly S[],
  events: readonly E[],
  next: (from: S, event: E) => S | undefined,
  first: S,
): string {
  const edges = new Map<string, Set<string>>();
  for (const from of statuses) {
    for (const event of events) {
      const to = next(from, event);
      if (to === undefined) continue;
      const key = `${from}|${to}`;
      edges.set(key, (edges.get(key) ?? new Set()).add(event.type.replace(/_/g, ' ')));
    }
  }
  const id = (s: string) => s.replace(/_/g, '');
  return [
    'stateDiagram-v2',
    '  direction LR',
    ...statuses.map((s) => `  state "${s.replace(/_/g, ' ')}" as ${id(s)}`),
    `  [*] --> ${id(first)}`,
    ...[...edges].map(([key, labels]) => {
      const [from, to] = key.split('|') as [string, string];
      return `  ${id(from)} --> ${id(to)}: ${[...labels].join(', ')}`;
    }),
  ].join('\n');
}

const EXPENSE_EVENTS: readonly ExpenseEvent[] = [
  { type: 'extraction_confident' },
  { type: 'extraction_unsure', reasons: ['x'] },
  { type: 'extraction_failed', reason: 'x' },
  { type: 'user_confirmed' },
  { type: 'report_submitted' },
  { type: 'report_returned' },
  { type: 'report_approved' },
  { type: 'settled' },
];
const REPORT_EVENTS: readonly ReportEvent[] = [
  { type: 'submit', itemCount: 1 },
  { type: 'route', steps: 1 },
  { type: 'auto_approve' },
  { type: 'step_approved', remainingSteps: 1 },
  { type: 'step_approved', remainingSteps: 0 },
  { type: 'return', comment: 'x' },
  { type: 'withdraw' },
  { type: 'settle' },
];

const keyColumns = (t: SnapshotTable) => {
  const fkColumns = new Set(t.foreignKeys.flatMap((k) => k.columns).filter((c) => c !== 'org_id'));
  return t.columns.filter(
    (c) =>
      t.primaryKey.includes(c.name) ||
      fkColumns.has(c.name) ||
      ['name', 'status', 'merchant', 'title'].includes(c.name),
  );
};

const mType = (type: string) =>
  type
    .replace(/timestamp with time zone/, 'timestamptz')
    .replace(/character\((\d+)\)/, 'char$1')
    .replace(/numeric\(.*\)/, 'numeric')
    .replace(/[^a-z0-9_]/gi, '_');
const mName = (table: string) => table.replace(/\./g, '_');

/** The relationship lines of an ER diagram, without the org_id link every table has. */
function relationships(tables: readonly SnapshotTable[], within: Set<string>): string[] {
  const lines: string[] = [];
  for (const t of tables) {
    for (const k of t.foreignKeys) {
      if (k.table === 'organizations' && k.columns.join() === 'org_id') continue;
      if (!within.has(t.name) && !within.has(k.table)) continue;
      const optional = k.columns.some(
        (c) => c !== 'org_id' && t.columns.find((x) => x.name === c)?.nullable,
      );
      const label = k.columns.filter((c) => c !== 'org_id').join(', ') || k.columns.join(', ');
      lines.push(`  ${mName(t.name)} }o--${optional ? 'o|' : '||'} ${mName(k.table)} : "${label}"`);
    }
  }
  return [...new Set(lines)];
}

function changesSection(ctx: PageContext, T: (s: string) => string): string {
  if (!ctx.release) return '';
  const since = ctx.release.since;
  const before = schemaSnapshotAt(since);
  const revised = commitsTouching(since, ctx.recordsSha, DATA_MODEL_SOURCE);
  const notes = !fileAt(since, DATA_MODEL_SOURCE)
    ? '<p>First edition: the written half is new in this release.</p>'
    : revised.length
      ? `<p>The written half was revised in ${revised.length} ${revised.length === 1 ? 'commit' : 'commits'}: ${revised.map((c) => `${ext(githubCommit(ctx, c.sha), `<code>${short(c.sha)}</code>`)} ${T(c.subject)}`).join('; ')}.</p>`
      : '<p>The written half needed no revision in this release.</p>';
  if (!before) {
    return `<div class="callout" role="status"><p class="eyebrow">Changed in this release</p><p>First edition: the release at ${ext(githubCommit(ctx, since), `<code>${short(since)}</code>`)} had no schema snapshot to compare with. From the next release on, this box lists every table, column, constraint, policy and function added, changed or removed.</p>${notes}</div>`;
  }
  const changes = schemaChanges(before, schemaSnapshot());
  return `<div class="callout" role="status"><p class="eyebrow">Changed in this release</p>
<p class="note">Since ${ext(githubCommit(ctx, since), `<code>${short(since)}</code>`)}, compared snapshot to snapshot.</p>
${
  changes.length
    ? `<ul class="changes">${changes.map((c) => `<li>${pill(`ch-${c.kind}`, c.kind[0]!.toUpperCase() + c.kind.slice(1))} <code>${esc(c.what)}</code> <span class="note">${esc(c.detail)}</span></li>`).join('')}</ul>`
    : '<p>The schema did not change.</p>'
}
${notes}</div>`;
}

export function renderDataModel(ctx: PageContext): string {
  const T = (text: string) => inline(ctx, PAGE, text);
  const refs = (ids: readonly string[]) =>
    ids.length
      ? `<span class="refs">${ids.map((id) => refLink(ctx, PAGE, id)).join(' ')}</span>`
      : '';
  const snapshot = schemaSnapshot();
  const notes = columnNotes();
  const use = tableUse();
  const migrationTags = migrations();
  const tables = snapshot.tables;
  const byName = new Map(tables.map((t) => [t.name, t]));
  const domainOf = new Map(DOMAINS.flatMap((d) => d.tables.map((t) => [t, d.name] as const)));
  const fkCount = tables.reduce((n, t) => n + t.foreignKeys.length, 0);
  const policyCount = tables.reduce((n, t) => n + t.policies.length, 0);
  const checkCount = tables.reduce((n, t) => n + t.checks.length + t.uniques.length, 0);
  const anchor = (table: string) => `t-${table.replace(/\./g, '-')}`;
  const tableLink = (table: string) =>
    byName.has(table)
      ? `<a class="tref" href="#${anchor(table)}">${esc(table)}</a>`
      : `<code>${esc(table)}</code>`;

  const hero = `<header class="hero">
  <p class="eyebrow">ExpenseWise · Data model</p>
  ${draftBanner(ctx)}
  <div class="hero-top">
    <div class="hero-text">
      <h1>Data model</h1>
      <p class="meta">The schema the migrations build, as live in production at ${ext(githubCommit(ctx, ctx.productionSha), `<code>${short(ctx.productionSha)}</code>`)} · ${esc(ctx.date)}</p>
      <p class="lede">Postgres on Supabase. Every tenant row belongs to one organization, and row-level security, forced on every tenant table, decides who sees it. Money is integer minor units beside a currency code. The diagrams, tables and counts are read from ${ext(githubFile(ctx, 'packages/db/schema.json'), '<code>packages/db/schema.json</code>')}, a snapshot of the database’s own catalog that the integration tests keep identical to what the migrations build.</p>
      <p class="source">Descriptions are in ${ext(githubFile(ctx, DATA_MODEL_SOURCE), `<code>${DATA_MODEL_SOURCE}</code>`)}; column notes come from the comments in <code>packages/db/src/schema.ts</code>. A test fails when a table or function has no description, or a rule names something the schema lacks.${ctx.urls.architecture ? ` How the app around it is built: ${ext(ctx.urls.architecture, 'technical architecture')}.` : ''}</p>
    </div>
    ${slip(
      'Schema sheet',
      [
        { label: 'Tables', value: tables.length },
        {
          label: 'Written by the app',
          value: [...use.values()].filter((u) => u === 'written').length,
          sub: true,
        },
        { label: 'Foreign keys', value: fkCount },
        { label: 'Checks and uniques', value: checkCount },
        { label: 'Security policies', value: policyCount },
        { label: 'Enums', value: snapshot.enums.length },
        { label: 'Functions', value: snapshot.functions.length },
        { label: 'Migrations', value: migrationTags.length },
      ],
      `${esc(short(ctx.recordsSha))} · ${esc(ctx.date)}`,
    )}
  </div>
  ${changesSection(ctx, T)}
</header>`;

  // The whole model: every table and how they connect, no columns.
  const overview = [
    'erDiagram',
    ...tables.map((t) => `  ${mName(t.name)} {\n    uuid ${t.primaryKey[0] ?? 'id'} PK\n  }`),
    ...relationships(tables, new Set(tables.map((t) => t.name))),
  ].join('\n');
  const picture = `<section id="picture" aria-labelledby="picture-h"><h2 id="picture-h">The model in one picture</h2>
<p class="note">Every table and every reference between them. Each tenant table also references <code>organizations</code> through <code>org_id</code>; those lines are left out so the rest can be read.</p>
${mermaid(overview, 'Every table and the references between them')}
${table(
  ['Domain', 'What it holds', 'Tables'],
  DOMAINS.map(
    (d) =>
      `<tr><td class="nowrap"><a href="#d-${d.name.toLowerCase().replace(/\W+/g, '-')}"><b>${esc(d.name)}</b></a></td><td>${T(d.about)}</td><td>${d.tables.map(tableLink).join(' · ')}</td></tr>`,
  ),
)}</section>`;

  const domains = `<section id="domains" aria-labelledby="domains-h"><h2 id="domains-h">Domains</h2>
<p class="note">Each diagram draws a domain’s tables with their keys, and names the tables they reach in other domains.</p>
${DOMAINS.map((d) => {
  const mine = d.tables.map((t) => byName.get(t)).filter((t): t is SnapshotTable => Boolean(t));
  const within = new Set(d.tables);
  const er = [
    'erDiagram',
    ...mine.map(
      (t) =>
        `  ${mName(t.name)} {\n${keyColumns(t)
          .map((c) => {
            const keys = [
              t.primaryKey.includes(c.name) ? 'PK' : '',
              t.foreignKeys.some((k) => k.columns.includes(c.name) && c.name !== 'org_id')
                ? 'FK'
                : '',
            ].filter(Boolean);
            return `    ${mType(c.type)} ${c.name}${keys.length ? ` ${keys.join(', ')}` : ''}`;
          })
          .join('\n')}\n  }`,
    ),
    ...relationships(tables, within),
  ].join('\n');
  return `<div class="domain" id="d-${d.name.toLowerCase().replace(/\W+/g, '-')}"><h3>${esc(d.name)}</h3><p>${T(d.about)}</p>${mermaid(er, `${d.name}: tables and keys`)}</div>`;
}).join('\n')}</section>`;

  const referencedBy = (name: string) =>
    tables.filter((t) => t.foreignKeys.some((k) => k.table === name)).map((t) => t.name);

  const tableBlock = (t: SnapshotTable) => {
    const note = TABLES[t.name];
    const u = use.get(t.name);
    const usePill = u ? pill(USE[u].cls, USE[u].label) : pill('u-other', 'Written outside the app');
    const rls = t.rls.forced
      ? pill('rls-forced', 'Row-level security, forced')
      : t.rls.enabled
        ? pill('rls-on', 'Row-level security on')
        : pill('rls-off', 'No row-level security');
    const colNotes = notes.get(t.name);
    const fkFor = (column: string) =>
      t.foreignKeys
        .filter((k) => k.columns.includes(column) && !(column === 'org_id' && k.columns.length > 1))
        .map((k) => tableLink(k.table))
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(' ');
    const columns = table(
      ['Column', 'Type', 'Null', 'Default', 'References', 'Note'],
      t.columns.map(
        (c) =>
          `<tr><td class="nowrap"><code>${esc(c.name)}</code>${t.primaryKey.includes(c.name) ? ' <span class="key">PK</span>' : ''}</td><td class="nowrap type">${esc(c.type)}</td><td class="nowrap">${c.nullable ? '' : 'not null'}</td><td class="type">${c.default ? `<code>${esc(c.default)}</code>` : ''}</td><td>${fkFor(c.name)}</td><td>${colNotes?.get(c.name) ? T(colNotes.get(c.name)!) : ''}</td></tr>`,
      ),
      'columns',
    );
    const list = (label: string, items: readonly string[]) =>
      items.length
        ? `<div class="objects"><p class="eyebrow">${esc(label)} (${items.length})</p><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul></div>`
        : '';
    const by = referencedBy(t.name);
    const grants = Object.entries(t.grants);
    return `<article class="tbl" id="${anchor(t.name)}" data-row data-tags="${esc(domainOf.get(t.name) ?? '')}">
<div class="tbl-head"><h3><code>${esc(t.name)}</code></h3><span class="pills">${usePill} ${rls}</span></div>
<p>${T(note?.about ?? '')}</p>
${note?.writtenBy ? `<p class="note">Written by: ${T(note.writtenBy)}</p>` : ''}
${columns}
<div class="object-grid">
${list(
  'Unique',
  t.uniques.map((k) => `<code>${esc(k.name)}</code> on (${k.columns.map(esc).join(', ')})`),
)}
${list(
  'Checks',
  t.checks.map((k) => `<code>${esc(k.name)}</code><div class="def">${esc(k.definition)}</div>`),
)}
${list(
  'Indexes',
  t.indexes.map(
    (k) =>
      `<code>${esc(k.name)}</code><div class="def">${esc(k.definition.replace(/^CREATE (UNIQUE )?INDEX \S+ ON (public\.)?/, ''))}</div>`,
  ),
)}
${list(
  'Security policies',
  t.policies.map(
    (p) =>
      `<code>${esc(p.name)}</code> · ${esc(p.command)}${p.using ? `<div class="def">using ${esc(p.using)}</div>` : ''}${p.check && p.check !== p.using ? `<div class="def">check ${esc(p.check)}</div>` : ''}`,
  ),
)}
${list(
  'Triggers',
  t.triggers.map(
    (k) =>
      `<code>${esc(k.name)}</code><div class="def">${esc(k.definition.replace(/^CREATE TRIGGER \S+ /, '').replace(/ ON public\./, ' ON '))}</div>`,
  ),
)}
${list('Rights', grants.length ? grants.map(([role, privileges]) => `<code>${esc(role)}</code>: ${privileges.map((p) => esc(p.toLowerCase())).join(', ')}`) : ['None: only the schema owner reaches it'])}
</div>
${by.length ? `<p class="note">Referenced by ${by.map(tableLink).join(', ')}</p>` : ''}
</article>`;
  };

  const tableSection = `<section id="tables" aria-labelledby="tables-h"><h2 id="tables-h">Tables</h2>
<div class="filterbar" role="search">
  <label for="q" class="sr">Filter tables</label>
  <input id="q" type="search" placeholder="Filter tables: a table, a column, a policy…" autocomplete="off">
  <div class="chips" role="group" aria-label="Show tables by domain">${['All', ...DOMAINS.map((d) => d.name)].map((f) => `<button type="button" class="chip${f === 'All' ? ' on' : ''}" data-filter="${esc(f)}" aria-pressed="${f === 'All'}">${esc(f)}</button>`).join('')}</div>
  <p id="count" class="note count" aria-live="polite" data-noun="tables"></p>
</div>
${DOMAINS.flatMap((d) =>
  d.tables.map((t) => byName.get(t)).filter((t): t is SnapshotTable => Boolean(t)),
)
  .map(tableBlock)
  .join('\n')}
</section>`;

  const lifecycles = `<section id="lifecycles" aria-labelledby="lifecycles-h"><h2 id="lifecycles-h">Lifecycles</h2>
<p class="note">Drawn by trying every event on every status with the domain’s own transition rules (<code>@expensewise/domain</code>), so the diagram is what the code allows.</p>
<h3>Expense</h3>
${mermaid(
  lifecycle(
    EXPENSE_STATUSES,
    EXPENSE_EVENTS,
    (from, e) => {
      const r = transitionExpense(from, e);
      return r.ok ? r.value : undefined;
    },
    'processing',
  ),
  'The statuses an expense moves through',
)}
<p class="note">An expense also follows its receipt while it is read (ADR-0022), and a person’s edits keep it in Needs review or Ready (FR-EXP-09).</p>
<h3>Report</h3>
${mermaid(
  lifecycle(
    REPORT_STATUSES,
    REPORT_EVENTS,
    (from, e) => {
      const r = transitionReport(from, e);
      return r.ok ? r.value : undefined;
    },
    'open',
  ),
  'The statuses a report moves through',
)}
<p class="note">Reports have rules but no screens yet (#23, #24).</p></section>`;

  const enumUse = (name: string) =>
    tables.flatMap((t) =>
      t.columns.filter((c) => c.type === name).map((c) => `${t.name}.${c.name}`),
    );
  const enums = `<section id="enums" aria-labelledby="enums-h"><h2 id="enums-h">Enums</h2>
${table(
  ['Type', 'Values, in order', 'Used by'],
  snapshot.enums.map(
    (e) =>
      `<tr><td class="nowrap"><code>${esc(e.name)}</code></td><td>${e.values.map((v) => `<span class="val">${esc(v)}</span>`).join(' ')}</td><td>${
        enumUse(e.name)
          .map((c) => `<code>${esc(c)}</code>`)
          .join(' ') || '<span class="note">nothing yet</span>'
      }</td></tr>`,
  ),
)}</section>`;

  const functions = `<section id="functions" aria-labelledby="functions-h"><h2 id="functions-h">Functions</h2>
<p class="note">A function that runs as its owner (definer) is the only way past row-level security, so each one is granted to exactly the role that needs it.</p>
${table(
  ['Function', 'Returns', 'Runs as', 'Callable by', 'What it does'],
  snapshot.functions.map(
    (f) =>
      `<tr><td class="nowrap"><code>${esc(f.name)}(${esc(f.arguments)})</code></td><td class="type">${esc(f.returns)}</td><td class="nowrap">${f.security === 'definer' ? pill('rls-forced', 'its owner') : pill('rls-on', 'the caller')} <span class="note">${esc(f.volatility)}</span></td><td>${f.executableBy.map((r) => `<code>${esc(r)}</code>`).join(' ') || '<span class="note">the owner only</span>'}</td><td class="wide">${T(FUNCTIONS[f.name] ?? '')}</td></tr>`,
  ),
)}</section>`;

  const rules = `<section id="rules" aria-labelledby="rules-h"><h2 id="rules-h">Business rules</h2>
<p class="note">What must always hold, and what enforces it. Every object named here exists in the schema, or the build fails.</p>
${table(
  ['Rule', 'How it holds', 'Enforced by', 'Records'],
  RULES.map(
    (r) =>
      `<tr><td class="wide"><b>${T(r.rule)}</b></td><td class="wide">${T(r.mechanism)}</td><td>${r.objects.map((o) => `<code>${esc(o)}</code>`).join('<br>') || pill('sv-medium', 'Application only')}</td><td>${refs(r.refs)}</td></tr>`,
  ),
)}</section>`;

  const roles = [
    ...new Set([
      ...snapshot.roles.map((r) => r.name),
      ...tables.flatMap((t) => Object.keys(t.grants)),
    ]),
  ].sort();
  const short3 = (p: string) =>
    ({
      SELECT: 'read',
      INSERT: 'add',
      UPDATE: 'change',
      DELETE: 'delete',
      TRUNCATE: 'truncate',
      REFERENCES: 'refer',
      TRIGGER: 'trigger',
    })[p] ?? p.toLowerCase();
  const security = `<section id="security" aria-labelledby="security-h"><h2 id="security-h">Security model</h2>
<p>Row-level security is on for every table and forced on every tenant table, so even the table owner’s queries obey it. A tenant policy compares <code>org_id</code> with <code>app_current_org()</code>, which the API sets per transaction from the caller’s membership; with nothing set, no row matches. Supabase’s Data API roles have no rights at all: the API is the only way in (ADR-0013). Every release takes back anything they hold, because a restore into a new project hands them every table again.</p>
${table(
  ['Role', 'Bypasses row-level security', 'What it is'],
  roles.map((r) => {
    const info = snapshot.roles.find((x) => x.name === r);
    return `<tr><td class="nowrap"><code>${esc(r)}</code></td><td>${info ? (info.bypassRls || info.superuser ? pill('sv-high', 'Yes') : pill('st-verified', 'No')) : '<span class="note">Supabase’s</span>'}</td><td class="wide">${T(ROLES[r] ?? '')}</td></tr>`;
  }),
)}
<h3>Rights by table</h3>
${table(
  ['Table', ...roles],
  tables.map(
    (t) =>
      `<tr><td class="nowrap">${tableLink(t.name)}</td>${roles.map((r) => `<td class="rights">${(t.grants[r] ?? []).map(short3).join(', ') || '<span class="none">—</span>'}</td>`).join('')}</tr>`,
  ),
  'rights',
)}</section>`;

  const local = `<section id="local" aria-labelledby="local-h"><h2 id="local-h">Local verification</h2>
<pre class="cmd"><code>pnpm db:up                 # Postgres 16 in Docker; prints DATABASE_URL
pnpm test:integration      # every migration on a fresh database, then the tests, the snapshot among them
pnpm db:snapshot           # after a migration: rewrite packages/db/schema.json, then commit it
pnpm contract:check        # the Drizzle schema and the migrations agree</code></pre></section>`;

  const toc = `<nav class="toc" aria-label="Contents"><p class="eyebrow">Contents</p><ol>
  <li><a href="#picture">The model in one picture</a></li>
  <li><a href="#domains">Domains</a></li>
  <li><a href="#tables">Tables (${tables.length})</a></li>
  <li><a href="#lifecycles">Lifecycles</a></li>
  <li><a href="#enums">Enums</a></li>
  <li><a href="#functions">Functions</a></li>
  <li><a href="#rules">Business rules</a></li>
  <li><a href="#security">Security model</a></li>
  <li><a href="#local">Local verification</a></li>
</ol></nav>`;

  const body = `<div class="page">
${hero}
<div class="layout">
${toc}
<main>
${picture}
${domains}
${tableSection}
${lifecycles}
${enums}
${functions}
${rules}
${security}
${local}
</main>
</div>
<p class="foot">Built by <code>tools/records</code> at ${ext(githubCommit(ctx, ctx.recordsSha), `<code>${short(ctx.recordsSha)}</code>`)} from ${migrationTags.length} migrations, and republished after each successful release. The migrations are the schema; <code>git log packages/db/schema.json</code> is its history.</p>
</div>`;

  return frame(DATA_MODEL_TITLE, PAGES_CSS + DATA_MODEL_CSS, body, TABLE_FILTER_SCRIPT);
}

const TABLE_FILTER_SCRIPT = `
(function () {
  var q = document.getElementById("q");
  if (!q) return;
  var chips = Array.prototype.slice.call(document.querySelectorAll(".chip"));
  var rows = Array.prototype.slice.call(document.querySelectorAll("[data-row]"));
  var count = document.getElementById("count");
  var mode = "All";
  function apply() {
    var term = q.value.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (r) {
      var ok = (mode === "All" || r.getAttribute("data-tags") === mode) && (!term || r.textContent.toLowerCase().indexOf(term) !== -1);
      r.hidden = !ok;
      if (ok) shown++;
    });
    count.textContent = shown === rows.length ? "Showing all " + rows.length + " tables" : "Showing " + shown + " of " + rows.length + " tables";
  }
  chips.forEach(function (c) {
    c.addEventListener("click", function () {
      mode = c.getAttribute("data-filter");
      chips.forEach(function (x) { var on = x === c; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); });
      apply();
    });
  });
  q.addEventListener("input", apply);
  function reveal() {
    var t = location.hash && document.getElementById(location.hash.slice(1));
    if (t && t.hidden) { q.value = ""; mode = "All"; chips.forEach(function (x) { var on = x.getAttribute("data-filter") === "All"; x.classList.toggle("on", on); x.setAttribute("aria-pressed", String(on)); }); apply(); t.scrollIntoView(); }
  }
  window.addEventListener("hashchange", reveal);
  apply();
  reveal();
})();
`;

const DATA_MODEL_CSS = `
.domain { display: grid; gap: 10px; }
a.tref { font-family: var(--mono); font-size: 0.86em; text-decoration: none; border-bottom: 1px dotted currentColor; white-space: nowrap; }
.tbl { display: grid; gap: 12px; padding: 18px; background: var(--sheet); border: 1px solid var(--rule); border-radius: 8px; scroll-margin-top: 96px; min-width: 0; }
.tbl .table-wrap { background: var(--paper); }
.tbl-head { display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline; justify-content: space-between; }
.tbl-head h3 { margin: 0; font-size: 1.2rem; }
.tbl-head h3 code { background: transparent; padding: 0; font-size: 1em; font-weight: 600; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.u-written { background: var(--ok-wash); color: var(--ok); }
.u-read { background: var(--carbon-wash); color: var(--carbon); }
.u-unused { background: transparent; color: var(--ink-2); border-color: var(--rule-strong); }
.u-other { background: var(--quiet); color: var(--ink-2); }
.rls-forced { background: var(--carbon-wash); color: var(--carbon); }
.rls-on { background: var(--quiet); color: var(--ink-2); }
.rls-off { background: var(--bad-wash); color: var(--bad); }
.key { font: 600 0.66rem/1 var(--mono); color: var(--carbon); border: 1px solid var(--carbon); border-radius: 3px; padding: 1px 3px; vertical-align: 1px; }
td.type { font-family: var(--mono); font-size: 0.8rem; color: var(--ink-2); }
table.columns td { padding: 7px 10px; }
.object-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: 12px 20px; align-items: start; }
.objects { display: grid; gap: 6px; min-width: 0; align-content: start; }
.objects ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; font-size: 0.86rem; }
.def { font: 400 0.78rem/1.45 var(--mono); color: var(--ink-2); overflow-wrap: anywhere; margin-top: 2px; }
.val { display: inline-block; font: 500 0.78rem/1.4 var(--mono); background: var(--quiet); border-radius: 3px; padding: 1px 6px; margin: 1px 0; }
table.rights td.rights { font-size: 0.82rem; white-space: nowrap; }
.none { color: var(--rule-strong); }
pre.cmd { margin: 0; background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 14px 16px; overflow-x: auto; font: 400 0.84rem/1.6 var(--mono); }
pre.cmd code { background: transparent; padding: 0; font-size: 1em; }
`;
