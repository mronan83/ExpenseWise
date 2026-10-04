import { FEATURES } from '../features.ts';
import { resolveCheck } from '../integrity.ts';
import type { Criterion, Decided, FeatureGroup, Story } from '../model.ts';
import { testFiles } from '../repo.ts';
import { RULES } from '../rules.ts';
import { STORIES } from '../stories/index.ts';
import {
  draftBanner,
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
  slip,
  type PageContext,
} from './shared.ts';

const PAGE = 'stories' as const;
export const STORIES_TITLE = 'ExpenseWise User Stories & Acceptance Criteria';

const GROUPS: readonly (FeatureGroup | 'Across the product')[] = [
  'Access and organizations',
  'Receipts',
  'Expenses, trips and reports',
  'Domain rules',
  'Platform and operations',
  'Across the product',
];
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
const pct = (n: number, d: number) => (d === 0 ? 0 : Math.floor((n * 100) / d));

const WHO: Record<Decided['by'], { label: string; cls: string }> = {
  owner: { label: 'Your decision', cls: 'dc-owner' },
  blueprint: { label: 'Blueprint', cls: 'dc-blueprint' },
  claude: { label: 'Claude’s, to confirm', cls: 'dc-claude' },
};

const STATUS_CLASS: Record<Story['status'], string> = {
  Delivered: 'st-verified',
  Partial: 'st-partial',
  Planned: 'st-planned',
};

/** The fifth page: every user story, its acceptance criteria, who decided each and what proves it. */
export function renderStories(ctx: PageContext): string {
  const tests = testFiles();
  const T = (text: string) => inline(ctx, PAGE, text);
  const L = (id: string) => refLink(ctx, PAGE, id);
  const features = new Map(FEATURES.map((f) => [f.id, f]));
  const groupOf = (s: Story) =>
    (s.feature ? features.get(s.feature)?.group : undefined) ?? 'Across the product';

  const all = STORIES.flatMap((s) => s.criteria.map((a) => ({ s, a })));
  const built = all.filter(({ s }) => s.status !== 'Planned');
  const tested = built.filter(({ a }) => a.checks.length > 0).length;
  const untested = built.filter(({ a }) => a.checks.length === 0);
  const toConfirm = all.filter(({ a }) => a.decided.by === 'claude');
  const by = (who: Decided['by']) => all.filter(({ a }) => a.decided.by === who).length;
  const count = (status: Story['status']) => STORIES.filter((s) => s.status === status).length;
  const requirements = new Set(STORIES.flatMap((s) => s.requirements));

  const source = (d: Decided) => {
    const who = WHO[d.by];
    const cited =
      'source' in d && d.source
        ? ` · ${T(d.source.replace(/^owner (\d{4}-\d{2}-\d{2})$/, '$1'))}`
        : '';
    return `<span class="dc ${who.cls}">${who.label}${cited}</span>`;
  };

  const proof = (a: Criterion) => {
    if (a.checks.length === 0) {
      return a.untested !== undefined
        ? `<span class="proof none">No test yet · ${L(`#${a.untested}`)}</span>`
        : '<span class="proof planned">Not built yet</span>';
    }
    // One link per test file, its tests named in the tooltip, as the traceability page does.
    const byAlias = new Map<string, { file: string; titles: string[] }>();
    for (const ref of a.checks) {
      const c = resolveCheck(ref, tests);
      const entry = byAlias.get(c.alias) ?? { file: c.file, titles: [] };
      entry.titles.push(c.title ?? 'the whole file');
      byAlias.set(c.alias, entry);
    }
    return `<span class="proof">${[...byAlias]
      .map(
        ([alias, { file, titles }]) =>
          `<a class="chk" href="${esc(githubFile(ctx, file))}" target="_blank" rel="noopener" title="${esc(titles.join('\n'))}">${esc(alias)}${titles.length > 1 ? ` ×${titles.length}` : ''}</a>`,
      )
      .join(' ')}</span>`;
  };

  const criterion = (s: Story, a: Criterion) => `<li id="${esc(s.id)}-${esc(a.id)}">
  <span class="ac-id">${esc(a.id)}</span>
  <div class="gwt">
    <p><b>Given</b> ${T(a.given)},</p>
    <p><b>when</b> ${T(a.when)},</p>
    <p><b>then</b> ${T(a.then)}.</p>
    <p class="ac-meta">${source(a.decided)}${a.rules?.length ? ` · ${a.rules.map((r) => `<a class="ref" href="#${esc(r)}">${esc(r)}</a>`).join(' ')}` : ''} · ${proof(a)}</p>
  </div>
</li>`;

  const card = (s: Story) => {
    const tags: string[] = [s.status];
    if (s.criteria.some((a) => s.status !== 'Planned' && a.checks.length === 0))
      tags.push('Untested');
    if (s.criteria.some((a) => a.decided.by === 'claude')) tags.push('To confirm');
    const links = [...(s.feature ? [s.feature] : []), ...s.requirements].map(L).join('');
    return `<article class="story" id="${esc(s.id)}" data-row data-tags="${esc(tags.join('|'))}">
  <header class="story-head"><span class="story-id">${esc(s.id)}</span><h3>${T(s.title)}</h3>${pill(STATUS_CLASS[s.status], s.status)}</header>
  <p class="narrative">As <b>${T(s.as)}</b>, I want ${T(s.want)}, so that ${T(s.soThat)}.</p>
  <div class="refs">${links}</div>
  <ol class="acs">${s.criteria.map((a) => criterion(s, a)).join('')}</ol>
  ${s.note ? `<p class="note">${T(s.note)}</p>` : ''}
</article>`;
  };

  const sections = GROUPS.map((g) => {
    const stories = STORIES.filter((s) => groupOf(s) === g);
    if (stories.length === 0) return '';
    return `<section id="${slug(g)}" aria-labelledby="${slug(g)}-h"><h2 id="${slug(g)}-h">${esc(g)} <span class="n">${stories.length}</span></h2>
${stories.map(card).join('\n')}
</section>`;
  }).join('\n');

  const hero = `<header class="hero">
  <p class="eyebrow">ExpenseWise · User stories</p>
  ${draftBanner(ctx)}
  <div class="hero-top">
    <div class="hero">
      <h1>User Stories &amp; Acceptance Criteria</h1>
      <p class="meta">As live in production at ${ext(githubCommit(ctx, ctx.productionSha), `<code>${short(ctx.productionSha)}</code>`)} · ${esc(ctx.date)} · records at ${ext(githubCommit(ctx, ctx.recordsSha), `<code>${short(ctx.recordsSha)}</code>`)}</p>
      <p class="lede">${STORIES.length} user stories detail ${requirements.size} requirements in ${all.length} acceptance criteria. Of the ${built.length} criteria already built, ${tested} (${pct(tested, built.length)}%) are proved by an automated test that fails when they break${untested.length ? `; ${untested.length} are owed a test (${L('#66')})` : ''}.</p>
      <p>Each criterion says who decided it: you, the blueprint, or Claude. ${toConfirm.length} rest on Claude’s design or reading of a requirement. They are listed first, for you to confirm or overturn.</p>
    </div>
    ${slip(
      'Stories · ' + short(ctx.productionSha),
      [
        { label: 'User stories', value: STORIES.length },
        { label: 'delivered', value: count('Delivered'), sub: true },
        { label: 'partial', value: count('Partial'), sub: true },
        { label: 'planned', value: count('Planned'), sub: true },
        { label: 'Acceptance criteria', value: all.length },
        { label: 'proved by a test', value: tested, sub: true },
        { label: 'owed a test', value: untested.length, sub: true },
        { label: 'Your decisions', value: by('owner') },
        { label: 'From the blueprint', value: by('blueprint') },
        { label: 'Claude’s, to confirm', value: toConfirm.length },
        { label: 'Rules in the register', value: RULES.length },
      ],
      `${pct(tested, built.length)}% PROVED · ${esc(ctx.date)}`,
    )}
  </div>
  <p class="source">Generated from ${ext(githubFile(ctx, 'tools/records/src/stories'), '<code>tools/records/src/stories</code>')} and ${ext(githubFile(ctx, 'tools/records/src/rules.ts'), '<code>rules.ts</code>')}. CI fails when a built requirement has no story, a criterion of a delivered story has no test, a cited test doesn’t exist, or a rule’s value differs from the code.</p>
</header>`;

  const how = `<section id="how" aria-labelledby="how-h"><h2 id="how-h">How to read this</h2>
<p>A requirement says what must be true. Its stories say who needs it and why. Their acceptance criteria are the rules it is accepted on, each in <b>Given</b>, <b>when</b>, <b>then</b> form, and each names the test that proves it.</p>
<dl class="defs">
  <dt>${pill('st-verified', 'Delivered')}</dt><dd>Built, and every criterion is proved by an automated test.</dd>
  <dt>${pill('st-partial', 'Partial')}</dt><dd>Built, but a criterion has no test yet. ${L('#66')} adds them.</dd>
  <dt>${pill('st-planned', 'Planned')}</dt><dd>Agreed, not built: the criteria are what it will be accepted on.</dd>
  <dt><span class="dc dc-owner">Your decision</span></dt><dd>You said it, on the day cited, or in your answer to the question cited.</dd>
  <dt><span class="dc dc-blueprint">Blueprint</span></dt><dd>From the blueprint documents, or a decision you took in its register.</dd>
  <dt><span class="dc dc-claude">Claude’s, to confirm</span></dt><dd>Claude’s design or reading of a requirement, recorded in the decision cited. It stands until you overturn it.</dd>
</dl></section>`;

  const confirm = toConfirm.length
    ? `<section id="to-confirm" aria-labelledby="tc-h"><h2 id="tc-h">For you to confirm <span class="n">${toConfirm.length}</span></h2>
<p>Criteria that rest on Claude’s design rather than your words. Each stands unless you overturn it; say which, and the story changes with the code.</p>
<details class="confirm"><summary>Show all ${toConfirm.length}</summary>
<ul class="confirm-list">${toConfirm
        .map(
          ({ s, a }) =>
            `<li><a class="ref" href="#${esc(s.id)}-${esc(a.id)}">${esc(s.id)} ${esc(a.id)}</a> <span>${T(`${a.then}`)}</span>${'source' in a.decided && a.decided.source ? ` <span class="note">(${T(a.decided.source)})</span>` : ''}</li>`,
        )
        .join('')}</ul></details></section>`
    : '';

  const usedBy = (id: string) =>
    all
      .filter(({ a }) => a.rules?.includes(id))
      .map(
        ({ s, a }) =>
          `<a class="ref" href="#${esc(s.id)}-${esc(a.id)}">${esc(s.id)} ${esc(a.id)}</a>`,
      );
  const register = `<section id="rules" aria-labelledby="rules-h"><h2 id="rules-h">Rule register <span class="n">${RULES.length}</span></h2>
<p>The numbers the rules share, each named once. Where the code keeps one, CI fails if the code and this register disagree.</p>
<div class="table-wrap" tabindex="0" role="region" aria-label="Rule register"><table class="rules"><thead><tr><th scope="col">Rule</th><th scope="col">Value</th><th scope="col">Decided</th><th scope="col">In the code</th><th scope="col">Used by</th></tr></thead><tbody>
${RULES.map(
  (r) =>
    `<tr id="${esc(r.id)}"><td><span class="rule-id">${esc(r.id)}</span><div>${T(r.name)}</div>${r.note ? `<div class="sub">${T(r.note)}</div>` : ''}</td><td><b>${T(r.value)}</b></td><td>${source(r.decided)}</td><td>${r.code ? ext(githubFile(ctx, r.code.file), `<code>${esc(r.code.constant)}</code>`) : '<span class="note">–</span>'}</td><td><div class="refs">${usedBy(r.id).join('')}</div></td></tr>`,
).join('\n')}
</tbody></table></div></section>`;

  const toc = `<nav class="toc" aria-label="Contents"><p class="eyebrow">Contents</p><ol>
  <li><a href="#how">How to read this</a></li>
  ${toConfirm.length ? `<li><a href="#to-confirm">For you to confirm (${toConfirm.length})</a></li>` : ''}
  ${GROUPS.filter((g) => STORIES.some((s) => groupOf(s) === g))
    .map(
      (g) =>
        `<li><a href="#${slug(g)}">${esc(g)} (${STORIES.filter((s) => groupOf(s) === g).length})</a></li>`,
    )
    .join('\n  ')}
  <li><a href="#rules">Rule register (${RULES.length})</a></li>
</ol></nav>`;

  const body = `<div class="page">
${hero}
<div class="layout">
${toc}
<main>
${how}
${confirm}
${filterBar('Filter stories', ['Delivered', 'Partial', 'Planned', 'Untested', 'To confirm'], 'stories')}
${sections}
${register}
</main>
</div>
<p class="foot">Published after a successful release, never after a merge, so this page describes what is live. Built by <code>tools/records</code>.</p>
</div>`;

  return frame(STORIES_TITLE, STORIES_CSS, body, FILTER_SCRIPT);
}

const STORIES_CSS = `
h2 .n { font: 500 0.9rem/1 var(--mono); color: var(--ink-3); margin-left: 6px; }
.story { background: var(--sheet); border: 1px solid var(--rule); border-radius: 8px; padding: 16px 18px; display: grid; gap: 10px; scroll-margin-top: 110px; }
.story:target { outline: 2px solid var(--warn); }
.story-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
.story-id { font: 500 0.8rem/1.2 var(--mono); color: var(--carbon); }
.story-head h3 { flex: 1 1 16rem; }
.narrative { color: var(--ink); max-width: 78ch; }
.acs { list-style: none; margin: 0; padding: 0; display: grid; gap: 0; border-top: 1px solid var(--rule); }
.acs li { display: grid; grid-template-columns: 2.8em minmax(0, 1fr); gap: 4px 10px; padding: 10px 0; border-bottom: 1px solid var(--rule); scroll-margin-top: 110px; }
.acs li:last-child { border-bottom: 0; }
.acs li:target { background: var(--warn-wash); }
.ac-id { font: 500 0.8rem/1.6 var(--mono); color: var(--ink-3); }
.gwt { display: grid; gap: 2px; min-width: 0; }
.gwt p { max-width: 80ch; }
.gwt b { font-weight: 600; }
.ac-meta { margin-top: 4px; font-size: 0.84rem; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px 8px; align-items: baseline; }
.dc { display: inline-block; font-size: 0.76rem; font-weight: 600; padding: 1px 8px; border-radius: 999px; white-space: nowrap; }
.dc-owner { background: var(--ok-wash); color: var(--ok); }
.dc-blueprint { background: var(--carbon-wash); color: var(--carbon); }
.dc-claude { background: var(--warn-wash); color: var(--warn); }
.proof { display: inline-flex; flex-wrap: wrap; gap: 2px 8px; }
.proof.none { color: var(--bad); font-weight: 600; }
.proof.planned { color: var(--ink-3); }
.rule-id { font: 500 0.8rem/1.4 var(--mono); color: var(--carbon); }
table.rules td:first-child { min-width: 16rem; }
.confirm summary { cursor: pointer; color: var(--carbon); font-weight: 600; }
.confirm-list { margin: 10px 0 0; padding-left: 1.1em; display: grid; gap: 6px; max-width: 90ch; }
@media (max-width: 700px) {
  .story { padding: 14px; }
  .acs li { grid-template-columns: minmax(0, 1fr); }
}
`;
