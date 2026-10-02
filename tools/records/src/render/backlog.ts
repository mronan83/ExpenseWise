import { BACKLOG, SEQUENCING } from '../backlog.ts';
import type { BacklogItem } from '../model.ts';
import {
  esc,
  ext,
  filterBar,
  FILTER_SCRIPT,
  frame,
  githubCommit,
  githubFile,
  inline,
  pill,
  refLink,
  short,
  draftBanner,
  type PageContext,
} from './shared.ts';

const PAGE = 'backlog' as const;
export const BACKLOG_TITLE = 'ExpenseWise Backlog';

const EFFORT: Record<BacklogItem['effort'], string> = {
  S: 'hours',
  M: 'about a day',
  L: 'days',
};
const PRIORITY: Record<BacklogItem['priority'], string> = {
  P1: 'next',
  P2: 'this month',
  P3: 'this quarter',
};

const ready = (b: BacklogItem) => b.blocker.kind === 'none';
const yours = (b: BacklogItem) => b.blocker.kind === 'owner';

export function renderBacklog(ctx: PageContext): string {
  const T = (text: string) => inline(ctx, PAGE, text);
  const L = (id: string) => refLink(ctx, PAGE, id);
  const open = BACKLOG.filter((b) => !b.done);
  const done = BACKLOG.filter((b) => b.done);

  const blockerText = (b: BacklogItem) => {
    switch (b.blocker.kind) {
      case 'none':
        return b.blocker.note ? T(b.blocker.note) : 'None';
      case 'owner':
        return T(b.blocker.ask);
      case 'items':
        return `${b.blocker.items.map((n) => L(`#${n}`)).join(', ')}${b.blocker.then ? `, then ${T(b.blocker.then)}` : ''}`;
    }
  };

  const stats: [number, string][] = [
    [open.length, 'open items'],
    [open.filter((b) => b.priority === 'P1').length, 'P1, to do next'],
    [open.filter(yours).length, 'waiting on you'],
    [open.filter(ready).length, 'ready for Claude'],
    [open.filter((b) => b.blocker.kind === 'items').length, 'waiting on another item'],
    [done.length, 'done'],
  ];

  const release = ctx.release
    ? `<div class="callout" role="status"><p class="eyebrow">This release</p>${
        ctx.release.commits.length
          ? `<p>${ctx.release.commits.length} ${ctx.release.commits.length === 1 ? 'commit' : 'commits'} since ${ext(githubCommit(ctx, ctx.release.since), `<code>${short(ctx.release.since)}</code>`)}:</p><ul class="commits">${ctx.release.commits.map((c) => `<li>${ext(githubCommit(ctx, c.sha), `<code>${short(c.sha)}</code>`)} ${T(c.subject)}</li>`).join('')}</ul>`
          : '<p>No new commits: production serves the same code as at the last release.</p>'
      }</div>`
    : '';

  const waiting = open.filter(yours);
  const yoursBox = `<section class="callout warn yours" aria-labelledby="yours-h"><h2 id="yours-h">Waiting on you</h2>
<p class="note">Only you can do these. Everything else on this page is Claude’s, or waits on one of these.</p>
<ol class="yours-list">${waiting
    .map(
      (b) =>
        `<li>${pill(`bp-${b.priority.toLowerCase()}`, b.priority)}${L(`#${b.num}`)}<span class="yours-what"><b>${blockerText(b)}</b><span class="note">${T(b.title)}</span></span></li>`,
    )
    .join('')}</ol></section>`;

  const hero = `<header class="hero">
  <p class="eyebrow">ExpenseWise · Backlog</p>
  ${draftBanner(ctx)}
  <h1>Open backlog</h1>
  <p class="meta">As live in production at ${ext(githubCommit(ctx, ctx.productionSha), `<code>${short(ctx.productionSha)}</code>`)} · ${esc(ctx.date)} · records at ${ext(githubCommit(ctx, ctx.recordsSha), `<code>${short(ctx.recordsSha)}</code>`)}</p>
  <p class="lede">The work ahead: the rest of Phase 1, and the gaps found while tracing requirements${ctx.urls.traceability ? ` on the ${ext(ctx.urls.traceability, 'traceability page')}` : ''}. This page is republished after each successful release, never after a merge, so it always describes what is live.</p>
  <div class="stats">${stats.map(([n, l]) => `<div class="stat"><span class="n">${n}</span><span class="l">${esc(l)}</span></div>`).join('')}</div>
  ${release}
  ${yoursBox}
  <p class="source">Generated from ${ext(githubFile(ctx, 'tools/records/src/backlog.ts'), '<code>tools/records/src/backlog.ts</code>')} at the records commit, where the backlog is edited. Git keeps its history.</p>
</header>`;

  // Priority × effort matrix
  const cell = (p: BacklogItem['priority'], e: BacklogItem['effort']) => {
    const here = open.filter((b) => b.priority === p && b.effort === e);
    const start = p === 'P1' && e === 'S';
    const chips = here
      .map(
        (b) =>
          `<a class="mx-chip sv-${b.severity.toLowerCase()}${ready(b) ? '' : ' blocked'}" href="#item-${b.num}" title="${esc(`#${b.num} ${b.title} · ${b.severity} severity${ready(b) ? '' : ' · waits on something'}`)}">${b.num}</a>`,
      )
      .join('');
    return `<div class="mx-cell${start ? ' start' : ''}" role="cell" aria-label="${p}, effort ${e}: ${here.length} items">${start ? '<span class="mx-hint">Start here</span>' : ''}${chips || '<span class="mx-empty" aria-hidden="true">–</span>'}</div>`;
  };
  const matrix = `<section id="priority-and-effort" aria-labelledby="pe-h"><h2 id="pe-h">Priority and effort</h2>
<p class="note">Every open item, placed by when to do it and how big it is. Colour is severity; a dashed outline means it waits on you or on another item.</p>
<figure class="matrix"><div class="mx" role="table" aria-label="Open items by priority and effort"><div role="presentation"></div>${(['S', 'M', 'L'] as const).map((e) => `<div class="mx-col" role="columnheader"><b>${e}</b> <span>${EFFORT[e]}</span></div>`).join('')}${(['P1', 'P2', 'P3'] as const).map((p) => `<div class="mx-row-h" role="rowheader"><b>${p}</b> <span>${PRIORITY[p]}</span></div>${(['S', 'M', 'L'] as const).map((e) => cell(p, e)).join('')}`).join('')}</div>
<figcaption><span class="key"><span class="mx-chip sv-high"></span>High</span><span class="key"><span class="mx-chip sv-medium"></span>Medium</span><span class="key"><span class="mx-chip sv-low"></span>Low</span><span class="key"><span class="mx-chip sv-low blocked"></span>Waits on something</span></figcaption></figure></section>`;

  const itemRow = (b: BacklogItem) => {
    const tags = [b.priority, ready(b) ? 'Ready now' : '', yours(b) ? 'Waiting on you' : '']
      .filter(Boolean)
      .join('|');
    const affects = b.affects?.length
      ? `<p class="src">Moves ${b.affects.map(L).join(' ')}${b.source ? ` · Source: ${T(b.source)}` : ''}</p>`
      : b.source
        ? `<p class="src">Source: ${T(b.source)}</p>`
        : '';
    return `<tr id="item-${b.num}" data-row data-tags="${tags}">
<td class="num">${b.num}</td>
<td class="item"><div class="item-head"><span class="item-name">${T(b.title)}</span> <span class="type">${esc(b.type)}</span></div><p class="desc">${T(b.detail)}</p>${affects}</td>
<td data-label="Priority">${pill(`bp-${b.priority.toLowerCase()}`, b.priority)}</td>
<td data-label="Effort" class="effort">${b.effort}</td>
<td data-label="Severity">${pill(`sv-${b.severity.toLowerCase()}`, b.severity)}</td>
<td data-label="Blocker" class="blocker${ready(b) ? ' ready' : ''}">${blockerText(b)}</td>
</tr>`;
  };

  const items = `<section id="open-items" aria-labelledby="oi-h"><h2 id="oi-h">Open items</h2>
<p class="note">In number order. Numbers are permanent; a closed item keeps its number in Done.</p>
<div class="table-wrap"><table class="backlog"><thead><tr><th scope="col">#</th><th scope="col">Item</th><th scope="col">Priority</th><th scope="col">Effort</th><th scope="col">Severity</th><th scope="col">Blocker</th></tr></thead><tbody>
${open.map(itemRow).join('\n')}
</tbody></table></div></section>`;

  const sequencing = `<section id="sequencing" aria-labelledby="seq-h"><h2 id="seq-h">Notes on sequencing</h2><ul>${SEQUENCING.map((s) => `<li>${T(s)}</li>`).join('')}</ul></section>`;

  const doneTable = `<section id="done" aria-labelledby="done-h"><h2 id="done-h">Done</h2>
<div class="table-wrap"><table class="backlog done"><thead><tr><th scope="col">#</th><th scope="col">Item</th><th scope="col">Closed</th><th scope="col">In</th></tr></thead><tbody>
${done
  .map(
    (b) => `<tr id="item-${b.num}">
<td class="num">${b.num}</td>
<td class="item"><div class="item-head"><span class="item-name">${T(b.title)}</span> <span class="type">${esc(b.type)}</span></div><p class="desc">${T(b.detail)}</p></td>
<td data-label="Closed" class="effort">${esc(b.done!.date)}</td>
<td data-label="In" class="blocker">${T(b.done!.in)}</td>
</tr>`,
  )
  .join('\n')}
</tbody></table></div></section>`;

  const columns = `<section id="reading-the-columns" aria-labelledby="rc-h"><h2 id="rc-h">Reading the columns</h2>
<dl class="defs">
  <dt>Priority</dt><dd><b>P1</b> next · <b>P2</b> this month · <b>P3</b> this quarter. Requirements are ranked separately, with MoSCoW.</dd>
  <dt>Effort</dt><dd><b>S</b> hours · <b>M</b> about a day · <b>L</b> days, often with a decision first.</dd>
  <dt>Severity</dt><dd>What it costs to leave it: <b>High</b> risks data, money or trust; <b>Medium</b> wastes effort or hides a problem; <b>Low</b> is untidy.</dd>
  <dt>Blocker</dt><dd><b>None</b> means Claude can start it now. Anything else names the decision, action or item it waits on.</dd>
  <dt>Moves</dt><dd>The requirements, features and gaps the item changes when it closes.</dd>
</dl></section>`;

  const toc = `<nav class="toc" aria-label="Contents"><p class="eyebrow">Contents</p><ol>
  <li><a href="#yours-h">Waiting on you (${waiting.length})</a></li>
  <li><a href="#priority-and-effort">Priority and effort</a></li>
  <li><a href="#open-items">Open items (${open.length})</a></li>
  <li><a href="#sequencing">Notes on sequencing</a></li>
  <li><a href="#done">Done (${done.length})</a></li>
  <li><a href="#reading-the-columns">Reading the columns</a></li>
</ol></nav>`;

  const body = `<div class="page">
${hero}
<div class="layout">
${toc}
<main>
${filterBar('Filter items', ['P1', 'P2', 'P3', 'Ready now', 'Waiting on you'], 'open items')}
${matrix}
${items}
${sequencing}
${doneTable}
${columns}
</main>
</div>
<p class="foot">Published after a successful release, never after a merge, so this page describes what is live. Built by <code>tools/records</code>.</p>
</div>`;

  return frame(BACKLOG_TITLE, BACKLOG_CSS, body, FILTER_SCRIPT);
}

const BACKLOG_CSS = `
.stats { display: flex; flex-wrap: wrap; gap: 10px; }
.stat { background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 10px 16px; display: grid; min-width: 128px; }
.stat .n { font: 700 1.6rem/1.1 var(--display); font-variant-numeric: tabular-nums; }
.stat .l { font-size: 0.85rem; color: var(--ink-2); }
ul.commits { margin: 0; padding-left: 1.1em; display: grid; gap: 2px; font-size: 0.92rem; }
.yours h2 { font-size: 1.15rem; }
.yours-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.yours-list li { display: grid; grid-template-columns: auto 2.8em minmax(0, 1fr); gap: 4px 10px; align-items: baseline; }
.yours-what { display: grid; gap: 2px; min-width: 0; }
.yours-what b { font-weight: 600; }
.bp-p1 { background: var(--carbon); color: var(--carbon-ink); }
.bp-p2 { background: var(--carbon-wash); color: var(--carbon); border-color: var(--carbon); }
.bp-p3 { background: transparent; color: var(--ink-2); border-color: var(--rule-strong); }
table.backlog td.num { font-family: var(--mono); font-weight: 500; color: var(--carbon); white-space: nowrap; font-variant-numeric: tabular-nums; }
table.backlog td.item { min-width: 22rem; }
.item-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; }
.item-name { font-weight: 700; }
.type { font: 500 0.68rem/1.2 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }
.desc { color: var(--ink-2); font-size: 0.9rem; margin-top: 4px; max-width: none; }
.src { font-size: 0.82rem; color: var(--ink-2); margin-top: 6px; max-width: none; }
td.effort { font-family: var(--mono); font-size: 0.85rem; white-space: nowrap; }
table.backlog td[data-label] { width: 1%; white-space: nowrap; }
table.backlog td.blocker { font-size: 0.88rem; width: 15rem; min-width: 9rem; white-space: normal; }
td.blocker.ready { color: var(--ok); font-weight: 600; }
.matrix { margin: 0; display: grid; gap: 10px; }
.mx { display: grid; grid-template-columns: minmax(84px, 0.6fr) repeat(3, minmax(0, 1fr)); gap: 6px; }
.mx-col, .mx-row-h { font-size: 0.82rem; color: var(--ink-2); display: grid; align-content: center; }
.mx-col { padding: 0 10px; }
.mx-col b, .mx-row-h b { font: 700 1.1rem/1.2 var(--display); color: var(--ink); }
.mx-cell { background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 10px; min-height: 64px; display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; }
.mx-cell.start { border: 2px solid var(--carbon); }
.mx-hint { flex-basis: 100%; font: 500 0.7rem/1.2 var(--mono); letter-spacing: 0.07em; text-transform: uppercase; color: var(--carbon); }
.mx-empty { color: var(--rule-strong); }
.mx-chip { display: inline-grid; place-items: center; min-width: 2.3em; height: 1.9em; padding: 0 6px; border-radius: 5px; font: 500 0.85rem/1 var(--mono); text-decoration: none; border: 1.5px solid transparent; font-variant-numeric: tabular-nums; }
.mx-chip.blocked { border: 1.5px dashed var(--rule-strong); }
a.mx-chip:hover { border-color: var(--carbon); }
.matrix figcaption { display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; color: var(--ink-2); font-size: 0.85rem; }
.key { display: inline-flex; align-items: center; gap: 6px; }
.key .mx-chip { min-width: 1.4em; height: 1.2em; padding: 0; }
@media (max-width: 700px) {
  .mx { grid-template-columns: 54px repeat(3, minmax(0, 1fr)); gap: 4px; }
  .mx-col span, .mx-row-h span, .mx-hint { display: none; }
  .mx-col { padding: 0 4px; }
  .mx-cell { padding: 6px; gap: 4px; min-height: 48px; }
  table.backlog thead { display: none; }
  table.backlog, table.backlog tbody, table.backlog tr { display: block; }
  table.backlog tr { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; padding: 12px; border-bottom: 1px solid var(--rule); }
  table.backlog tr:last-child { border-bottom: 0; }
  table.backlog td { border: 0; padding: 0; }
  table.backlog td.item { min-width: 0; grid-column: 2; }
  table.backlog td.num { grid-row: 1; }
  table.backlog td[data-label] { grid-column: 2; display: flex; gap: 8px; align-items: baseline; font-size: 0.88rem; width: auto; min-width: 0; white-space: normal; }
  table.backlog td[data-label]::before { content: attr(data-label); font: 500 0.7rem/1.4 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-2); min-width: 5.5em; }
}
`;
