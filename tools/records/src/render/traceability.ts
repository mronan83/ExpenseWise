import { BACKLOG } from '../backlog.ts';
import { FEATURES } from '../features.ts';
import { areaOf, resolveCheck, resolveSource } from '../integrity.ts';
import type { Area, Feature, FeatureStatus, Requirement, Status } from '../model.ts';
import { AREAS, OBJECTIVES } from '../objectives.ts';
import { adrs, capabilityMap, DOCS, testFiles } from '../repo.ts';
import { FUNCTIONAL, NON_FUNCTIONAL, REQUIREMENTS } from '../requirements.ts';
import { STORIES } from '../stories/index.ts';
import { CHANGE_LOG, GAPS, QUESTIONS } from '../tracing.ts';
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
  slip,
  statusClass,
  draftBanner,
  type PageContext,
} from './shared.ts';

const PAGE = 'traceability' as const;
const STATUSES: readonly Status[] = ['Verified', 'Implemented', 'Partial', 'Planned', 'Deferred'];
const FEATURE_STATUSES: readonly FeatureStatus[] = [
  'Verified',
  'Implemented',
  'Partial',
  'In review',
  'Planned',
  'Deferred',
];

export const TRACEABILITY_TITLE = 'ExpenseWise Requirements & Traceability';

const count = <T>(xs: readonly T[], p: (x: T) => boolean) => xs.filter(p).length;
const pct = (n: number, d: number) => (d === 0 ? 0 : Math.floor((n * 100) / d));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listing = (xs: readonly string[]) =>
  xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;

export function renderTraceability(ctx: PageContext): string {
  const tests = testFiles();
  const L = (id: string) => refLink(ctx, PAGE, id);
  const T = (text: string) => inline(ctx, PAGE, text);

  const sourceLinks = (refs: readonly string[]) =>
    `<div class="refs">${refs
      .map((r) => {
        const s = resolveSource(r);
        if (/^PR #\d+$/.test(r)) return T(r);
        return s.file ? ext(githubFile(ctx, s.file), esc(s.label), 'ref') : esc(s.label);
      })
      .join('')}</div>`;

  const checkLinks = (refs: readonly string[] | undefined) => {
    if (!refs?.length) return '<span class="note">–</span>';
    const byAlias = new Map<string, { file: string; titles: string[] }>();
    for (const ref of refs) {
      const c = resolveCheck(ref, tests);
      const entry = byAlias.get(c.alias) ?? { file: c.file, titles: [] };
      entry.titles.push(c.title ?? 'the whole file');
      byAlias.set(c.alias, entry);
    }
    return `<div class="refs">${[...byAlias]
      .map(([alias, { file, titles }]) => {
        const label = `${esc(alias)}${titles.length > 1 ? ` ×${titles.length}` : ''}`;
        return `<a class="chk" href="${esc(githubFile(ctx, file))}" target="_blank" rel="noopener" title="${esc(titles.join('\n'))}">${label}</a>`;
      })
      .join('')}</div>`;
  };

  const statusCell = (status: FeatureStatus, extra: readonly string[] = []) =>
    `${pill(statusClass(status), status)}${extra.length ? `<div class="refs sub">${extra.map(L).join('')}</div>` : ''}`;

  const verified = count(REQUIREMENTS, (r) => r.status === 'Verified');
  const openGaps = GAPS.filter((g) => !g.closed);
  const high = openGaps.filter((g) => g.severity === 'High').map((g) => g.id);
  const openQuestions = QUESTIONS.filter((q) => !q.answer);
  const citedAdrs = new Set([
    ...REQUIREMENTS.flatMap((r) => r.sources.filter((s) => s.startsWith('ADR-'))),
    ...FEATURES.flatMap((f) => f.decisions ?? []),
    ...OBJECTIVES.flatMap((o) => o.sources.filter((s) => s.startsWith('ADR-'))),
  ]);
  const openItems = BACKLOG.filter((b) => !b.done);

  // Hero
  const hero = `<header class="hero">
  <p class="eyebrow">ExpenseWise · Requirements</p>
  ${draftBanner(ctx)}
  <div class="hero-top">
    <div class="hero">
      <h1>Requirements &amp; Feature Traceability</h1>
      <p class="meta">As live in production at ${ext(githubCommit(ctx, ctx.productionSha), `<code>${short(ctx.productionSha)}</code>`)} · ${esc(ctx.date)} · records at ${ext(githubCommit(ctx, ctx.recordsSha), `<code>${short(ctx.recordsSha)}</code>`)}</p>
      <p class="lede">ExpenseWise’s ${REQUIREMENTS.length} requirements trace to ${FEATURES.length} features, ${citedAdrs.size} decision records and ${tests.size} test files. ${verified} (${pct(verified, REQUIREMENTS.length)}%) are verified by a check that fails when they break. Tracing found ${plural(openGaps.length, 'gap')}${high.length ? `; ${high.length === 1 ? 'one is' : `${high.length} are`} High: ${listing(high.map(L))}` : ''}.</p>
      <p>Start with ${openQuestions.length ? `the ${plural(openQuestions.length, 'open question')} and ` : ''}the High gaps. Everything here was derived from the repository and the blueprint docs; each requirement is a proposal until you confirm, reword or reject it.</p>
    </div>
    ${slip(
      'Trace · ' + short(ctx.productionSha),
      [
        { label: 'Requirements', value: REQUIREMENTS.length },
        { label: 'verified by a check', value: verified, sub: true },
        { label: 'Features', value: FEATURES.length },
        { label: 'Decision records', value: citedAdrs.size },
        { label: 'Test files', value: tests.size },
        { label: 'Gaps open', value: openGaps.length },
        { label: 'Questions open', value: openQuestions.length },
        { label: 'Backlog items open', value: openItems.length },
      ],
      `${pct(verified, REQUIREMENTS.length)}% VERIFIED · ${esc(ctx.date)}`,
    )}
  </div>
  <p class="source">Generated from ${ext(githubFile(ctx, 'tools/records/src'), '<code>tools/records</code>')} at the commit above, where requirements are edited and versioned. CI fails when these records and the code disagree.</p>
</header>`;

  // How this works
  const idForms: [string, string, string, string][] = [
    ['Business objective', 'BO-n', 'tools/records/src/objectives.ts', 'BO-1'],
    ['Functional requirement', 'FR-AREA-nn', 'tools/records/src/requirements.ts', 'FR-INT-02'],
    [
      'Non-functional requirement',
      'NFR-AREA-nn',
      'tools/records/src/requirements.ts',
      'NFR-SEC-01',
    ],
    ['Feature', 'F-nn', 'tools/records/src/features.ts', 'F-06'],
    ['Decision', 'ADR-nnnn', 'docs/adr/', 'ADR-0017'],
    ['Check', 'test file alias, or ci:job', 'packages/*, apps/web/e2e, CI', 'db/tenancy.int'],
    ['Gap', 'GAP-nn', 'tools/records/src/tracing.ts', 'GAP-01'],
    ['Backlog item', '#n', 'tools/records/src/backlog.ts', '#1'],
  ];
  const how = `<section id="how" aria-labelledby="how-h"><h2 id="how-h">How this document works</h2>
<p>Every requirement traces down to the features that deliver it, and every feature to the decision, code and checks that prove it. ExpenseWise’s blueprint states scope (the capability map), journeys, principles and service levels, but no numbered requirements; these were derived from it and from what is built.</p>
<div class="table-wrap"><table><thead><tr><th scope="col">Level</th><th scope="col">Id</th><th scope="col">Lives in</th><th scope="col">Example</th></tr></thead><tbody>
${idForms.map(([level, form, where, example]) => `<tr><td>${esc(level)}</td><td class="nowrap"><code>${esc(form)}</code></td><td><code>${esc(where)}</code></td><td>${example === 'db/tenancy.int' ? `<span class="chk">${example}</span>` : L(example)}</td></tr>`).join('\n')}
</tbody></table></div>
<dl class="defs">
  <dt>${pill('st-verified', 'Verified')}</dt><dd>Built, and an automated check fails if it breaks.</dd>
  <dt>${pill('st-implemented', 'Implemented')}</dt><dd>Built, but nothing automated proves it.</dd>
  <dt>${pill('st-partial', 'Partial')}</dt><dd>Built with a known shortfall, named by a gap or a backlog item.</dd>
  <dt>${pill('st-in-review', 'In review')}</dt><dd>Built in an open pull request (features only).</dd>
  <dt>${pill('st-planned', 'Planned')}</dt><dd>Agreed, not built. A planned feature names the backlog item that builds it.</dd>
  <dt>${pill('st-deferred', 'Deferred')}</dt><dd>Set aside by decision. Every <i>Won’t</i> is Deferred.</dd>
  <dt>Priority</dt><dd>MoSCoW: Must, Should, Could, Won’t (for now). It ranks requirements; the backlog’s P1–P3 ranks work, on purpose a different scale.</dd>
  <dt>Phase</dt><dd>P0 Foundations, P1 Golden path, P2 Automate, P3 iPhone and scale, P4 Horizon (docs/07).</dd>
</dl>
<h3>What keeps it true</h3>
<ul>
  <li><b>CI checks the records against the code.</b> Every reference must resolve: sources to a doc section or ADR, checks to a named test that exists, code to a real path. Every API operation, page, workflow, flag, ADR, test file and capability-map cell must be traced. A requirement can’t be more done than its weakest feature, and an open gap must have an open backlog item. A pull request that breaks any of this fails gate G2.</li>
  <li><b>A change in behaviour updates the records in the same pull request,</b> with a change-log entry. A new requirement from you is added as Planned, and Claude proposes the features, decision and checks it needs.</li>
  <li><b>This page is republished after every successful release,</b> never after a merge, so “live” means live. A page whose production commit is behind production is stale, and shows it.</li>
  <li><b>The code is the source of truth for what exists; these records for what is required.</b> Where they disagree, the gap goes under Coverage and gaps, not silently into either.</li>
</ul>
</section>`;

  // Trace model
  const nodes: [string, string, string, string][] = [
    ['Business objective', 'BO-n', 'Why ExpenseWise exists', `${OBJECTIVES.length}`],
    ['Requirement', 'FR · NFR', 'What must be true', `${REQUIREMENTS.length}`],
    ['Feature', 'F-nn', 'What a person can do', `${FEATURES.length}`],
    ['Decision', 'ADR-nnnn', 'Why it is built this way', `${citedAdrs.size}`],
    ['Code', 'paths', 'Where it is built', '–'],
    ['Check', 'tests · CI', 'What fails when it breaks', `${tests.size}`],
  ];
  const edges = ['served by', 'satisfied by', 'decided in', 'built in', 'proved by'];
  const model = `<section id="trace-model" aria-labelledby="tm-h"><h2 id="tm-h">Trace model</h2>
<p class="note">Read down for scope: each objective is served by requirements, each requirement satisfied by features, each feature decided, built and proved. Read up for confidence: a requirement is only as far along as its weakest feature.</p>
<figure class="chain" aria-label="Trace model">
${nodes
  .map(
    ([name, form, what, n], i) =>
      `<div class="node"><span class="node-n">${esc(n)}</span><b>${esc(name)}</b><code>${esc(form)}</code><span class="note">${esc(what)}</span></div>${i < edges.length ? `<div class="edge"><span>${esc(edges[i]!)}</span></div>` : ''}`,
  )
  .join('\n')}
</figure>
<p class="note">Beside the chain: a <b>gap</b> (GAP-nn) or <b>backlog item</b> (#n) makes a requirement or feature Partial and names what closes it; a <b>question</b> (Qn) is a decision only you can make.</p>
</section>`;

  // Objectives
  const objectives = `<section id="objectives" aria-labelledby="bo-h"><h2 id="bo-h">Business objectives</h2>
<p>Eight objectives follow from the vision’s outcome measures, its six challenges to the brief and the four personas. Three carry a numeric target today; ${L('Q4')} asks which apply while you are the only user.</p>
<div class="table-wrap"><table><thead><tr><th scope="col">Id</th><th scope="col">Objective</th><th scope="col">How we would know</th><th scope="col">For</th><th scope="col">Source</th><th scope="col">Served by</th></tr></thead><tbody>
${OBJECTIVES.map((o) => `<tr id="${o.id}"><td class="id">${o.id}</td><td class="wide">${T(o.title)}</td><td>${T(o.measure)}</td><td>${esc(o.personas.join(', ') || 'Product owner and Claude')}</td><td>${sourceLinks(o.sources)}</td><td><div class="refs">${o.areas.map((a) => `<a class="ref" href="#area-${a}">${a}</a>`).join('')}</div></td></tr>`).join('\n')}
</tbody></table></div>
</section>`;

  const reqSummary = (rs: readonly Requirement[]) =>
    STATUSES.map((s) => [s, count(rs, (r) => r.status === s)] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s.toLowerCase()}`)
      .join(', ');

  const areaTable = (area: Area, rs: readonly Requirement[]) => {
    const nfr = area.kind === 'NFR';
    const head = nfr
      ? '<th scope="col">Id</th><th scope="col">Requirement</th><th scope="col">How it is enforced</th><th scope="col">Source</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">Verified by</th>'
      : '<th scope="col">Id</th><th scope="col">Requirement</th><th scope="col">Source</th><th scope="col">Priority</th><th scope="col">Status</th><th scope="col">Features</th><th scope="col">Verified by</th>';
    const rows = rs
      .map((r) => {
        const extra = [...(r.shortfalls ?? []), ...(r.backlog ?? []).map((n) => `#${n}`)];
        const stories = STORIES.filter((st) => st.requirements.includes(r.id)).map((st) => st.id);
        const text = `${T(r.text)}${r.note ? `<p class="sub">${T(r.note)}</p>` : ''}${stories.length ? `<p class="sub">Stories: ${stories.map(L).join(' ')}</p>` : ''}`;
        const priority = `${esc(r.priority)}<div class="sub">${r.phase}</div>`;
        const features = r.features?.length
          ? `<div class="refs">${r.features.map(L).join('')}</div>`
          : '<span class="note">–</span>';
        const cells = nfr
          ? `<td class="wide">${text}</td><td>${T(r.enforcedBy ?? '')}${r.features?.length ? `<div class="refs sub">${r.features.map(L).join('')}</div>` : ''}</td><td>${sourceLinks(r.sources)}</td><td>${priority}</td><td>${statusCell(r.status, extra)}</td><td>${checkLinks(r.checks)}</td>`
          : `<td class="wide">${text}</td><td>${sourceLinks(r.sources)}</td><td>${priority}</td><td>${statusCell(r.status, extra)}</td><td>${features}</td><td>${checkLinks(r.checks)}</td>`;
        return `<tr id="${r.id}" data-row data-tags="${r.status}|${r.priority}"><td class="id">${r.id}</td>${cells}</tr>`;
      })
      .join('\n');
    return `<div class="area" id="area-${area.code}"><h3>${esc(area.name)} <span class="code-tag">${area.code}</span></h3><p class="note">${esc(area.blurb)} ${rs.length} requirements: ${reqSummary(rs)}.</p>
<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>
${rows}
</tbody></table></div></div>`;
  };

  const kindSection = (kind: 'FR' | 'NFR', rs: readonly Requirement[]) => {
    const areas = AREAS.filter((a) => a.kind === kind);
    const id = kind === 'FR' ? 'functional' : 'non-functional';
    const title = kind === 'FR' ? 'Functional requirements' : 'Non-functional requirements';
    const intro =
      kind === 'FR'
        ? `ExpenseWise has ${rs.length} functional requirements in ${areas.length} areas, one per row of the capability map: ${reqSummary(rs)}. Every capability-map cell is delivered by at least one of them, whatever its phase.`
        : `ExpenseWise has ${rs.length} non-functional requirements in ${areas.length} areas: ${reqSummary(rs)}. Each says how it is enforced.`;
    return `<section id="${id}" aria-labelledby="${id}-h"><h2 id="${id}-h">${title}</h2>
<p>${intro} Priorities are proposals for you to correct; status follows the evidence.</p>
${areas
  .map((a) =>
    areaTable(
      a,
      rs.filter((r) => areaOf(r) === a.code),
    ),
  )
  .join('\n')}
</section>`;
  };

  // Features
  const groups = [...new Set(FEATURES.map((f) => f.group))];
  const featureSummary = FEATURE_STATUSES.map(
    (s) => [s, count(FEATURES, (f) => f.status === s)] as const,
  )
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s.toLowerCase()}`)
    .join(', ');
  const pathLink = (p: string) => {
    const dir = !/\.[a-z]+$/.test(p);
    const href = `https://github.com/${ctx.repo}/${dir ? 'tree' : 'blob'}/${ctx.recordsSha}/${p}`;
    return `<a class="chk" href="${esc(href)}" target="_blank" rel="noopener">${esc(p.replace(/^packages\//, ''))}</a>`;
  };
  const serves = (f: Feature) => {
    const parts = [
      ...(f.screens ?? []).map((s) => `page <code>${esc(s)}</code>`),
      ...(f.api ?? []).map((a) => `<code>${esc(a)}</code>`),
      ...(f.workflows ?? []).map((w) => `workflow <code>${esc(w)}</code>`),
      ...(f.flags ?? []).map((w) => `flag <code>${esc(w)}</code>`),
    ];
    return parts.length ? `<p class="sub">Serves ${parts.join(' · ')}</p>` : '';
  };
  const featureRows = (fs: readonly Feature[]) =>
    fs
      .map((f) => {
        const extra = [
          ...(f.shortfalls ?? []),
          ...(f.backlog !== undefined ? [`#${f.backlog}`] : []),
        ];
        const delivered = f.review
          ? `<div class="sub">${T(`PR #${f.review}`)}</div>`
          : f.delivered
            ? `<div class="sub">${T(f.delivered)}</div>`
            : '';
        const usedBy = REQUIREMENTS.filter((r) => r.features?.includes(f.id)).map((r) => r.id);
        return `<tr id="${f.id}" data-row data-tags="${f.status}"><td class="id">${f.id}</td><td class="wide"><b>${esc(f.title)}</b> <span class="kind">${f.kind}</span>${serves(f)}${f.note ? `<p class="sub">${T(f.note)}</p>` : ''}<p class="sub">For ${usedBy.map(L).join(' ')}</p></td><td class="nowrap">${f.phase}</td><td>${statusCell(f.status, extra)}${delivered}</td><td>${f.decisions?.length ? `<div class="refs">${f.decisions.map(L).join('')}</div>` : '<span class="note">–</span>'}</td><td>${f.code?.length ? `<div class="refs">${f.code.map(pathLink).join('')}</div>` : '<span class="note">–</span>'}</td><td>${checkLinks(f.checks)}</td></tr>`;
      })
      .join('\n');
  const features = `<section id="features" aria-labelledby="f-h"><h2 id="f-h">Feature inventory</h2>
<p>ExpenseWise has ${FEATURES.length} features: ${featureSummary}. Each claims the API operations, pages, workflows and flags it serves; CI fails when one appears that no feature claims. <i>Foundation</i> features are rules built and tested ahead of the screens that will use them.</p>
${groups
  .map(
    (
      g,
    ) => `<h3>${esc(g)}</h3><div class="table-wrap"><table><thead><tr><th scope="col">Id</th><th scope="col">Feature</th><th scope="col">Phase</th><th scope="col">Status</th><th scope="col">Decisions</th><th scope="col">Code</th><th scope="col">Checks</th></tr></thead><tbody>
${featureRows(FEATURES.filter((f) => f.group === g))}
</tbody></table></div>`,
  )
  .join('\n')}
</section>`;

  // Coverage: verified share by area, then the capability map
  const areaRows = AREAS.map((a) => {
    const rs = REQUIREMENTS.filter((r) => areaOf(r) === a.code);
    const byStatus = STATUSES.map((s) => [s, count(rs, (r) => r.status === s)] as const);
    return {
      a,
      rs,
      byStatus,
      share: pct(
        count(rs, (r) => r.status === 'Verified'),
        rs.length,
      ),
    };
  }).sort((x, y) => x.share - y.share || y.rs.length - x.rs.length);
  const widest = Math.max(...areaRows.map((r) => r.rs.length));
  const order: readonly Status[] = ['Partial', 'Implemented', 'Planned', 'Deferred', 'Verified'];
  const bars = areaRows
    .map(({ a, rs, byStatus, share }) => {
      const segs = order
        .map((s) => [s, byStatus.find(([b]) => b === s)![1]] as const)
        .filter(([, n]) => n > 0)
        .map(
          ([s, n]) =>
            `<span class="seg ${statusClass(s)}" style="flex-grow:${n}" title="${esc(`${a.name}: ${n} ${s.toLowerCase()}`)}">${n}</span>`,
        )
        .join('');
      return `<div class="bar-row"><a class="bar-label" href="#area-${a.code}">${esc(a.name)} <span class="code-tag">${a.kind}</span></a><div class="bar" style="width:${Math.max(18, (rs.length * 100) / widest)}%" role="img" aria-label="${esc(
        `${a.name}: ${byStatus
          .filter(([, n]) => n)
          .map(([s, n]) => `${n} ${s.toLowerCase()}`)
          .join(', ')}`,
      )}">${segs}</div><span class="bar-pct">${share}%</span></div>`;
    })
    .join('\n');

  const capMap = capabilityMap();
  const capAreas = [...new Set(capMap.map((c) => c.area))];
  const rankOf: Record<Status, number> = {
    Verified: 4,
    Implemented: 3,
    Partial: 2,
    Planned: 1,
    Deferred: 0,
  };
  const capCell = (area: string, phase: string) => {
    const caps = capMap.filter((c) => c.area === area && c.phase === phase);
    if (!caps.length) return '<td class="cap-empty"><span aria-hidden="true">–</span></td>';
    return `<td><div class="caps">${caps
      .map((c) => {
        const rs = REQUIREMENTS.filter((r) => r.capabilities?.includes(c.key));
        const weakest = rs.reduce<Status>(
          (w, r) => (rankOf[r.status] < rankOf[w] ? r.status : w),
          'Verified',
        );
        return `<a class="cap ${statusClass(weakest)}" href="#${rs[0]!.id}" title="${esc(rs.map((r) => `${r.id}: ${r.status}`).join('\n'))}">${esc(c.name)}<span class="sr"> (${weakest})</span></a>`;
      })
      .join('')}</div></td>`;
  };
  const capTable = `<div class="table-wrap"><table class="capmap"><caption class="sr">Capability map coverage: each capability, coloured by the weakest requirement that delivers it</caption><thead><tr><th scope="col">Area</th><th scope="col">P1 · Golden path</th><th scope="col">P2 · Automate</th><th scope="col">P3 · iPhone and scale</th><th scope="col">P4 · Horizon</th></tr></thead><tbody>
${capAreas.map((area) => `<tr><th scope="row">${esc(area)}</th>${['P1', 'P2', 'P3', 'P4'].map((p) => capCell(area, p)).join('')}</tr>`).join('\n')}
</tbody></table></div>`;

  const gapRows = GAPS.map(
    (g) =>
      `<tr id="${g.id}"><td class="id">${g.id}</td><td class="wide">${T(g.title)}${g.closed ? `<p class="sub">Closed ${esc(g.closed.date)}: ${T(g.closed.note)}</p>` : ''}</td><td><div class="refs">${g.affects.map(L).join('')}</div></td><td>${pill(`sv-${g.severity.toLowerCase()}`, g.severity)}</td><td>${T(g.evidence)}</td><td>${T(g.fix)}</td><td>${L(`#${g.backlog}`)}</td></tr>`,
  ).join('\n');

  const capCovered = capMap.length;
  const capP1 = capMap.filter((c) => c.phase === 'P1');
  const capP1Done = capP1.filter((c) =>
    REQUIREMENTS.filter((r) => r.capabilities?.includes(c.key)).every(
      (r) => r.status === 'Verified',
    ),
  ).length;

  const legend = `<p class="legend">${(['Verified', 'Implemented', 'Partial', 'Planned', 'Deferred'] as const).map((s) => pill(statusClass(s), s)).join(' ')}</p>`;
  const coverage = `<section id="coverage" aria-labelledby="cov-h"><h2 id="cov-h">Coverage and gaps</h2>
<p>${verified} of ${REQUIREMENTS.length} requirements (${pct(verified, REQUIREMENTS.length)}%) are verified by a check that fails when they break. ${count(REQUIREMENTS, (r) => r.status === 'Partial')} are partial, ${count(REQUIREMENTS, (r) => r.status === 'Implemented')} built with no check, ${count(REQUIREMENTS, (r) => r.status === 'Planned')} planned and ${count(REQUIREMENTS, (r) => r.status === 'Deferred')} deferred. Most of the planned ones are Phase 1 work still ahead.</p>
<h3>Verified share by area</h3>
<p class="note">Bar length is the number of requirements in the area; the figure is the share verified. Read top down for where to invest next.</p>
<div class="bars">${bars}</div>
${legend}
<h3>The capability map, traced</h3>
<p class="note">Every one of the ${capCovered} capabilities in the scope contract, coloured by the weakest requirement that delivers it. ${capP1Done} of the ${capP1.length} Phase 1 capabilities are fully verified.</p>
${capTable}
<h3>Gaps found while tracing</h3>
<p>${plural(openGaps.length, 'gap')} ${openGaps.length === 1 ? 'is' : 'are'} open, each with the backlog item that closes it. I verified each in the code or the deployment settings; the evidence column says where.</p>
<div class="table-wrap"><table><thead><tr><th scope="col">Id</th><th scope="col">Gap</th><th scope="col">Affects</th><th scope="col">Severity</th><th scope="col">Evidence</th><th scope="col">Proposed fix</th><th scope="col">Backlog</th></tr></thead><tbody>
${gapRows}
</tbody></table></div>
</section>`;

  // Questions
  const questions = `<section id="questions" aria-labelledby="q-h"><h2 id="q-h">Open questions</h2>
<p>${QUESTIONS.length} decisions are yours to make; ${openQuestions.length} ${openQuestions.length === 1 ? 'is' : 'are'} open. Each confirms a requirement or closes a gap. Answer in a comment on this page or in the conversation; the answer is recorded here and the page republished.</p>
<div class="questions">
${QUESTIONS.map(
  (q) => `<article class="q${q.answer ? ' answered' : ''}" id="${q.id}">
  <header><span class="q-id">${q.id}</span><h3>${esc(q.title)}</h3>${q.answer ? '<span class="pill st-verified">Answered</span>' : '<span class="pill st-partial">Open</span>'}</header>
  <p><b>${T(q.ask)}</b></p>
  <p class="note">${T(q.why)}</p>
  ${q.recommendation ? `<p><span class="eyebrow">My recommendation</span> ${T(q.recommendation)}</p>` : ''}
  ${q.answer ? `<p class="answer"><span class="eyebrow">Answered ${esc(q.answer.date)}</span> ${T(q.answer.text)}</p>` : ''}
  <p class="sub">Affects ${q.affects.map(L).join(' ')}</p>
</article>`,
).join('\n')}
</div>
</section>`;

  const changes = `<section id="changes" aria-labelledby="cl-h"><h2 id="cl-h">Change log</h2>
<div class="table-wrap"><table><thead><tr><th scope="col">Date</th><th scope="col">Change</th><th scope="col">By</th></tr></thead><tbody>
${CHANGE_LOG.map((c) => `<tr><td class="nowrap">${esc(c.date)}</td><td class="wide">${T(c.change)}</td><td>${T(c.by)}</td></tr>`).join('\n')}
</tbody></table></div>
</section>`;

  const docList = Object.values(DOCS);
  const sources = `<section id="sources" aria-labelledby="src-h"><h2 id="src-h">Sources</h2>
<p class="note">All in the repository at ${ext(githubCommit(ctx, ctx.recordsSha), `<code>${short(ctx.recordsSha)}</code>`)}.</p>
<ul>
${docList.map((d) => `<li>${ext(githubFile(ctx, d), `<code>${esc(d)}</code>`)}</li>`).join('\n')}
<li>${ext(githubFile(ctx, 'docs/adr'), '<code>docs/adr/</code>')}: ${adrs().length} decision records; ${citedAdrs.size} cited here, superseded ones aside</li>
<li>${ext(githubFile(ctx, 'packages/api/openapi.json'), '<code>packages/api/openapi.json</code>')}, the pages in <code>apps/web/app</code>, the workflow functions and the flag registry: what is built</li>
<li>${tests.size} test files and the CI jobs in <code>.github/workflows/</code>: what is proved</li>
</ul>
</section>`;

  const toc = `<nav class="toc" aria-label="Contents"><p class="eyebrow">Contents</p><ol>
  <li><a href="#how">How this works</a></li>
  <li><a href="#trace-model">Trace model</a></li>
  <li><a href="#objectives">Objectives</a></li>
  <li><a href="#functional">Functional</a></li>
  <li><a href="#non-functional">Non-functional</a></li>
  <li><a href="#features">Features</a></li>
  <li><a href="#coverage">Coverage and gaps</a></li>
  <li><a href="#questions">Open questions (${openQuestions.length})</a></li>
  <li><a href="#changes">Change log</a></li>
  <li><a href="#sources">Sources</a></li>
</ol></nav>`;

  const body = `<div class="page">
${hero}
<div class="layout">
${toc}
<main>
${filterBar('Filter requirements and features', [...FEATURE_STATUSES, 'Must'], 'requirements and features')}
${how}
${model}
${objectives}
${kindSection('FR', FUNCTIONAL)}
${kindSection('NFR', NON_FUNCTIONAL)}
${features}
${coverage}
${questions}
${changes}
${sources}
</main>
</div>
<p class="foot">Generated by <code>tools/records</code> from the records at ${ext(githubCommit(ctx, ctx.recordsSha), `<code>${short(ctx.recordsSha)}</code>`)}. Republished after each successful release, never after a merge, so this page describes what is live. The backlog is ${ctx.urls.backlog ? ext(ctx.urls.backlog, 'its own page') : 'its own page'}.</p>
</div>`;

  return frame(TRACEABILITY_TITLE, TRACE_CSS, body, FILTER_SCRIPT);
}

const TRACE_CSS = `
.code-tag { font: 500 0.7rem/1 var(--mono); letter-spacing: 0.06em; color: var(--ink-3); border: 1px solid var(--rule-strong); border-radius: 4px; padding: 2px 5px; vertical-align: middle; }
.area { display: grid; gap: 8px; scroll-margin-top: 96px; }
.kind { font: 500 0.68rem/1 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); }
.chain { margin: 0; display: grid; grid-template-columns: repeat(11, auto); align-items: stretch; gap: 0; overflow-x: auto; padding-bottom: 4px; }
.node { background: var(--sheet); border: 1px solid var(--rule); border-radius: 6px; padding: 10px 12px; display: grid; gap: 3px; min-width: 8.5rem; position: relative; }
.node b { font-family: var(--display); font-size: 1rem; }
.node code { justify-self: start; }
.node .note { font-size: 0.8rem; }
.node-n { position: absolute; top: 8px; right: 10px; font: 600 0.95rem/1 var(--display); color: var(--carbon); font-variant-numeric: tabular-nums; }
.edge { display: grid; place-items: center; min-width: 4.5rem; position: relative; }
.edge::before { content: ""; position: absolute; left: 4px; right: 8px; top: 50%; border-top: 1.5px solid var(--rule-strong); }
.edge::after { content: ""; position: absolute; right: 4px; top: calc(50% - 4px); border: 4px solid transparent; border-left: 6px solid var(--rule-strong); }
.edge span { position: relative; background: var(--paper); padding: 0 4px; font: 500 0.68rem/1.2 var(--mono); color: var(--ink-3); text-align: center; transform: translateY(-11px); }
.bars { display: grid; gap: 6px; }
.bar-row { display: grid; grid-template-columns: 15rem minmax(0, 1fr) 3rem; gap: 10px; align-items: center; }
.bar-label { color: var(--ink); text-decoration: none; font-size: 0.9rem; display: flex; gap: 6px; align-items: center; justify-content: space-between; }
.bar { display: flex; height: 22px; border-radius: 4px; overflow: hidden; border: 1px solid var(--rule); }
.seg { display: grid; place-items: center; font: 500 0.72rem/1 var(--mono); min-width: 0; overflow: hidden; border-right: 1px solid var(--sheet); }
.seg:last-child { border-right: 0; }
.bar-pct { font: 500 0.85rem/1 var(--mono); text-align: right; font-variant-numeric: tabular-nums; }
.legend { display: flex; flex-wrap: wrap; gap: 6px; }
table.capmap th[scope="row"] { font: 600 0.9rem/1.3 var(--body); text-transform: none; letter-spacing: 0; color: var(--ink); background: var(--sheet); white-space: nowrap; }
table.capmap td { min-width: 11rem; }
.caps { display: flex; flex-wrap: wrap; gap: 4px; }
.cap { font-size: 0.8rem; text-decoration: none; padding: 2px 8px; border-radius: 4px; border: 1px solid transparent; }
.cap.st-planned { border-color: var(--rule-strong); border-style: dashed; }
.cap-empty { color: var(--rule-strong); }
.questions { display: grid; gap: 12px; }
.q { background: var(--sheet); border: 1px solid var(--rule); border-left: 4px solid var(--warn); border-radius: 6px; padding: 12px 16px; display: grid; gap: 6px; max-width: 86ch; scroll-margin-top: 96px; }
.q.answered { border-left-color: var(--ok); }
.q header { display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: baseline; }
.q-id { font: 600 0.95rem/1 var(--mono); color: var(--carbon); }
.q .eyebrow { display: inline; margin-right: 6px; }
.answer { border-top: 1px dashed var(--rule-strong); padding-top: 6px; }
@media (max-width: 900px) {
  .chain { grid-template-columns: minmax(0, 1fr); overflow-x: visible; }
  .edge { min-height: 2.4rem; min-width: 0; }
  .edge::before { left: 50%; right: auto; top: 4px; bottom: 8px; border-top: 0; border-left: 1.5px solid var(--rule-strong); }
  .edge::after { left: calc(50% - 4px); right: auto; top: auto; bottom: 2px; border: 4px solid transparent; border-top: 6px solid var(--rule-strong); }
  .edge span { transform: none; margin-left: 5.5rem; background: transparent; }
}
@media (max-width: 700px) {
  .bar-row { grid-template-columns: minmax(0, 1fr) 3rem; }
  .bar-label { grid-column: 1 / -1; }
}
`;
