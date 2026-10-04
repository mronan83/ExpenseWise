import { describe, expect, it } from 'vitest';
import { BACKLOG } from './backlog.ts';
import { FEATURES } from './features.ts';
import { DOMAINS, RULES } from './data-model.ts';
import { schemaSnapshot } from './schema.ts';
import { COMPONENTS, SETTINGS } from './architecture.ts';
import { renderArchitecture } from './render/architecture.ts';
import { renderBacklog } from './render/backlog.ts';
import { renderDataModel } from './render/data-model.ts';
import { renderStories } from './render/stories.ts';
import { RULES as REGISTER } from './rules.ts';
import { STORIES } from './stories/index.ts';
import { inline, type PageContext } from './render/shared.ts';
import { renderTraceability } from './render/traceability.ts';
import { REQUIREMENTS } from './requirements.ts';

const ctx: PageContext = {
  repo: 'mronan83/ExpenseWise',
  recordsSha: 'b'.repeat(40),
  productionSha: 'a'.repeat(40),
  date: '2026-10-02',
  urls: { backlog: 'https://claude.ai/code/artifact/backlog' },
  release: {
    since: 'c'.repeat(40),
    commits: [{ sha: 'a'.repeat(40), subject: 'feat: <b>bold</b> (#21)' }],
  },
};

describe('the traceability page', () => {
  const html = renderTraceability(ctx);

  it('names itself, the live commit and the records commit', () => {
    expect(html).toMatch(/^<title>ExpenseWise Requirements &amp; Traceability<\/title>/);
    expect(html).toContain('<code>aaaaaaa</code>');
    expect(html).toContain('<code>bbbbbbb</code>');
  });

  it('lists each requirement’s user stories, linked to the stories page', () => {
    expect(html).toContain('Stories: <span class="ref">US-DUP-01</span>');
  });

  it('has a row for every requirement and every feature, by id', () => {
    for (const r of REQUIREMENTS) expect(html).toContain(`<tr id="${r.id}"`);
    for (const f of FEATURES) expect(html).toContain(`<tr id="${f.id}"`);
  });

  it('links backlog items to the published backlog page', () => {
    expect(html).toContain('href="https://claude.ai/code/artifact/backlog#item-1"');
  });

  it('defines every colour as a token for both themes', () => {
    expect(html).toContain('@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).not.toMatch(/<\/?(html|head|body)\b/);
  });
});

describe('the backlog page', () => {
  const html = renderBacklog(ctx);

  it('has a row for every item, open and done', () => {
    for (const b of BACKLOG) expect(html).toContain(`<tr id="item-${b.num}"`);
  });

  it('lists this release’s commits, escaped', () => {
    expect(html).toContain('1 commit since');
    expect(html).toContain('feat: &lt;b&gt;bold&lt;/b&gt;');
  });

  it('leaves requirement ids as plain text until the traceability page is published', () => {
    const gap = BACKLOG.filter((b) => !b.done)
      .flatMap((b) => b.affects ?? [])
      .find((a) => a.startsWith('GAP-'));
    expect(gap).toBeDefined();
    expect(html).toContain(`<span class="ref">${gap}</span>`);
  });
});

describe('inline text', () => {
  it('escapes, links ids and PRs, and keeps code literal', () => {
    expect(inline(ctx, 'backlog', 'See #3 and PR #20, not `#4` or <x>')).toBe(
      'See <a class="ref" href="#item-3">#3</a> and <a href="https://github.com/mronan83/ExpenseWise/pull/20" target="_blank" rel="noopener">PR #20</a>, not <code>#4</code> or &lt;x&gt;',
    );
  });
});

describe('the architecture page', () => {
  const html = renderArchitecture(ctx);

  it('names itself and shows the written half beside what it read', () => {
    expect(html).toMatch(/^<title>ExpenseWise Technical Architecture<\/title>/);
    for (const c of COMPONENTS) expect(html).toContain(`<b>${c.name}</b>`);
    for (const s of SETTINGS) for (const n of s.names) expect(html).toContain(`<code>${n}</code>`);
  });

  it('lists every API operation in the contract', () => {
    expect(html).toContain('<code>/v1/trips/{tripId}</code>');
    expect(html).toContain('<td class="method m-delete">DELETE</td>');
  });

  it('draws its diagrams for the viewer to render', () => {
    expect(html).toContain('<pre class="mermaid">flowchart LR');
    expect(html).toContain('sequenceDiagram');
  });

  it('says what changed since the last release', () => {
    expect(html).toContain('Changed in this release');
  });
});

describe('the data model page', () => {
  const html = renderDataModel(ctx);
  const snapshot = schemaSnapshot();

  it('has a block for every table, in its domain', () => {
    expect(html).toMatch(/^<title>ExpenseWise Data Model<\/title>/);
    for (const t of snapshot.tables) {
      expect(html).toContain(`id="t-${t.name.replace(/\./g, '-')}"`);
    }
    for (const d of DOMAINS) expect(html).toContain(`data-filter="${d.name}"`);
  });

  it('shows each rule with the objects that enforce it', () => {
    for (const r of RULES) for (const o of r.objects) expect(html).toContain(`<code>${o}</code>`);
  });

  it('draws the lifecycles from the domain’s own rules', () => {
    expect(html).toContain('submitted --&gt; approved: report approved');
    expect(html).toContain('inapproval --&gt; open: return, withdraw');
  });

  it('notes a column from the comment above it in the schema', () => {
    expect(html).toContain('A person chose its trip, or chose no trip.');
  });
});

describe('the user stories page (NFR-DEL-09)', () => {
  const html = renderStories(ctx);

  it('names itself, the live commit and the records commit', () => {
    expect(html).toMatch(/^<title>ExpenseWise User Stories &amp; Acceptance Criteria<\/title>/);
    expect(html).toContain('<code>aaaaaaa</code>');
    expect(html).toContain('<code>bbbbbbb</code>');
  });

  it('shows every story and every acceptance criterion, by id', () => {
    for (const s of STORIES) {
      expect(html).toContain(`<article class="story" id="${s.id}"`);
      for (const a of s.criteria) expect(html).toContain(`<li id="${s.id}-${a.id}">`);
    }
  });

  it('says who decided each criterion, and points an untested one at the item that adds its test', () => {
    expect(html).toContain('Your decision');
    expect(html).toContain('Claude’s, to confirm');
    expect(html).toContain('No test yet');
    expect(html).toContain('https://claude.ai/code/artifact/backlog#item-66');
  });

  it('lists every rule in the register with the criteria that use it', () => {
    for (const r of REGISTER) expect(html).toContain(`<tr id="${r.id}">`);
    expect(html).toContain('href="#US-DUP-01-AC2">US-DUP-01 AC2</a>');
  });
});
