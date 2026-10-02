import { adrs } from '../repo.ts';

/** What a page needs to know about where it is published and what is live. */
export interface PageContext {
  /** owner/name on GitHub. */
  readonly repo: string;
  /** The commit the records were read from. */
  readonly recordsSha: string;
  /** The commit production serves. */
  readonly productionSha: string;
  /** The day of the release, YYYY-MM-DD. */
  readonly date: string;
  /** Published page URLs, for links between the two pages. */
  readonly urls: { readonly traceability?: string; readonly backlog?: string };
  /** Set while the records are still in review: says so on the page. */
  readonly draft?: string;
  /** Commits in this release, newest first, for the backlog page. */
  readonly release?: {
    readonly since: string;
    readonly commits: readonly { readonly sha: string; readonly subject: string }[];
  };
}

export type PageKind = 'traceability' | 'backlog';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

export const short = (sha: string) => sha.slice(0, 7);
export const githubFile = (ctx: PageContext, path: string) =>
  `https://github.com/${ctx.repo}/blob/${ctx.recordsSha}/${path}`;
export const githubCommit = (ctx: PageContext, sha: string) =>
  `https://github.com/${ctx.repo}/commit/${sha}`;
export const githubPull = (ctx: PageContext, n: number) =>
  `https://github.com/${ctx.repo}/pull/${n}`;

export const ext = (href: string, label: string, cls = '') =>
  `<a href="${esc(href)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${label}</a>`;

/** A link to a record: on this page an anchor, on the other page its URL, else plain text. */
export function refLink(ctx: PageContext, page: PageKind, id: string): string {
  if (/^ADR-\d{4}$/.test(id)) {
    const adr = adrs().find((a) => a.id === id);
    return adr ? ext(githubFile(ctx, adr.path), id, 'ref') : esc(id);
  }
  const backlog = /^#(\d+)$/.exec(id);
  const anchor = backlog ? `item-${backlog[1]}` : id;
  const home: PageKind = backlog ? 'backlog' : 'traceability';
  if (home === page) return `<a class="ref" href="#${anchor}">${esc(id)}</a>`;
  const url = ctx.urls[home];
  return url ? ext(`${url}#${anchor}`, esc(id), 'ref') : `<span class="ref">${esc(id)}</span>`;
}

const TOKENS =
  /PR #(\d+)|(?<![&\w])#(\d+)\b|\b((?:NFR|FR)-[A-Z]+-\d{2}|F-\d{2}|GAP-\d{2}|BO-\d+|Q\d+|ADR-\d{4})\b|\*\*([^*]+)\*\*/g;

/** Free text to HTML: `code`, **bold**, PR #n, #n and record ids become links. */
export function inline(ctx: PageContext, page: PageKind, text: string): string {
  return text
    .split('`')
    .map((part, i) => {
      if (i % 2 === 1) return `<code>${esc(part)}</code>`;
      return esc(part).replace(TOKENS, (_m, pr: string, item: string, id: string, bold: string) =>
        pr
          ? ext(githubPull(ctx, Number(pr)), `PR #${pr}`)
          : item
            ? refLink(ctx, page, `#${item}`)
            : id
              ? refLink(ctx, page, id)
              : `<b>${bold}</b>`,
      );
    })
    .join('');
}

export const pill = (cls: string, label: string) =>
  `<span class="pill ${cls}">${esc(label)}</span>`;

export const statusClass = (status: string) => `st-${status.toLowerCase().replace(/\s+/g, '-')}`;

const FONTS =
  'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap';

/**
 * ExpenseWise's own tokens (apps/web/app/globals.css), with the washes a status page needs.
 * Layout: a contents rail beside one reading column; wide tables scroll inside it.
 */
export const BASE_CSS = `
:root {
  --paper: #f4f6f3; --sheet: #ffffff; --ink: #131b19; --ink-2: #4a5653; --ink-3: #5f6a66;
  --rule: #dce1dc; --rule-strong: #b3bdb7;
  --carbon: #2d43c2; --carbon-ink: #ffffff; --carbon-wash: #e8ebfb;
  --ok: #1d7849; --ok-wash: #dff1e6; --warn: #9a5800; --warn-wash: #f8ebd5;
  --bad: #b42318; --bad-wash: #f9e0dc; --quiet: #e9ece9;
  --display: "IBM Plex Sans Condensed", "IBM Plex Sans", "Arial Narrow", Arial, sans-serif;
  --body: "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --paper: #0d1211; --sheet: #151c1a; --ink: #e4eae7; --ink-2: #a7b2ae; --ink-3: #8b9793;
  --rule: #253029; --rule-strong: #3d4a44;
  --carbon: #9aa7ff; --carbon-ink: #0d1211; --carbon-wash: #1c2242;
  --ok: #4fc48c; --ok-wash: #13291d; --warn: #e6a640; --warn-wash: #33260f;
  --bad: #f2786d; --bad-wash: #3a1714; --quiet: #1b2321; color-scheme: dark; } }
:root[data-theme="dark"] {
  --paper: #0d1211; --sheet: #151c1a; --ink: #e4eae7; --ink-2: #a7b2ae; --ink-3: #8b9793;
  --rule: #253029; --rule-strong: #3d4a44;
  --carbon: #9aa7ff; --carbon-ink: #0d1211; --carbon-wash: #1c2242;
  --ok: #4fc48c; --ok-wash: #13291d; --warn: #e6a640; --warn-wash: #33260f;
  --bad: #f2786d; --bad-wash: #3a1714; --quiet: #1b2321; color-scheme: dark; }
*, *::before, *::after { box-sizing: border-box; }
body { background: var(--paper); color: var(--ink); font: 400 16px/1.55 var(--body); }
.page { max-width: 1280px; margin: 0 auto; padding-inline: 20px; padding-block: 32px 64px; display: grid; gap: 32px; }
a { color: var(--carbon); text-underline-offset: 2px; }
:focus-visible { outline: 2px solid var(--carbon); outline-offset: 2px; border-radius: 3px; }
code { font-family: var(--mono); font-size: 0.84em; background: var(--quiet); padding: 0.05em 0.35em; border-radius: 3px; overflow-wrap: anywhere; }
h1, h2, h3 { font-family: var(--display); color: var(--ink); text-wrap: balance; margin: 0; letter-spacing: -0.005em; }
h1 { font-size: clamp(1.9rem, 4.2vw, 2.7rem); font-weight: 700; line-height: 1.06; }
h2 { font-size: 1.5rem; font-weight: 700; line-height: 1.2; }
h3 { font-size: 1.12rem; font-weight: 600; line-height: 1.3; }
p { margin: 0; max-width: 72ch; }
.eyebrow { font: 500 0.74rem/1.2 var(--mono); letter-spacing: 0.09em; text-transform: uppercase; color: var(--ink-3); margin: 0; }
.meta, .note, .source { color: var(--ink-2); font-size: 0.92rem; }
.lede { font-size: 1.08rem; max-width: 68ch; }
.hero { display: grid; gap: 14px; }
.hero-top { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px 40px; align-items: start; }
.layout { display: grid; grid-template-columns: 200px minmax(0, 1fr); gap: 36px; align-items: start; }
.toc { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 16px); display: grid; gap: 8px; }
.toc ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; border-left: 2px solid var(--rule); }
.toc a { display: block; padding: 3px 0 3px 12px; color: var(--ink); text-decoration: none; font-size: 0.93rem; }
.toc a:hover { color: var(--carbon); }
main { display: grid; gap: 40px; min-width: 0; }
section { display: grid; gap: 14px; min-width: 0; scroll-margin-top: 96px; }
section > ul, section > ol { margin: 0; padding-left: 1.2em; display: grid; gap: 6px; max-width: 76ch; }
.table-wrap { position: relative; overflow-x: auto; border: 1px solid var(--rule); border-radius: 6px; background: var(--sheet); }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th, td { text-align: left; vertical-align: top; padding: 9px 11px; border-bottom: 1px solid var(--rule); }
tbody tr:last-child td { border-bottom: 0; }
th { font: 500 0.7rem/1.2 var(--mono); letter-spacing: 0.07em; text-transform: uppercase; color: var(--ink-3); background: var(--paper); white-space: nowrap; }
tr:target td { background: var(--warn-wash); }
tr[id] { scroll-margin-top: 120px; }
td.id { font-family: var(--mono); font-weight: 500; white-space: nowrap; color: var(--carbon); }
td.wide { min-width: 18rem; }
td.nowrap { white-space: nowrap; }
.sub { color: var(--ink-2); font-size: 0.84rem; margin-top: 4px; max-width: none; }
a.ref, span.ref { font-family: var(--mono); font-size: 0.86em; text-decoration: none; border-bottom: 1px dotted currentColor; white-space: nowrap; }
span.ref { color: var(--ink-2); }
.refs { display: flex; flex-wrap: wrap; gap: 3px 8px; }
.pill { display: inline-block; font-size: 0.75rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; border: 1px solid transparent; }
.st-verified { background: var(--ok-wash); color: var(--ok); }
.st-implemented { background: var(--carbon-wash); color: var(--carbon); }
.st-partial { background: var(--warn-wash); color: var(--warn); }
.st-planned { background: transparent; color: var(--ink-2); border-color: var(--rule-strong); }
.st-in-review { background: transparent; color: var(--carbon); border: 1px dashed var(--carbon); }
.st-deferred { background: var(--quiet); color: var(--ink-3); }
.sv-high { background: var(--bad-wash); color: var(--bad); }
.sv-medium { background: var(--warn-wash); color: var(--warn); }
.sv-low { background: var(--quiet); color: var(--ink-2); }
.chk { font-family: var(--mono); font-size: 0.8rem; white-space: nowrap; }
.filterbar { position: sticky; top: env(safe-area-inset-top, 0px); z-index: 2; background: var(--paper); padding-block: 10px; border-bottom: 1px solid var(--rule); display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
.filterbar input { flex: 1 1 240px; min-width: 0; font: inherit; font-size: 0.95rem; padding: 8px 12px; border: 1px solid var(--rule-strong); border-radius: 6px; background: var(--sheet); color: var(--ink); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font: inherit; font-size: 0.85rem; padding: 5px 11px; border-radius: 999px; border: 1px solid var(--rule-strong); background: var(--sheet); color: var(--ink); cursor: pointer; }
.chip.on { background: var(--carbon); color: var(--carbon-ink); border-color: var(--carbon); }
.count { flex-basis: 100%; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.slip { background: var(--sheet); border: 1px solid var(--rule); border-bottom: 0; padding: 16px 18px 22px; min-width: 17rem; font: 400 0.86rem/1.5 var(--mono); position: relative; margin: 0;
  -webkit-mask: conic-gradient(from 135deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) bottom/12px 7px repeat-x, linear-gradient(#000 0 0) top/100% calc(100% - 6px) no-repeat;
  mask: conic-gradient(from 135deg at bottom, #0000, #000 1deg 89deg, #0000 90deg) bottom/12px 7px repeat-x, linear-gradient(#000 0 0) top/100% calc(100% - 6px) no-repeat; }
.slip dl { margin: 0; display: grid; gap: 1px; }
.slip-head { text-align: center; letter-spacing: 0.12em; text-transform: uppercase; color: var(--ink-2); font-size: 0.74rem; padding-bottom: 8px; margin-bottom: 8px; border-bottom: 1px dashed var(--rule-strong); }
.slip-row { display: flex; align-items: baseline; gap: 6px; }
.slip-row dt { white-space: nowrap; }
.slip-row.sub-row dt { padding-left: 1.2em; color: var(--ink-2); }
.slip-row::after { content: ""; order: 1; flex: 1; border-bottom: 1px dotted var(--rule-strong); transform: translateY(-4px); min-width: 1.5em; }
.slip-row dd { order: 2; margin: 0; font-weight: 500; font-variant-numeric: tabular-nums; }
.slip-foot { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--rule-strong); font-size: 0.74rem; color: var(--ink-2); text-align: center; }
.callout { background: var(--sheet); border: 1px solid var(--rule); border-left: 4px solid var(--carbon); border-radius: 6px; padding: 12px 16px; display: grid; gap: 6px; max-width: 82ch; }
.callout.warn { border-left-color: var(--warn); }
.defs { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 20px; margin: 0; max-width: 84ch; }
.defs dt { font-weight: 600; }
.defs dd { margin: 0; color: var(--ink-2); }
.foot { border-top: 1px solid var(--rule); padding-top: 16px; color: var(--ink-2); font-size: 0.88rem; max-width: none; }
@media (max-width: 900px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .toc { position: static; }
  .toc ol { grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); border-left: 0; }
  .toc a { padding-left: 0; }
  .hero-top { grid-template-columns: minmax(0, 1fr); }
}
@media (max-width: 700px) {
  .page { padding-inline: 16px; padding-block: 22px 48px; }
  .defs { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .defs dd { margin-bottom: 8px; }
  .slip { min-width: 0; }
}
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
`;

export function frame(title: string, css: string, body: string, script: string): string {
  return [
    `<title>${esc(title)}</title>`,
    '<link rel="preconnect" href="https://fonts.googleapis.com">',
    '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>',
    `<link rel="stylesheet" href="${FONTS}">`,
    `<style>${BASE_CSS}${css}</style>`,
    body,
    `<script>${script}</script>`,
    '',
  ].join('\n');
}

/** The shared filter: a search box and chips over rows that carry data-filter values. */
export const FILTER_SCRIPT = `
(function () {
  var q = document.getElementById("q");
  if (!q) return;
  var chips = Array.prototype.slice.call(document.querySelectorAll(".chip"));
  var rows = Array.prototype.slice.call(document.querySelectorAll("[data-row]"));
  var count = document.getElementById("count");
  var noun = count.getAttribute("data-noun");
  var mode = "All";
  function apply() {
    var term = q.value.trim().toLowerCase();
    var shown = 0;
    rows.forEach(function (r) {
      var tags = (r.getAttribute("data-tags") || "").split("|");
      var okMode = mode === "All" || tags.indexOf(mode) !== -1;
      var okText = !term || r.id.toLowerCase() === term.replace(/^#/, "item-") || r.textContent.toLowerCase().indexOf(term) !== -1;
      r.hidden = !(okMode && okText);
      if (!r.hidden) shown++;
    });
    count.textContent = shown === rows.length ? "Showing all " + rows.length + " " + noun : "Showing " + shown + " of " + rows.length + " " + noun;
  }
  function setMode(m) {
    mode = m;
    chips.forEach(function (c) { var on = c.getAttribute("data-filter") === m; c.classList.toggle("on", on); c.setAttribute("aria-pressed", String(on)); });
    apply();
  }
  chips.forEach(function (c) { c.addEventListener("click", function () { setMode(c.getAttribute("data-filter")); }); });
  q.addEventListener("input", apply);
  // A link to a filtered-out row clears the filter so the target is visible.
  function reveal() {
    var t = location.hash && document.getElementById(location.hash.slice(1));
    if (t && t.hidden) { q.value = ""; setMode("All"); t.scrollIntoView(); }
  }
  window.addEventListener("hashchange", reveal);
  apply();
  reveal();
})();
`;

export function filterBar(label: string, filters: readonly string[], noun: string): string {
  const chips = ['All', ...filters]
    .map(
      (f) =>
        `<button type="button" class="chip${f === 'All' ? ' on' : ''}" data-filter="${esc(f)}" aria-pressed="${f === 'All'}">${esc(f)}</button>`,
    )
    .join('');
  return `<div class="filterbar" role="search">
  <label for="q" class="sr">${esc(label)}</label>
  <input id="q" type="search" placeholder="${esc(label)}: an id, a word…" autocomplete="off">
  <div class="chips" role="group" aria-label="Show rows by status">${chips}</div>
  <p id="count" class="note count" aria-live="polite" data-noun="${esc(noun)}"></p>
</div>`;
}

/** A receipt-style summary: label, dotted leader, figure. */
export function slip(
  head: string,
  rows: readonly { label: string; value: string | number; sub?: boolean }[],
  foot: string,
): string {
  const lines = rows
    .map(
      (r) =>
        `<div class="slip-row${r.sub ? ' sub-row' : ''}"><dt>${esc(r.label)}</dt><dd>${esc(String(r.value))}</dd></div>`,
    )
    .join('');
  return `<div class="slip" role="group" aria-label="${esc(head)}"><div class="slip-head">${esc(head)}</div><dl>${lines}</dl><div class="slip-foot">${foot}</div></div>`;
}

/** A banner on a page built from records that are not on main yet. */
export const draftBanner = (ctx: PageContext) =>
  ctx.draft
    ? `<div class="callout warn" role="note"><p class="eyebrow">Draft for review</p><p>${inline(ctx, 'traceability', ctx.draft)} These records are not on <code>main</code> yet. Once merged and released, this page is republished from <code>main</code> and the banner goes.</p></div>`
    : '';
