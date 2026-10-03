import { describe, expect, it } from 'vitest';
import { BACKLOG } from './backlog.ts';
import { FEATURES } from './features.ts';
import { renderBacklog } from './render/backlog.ts';
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
    expect(html).toContain('<span class="ref">GAP-02</span>');
  });
});

describe('inline text', () => {
  it('escapes, links ids and PRs, and keeps code literal', () => {
    expect(inline(ctx, 'backlog', 'See #3 and PR #20, not `#4` or <x>')).toBe(
      'See <a class="ref" href="#item-3">#3</a> and <a href="https://github.com/mronan83/ExpenseWise/pull/20" target="_blank" rel="noopener">PR #20</a>, not <code>#4</code> or &lt;x&gt;',
    );
  });
});
