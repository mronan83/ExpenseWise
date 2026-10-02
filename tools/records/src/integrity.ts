import { FLAG_KEYS } from '@expensewise/flags';
import { BACKLOG, SEQUENCING } from './backlog.ts';
import { FEATURES } from './features.ts';
import type { Feature, FeatureStatus, Requirement, Status } from './model.ts';
import { AREAS, OBJECTIVES } from './objectives.ts';
import {
  adrs,
  apiOperations,
  capabilityMap,
  ciJobs,
  decisionIds,
  DOCS,
  exists,
  fileText,
  testFiles,
  webRoutes,
  workflowIds,
} from './repo.ts';
import { REQUIREMENTS } from './requirements.ts';
import { CHANGE_LOG, GAPS, QUESTIONS } from './tracing.ts';

/** What a check reference points at, once resolved. */
export interface ResolvedCheck {
  readonly ref: string;
  readonly alias: string;
  /** The test file, or the workflow file for a CI job. */
  readonly file: string;
  readonly title?: string;
}

const CHECK_SEPARATOR = ' › ';

/** Resolves `alias` or `alias › test title` or `ci:job`. Throws when it doesn't resolve. */
export function resolveCheck(ref: string, files = testFiles()): ResolvedCheck {
  if (ref.startsWith('ci:')) {
    if (!ciJobs().has(ref)) throw new Error(`no CI job ${ref}`);
    const file = ref === 'ci:codeql' ? '.github/workflows/codeql.yml' : '.github/workflows/ci.yml';
    return { ref, alias: ref, file };
  }
  const [alias, title] = ref.split(CHECK_SEPARATOR) as [string, string | undefined];
  const file = files.get(alias);
  if (!file) throw new Error(`no test file with the alias ${alias}`);
  if (title !== undefined && !fileText(file).includes(title)) {
    throw new Error(`no test "${title}" in ${file}`);
  }
  return title === undefined ? { ref, alias, file } : { ref, alias, file, title };
}

/** Where a source reference points: a file to link to, or nothing for a decision or a PR. */
export function resolveSource(ref: string): { readonly file?: string; readonly label: string } {
  const adr = /^ADR-(\d{4})$/.exec(ref);
  if (adr) {
    const found = adrs().find((a) => a.id === ref);
    if (!found) throw new Error(`no ${ref}`);
    return { file: found.path, label: ref };
  }
  if (/^D-\d+$/.test(ref)) {
    if (!decisionIds().has(ref)) throw new Error(`no ${ref} in the decision register`);
    return { file: 'docs/README.md', label: ref };
  }
  if (/^PR #\d+$/.test(ref)) return { label: ref };
  const m = /^([a-z]+) (.+)$/.exec(ref);
  const doc = m ? DOCS[m[1]!] : undefined;
  if (!m || !doc) throw new Error(`"${ref}" is not a source reference`);
  const token = m[2]!;
  const text = fileText(doc);
  const section = /^§(\d+\.\d+)$/.exec(token);
  const increment = /^inc (\d+)$/.exec(token);
  const found = section
    ? new RegExp(`^#{2,3} ${section[1]!.replace('.', '\\.')}\\b`, 'm').test(text)
    : increment
      ? text.includes(`| ${increment[1]} · `)
      : /^P[0-4]$/.test(token)
        ? text.includes(`${token} ·`)
        : new RegExp(`\\b${token}\\b`).test(text);
  if (!found) throw new Error(`"${token}" not found in ${doc}`);
  return { file: doc, label: ref };
}

const RANK: Record<FeatureStatus, number> = {
  Verified: 4,
  Implemented: 3,
  Partial: 2,
  'In review': 1,
  Planned: 1,
  Deferred: 0,
};

const BUILT: readonly FeatureStatus[] = ['Verified', 'Implemented', 'Partial'];

/** Every token in free text that names another record. */
const INLINE_REF =
  /\b(?:NFR|FR)-[A-Z]+-\d{2}\b|\bF-\d{2}\b|\bGAP-\d{2}\b|\bBO-\d+\b|\bQ\d+\b|\bADR-\d{4}\b|(?<!PR )#\d+\b/g;

/**
 * Every way the records can disagree with themselves or with the repository. Empty means
 * the records hold. The page generator refuses to publish while anything is listed here.
 */
export function problems(): string[] {
  const out: string[] = [];
  const fail = (where: string, what: string) => out.push(`${where}: ${what}`);
  const tests = testFiles();

  // Identity: every id is unique and well formed.
  const ids = new Map<string, string>();
  const register = (id: string, kind: string, pattern: RegExp) => {
    if (!pattern.test(id)) fail(id, `not a valid ${kind} id`);
    if (ids.has(id)) fail(id, `used twice`);
    ids.set(id, kind);
  };
  OBJECTIVES.forEach((o) => register(o.id, 'objective', /^BO-\d+$/));
  REQUIREMENTS.forEach((r) => register(r.id, 'requirement', /^(FR|NFR)-[A-Z]+-\d{2}$/));
  FEATURES.forEach((f) => register(f.id, 'feature', /^F-\d{2}$/));
  GAPS.forEach((g) => register(g.id, 'gap', /^GAP-\d{2}$/));
  QUESTIONS.forEach((q) => register(q.id, 'question', /^Q\d+$/));
  const items = new Map(BACKLOG.map((b) => [b.num, b]));
  if (items.size !== BACKLOG.length) fail('backlog', 'a number is used twice');
  const open = (num: number) => items.has(num) && !items.get(num)!.done;
  const openGap = (id: string) => GAPS.some((g) => g.id === id && !g.closed);
  const known = (id: string) => ids.has(id) || /^ADR-\d{4}$/.test(id) || /^#\d+$/.test(id);

  const adrList = adrs();
  const adrIds = new Set(adrList.map((a) => a.id));
  const referencedAdrs = new Set<string>();
  const checkSource = (where: string, ref: string) => {
    try {
      resolveSource(ref);
      if (ref.startsWith('ADR-')) referencedAdrs.add(ref);
    } catch (error) {
      fail(where, (error as Error).message);
    }
  };
  const referencedTests = new Set<string>();
  const checkCheck = (where: string, ref: string) => {
    try {
      const resolved = resolveCheck(ref, tests);
      referencedTests.add(resolved.alias);
    } catch (error) {
      fail(where, (error as Error).message);
    }
  };
  const checkShortfall = (where: string, ref: string) => {
    if (/^#\d+$/.test(ref)) {
      if (!open(Number(ref.slice(1)))) fail(where, `${ref} is not an open backlog item`);
    } else if (!openGap(ref)) fail(where, `${ref} is not an open gap`);
  };
  const checkText = (where: string, text: string | undefined) => {
    for (const [token] of (text ?? '').matchAll(INLINE_REF)) {
      if (token.startsWith('#')) {
        if (!items.has(Number(token.slice(1)))) fail(where, `${token} is not a backlog item`);
      } else if (token.startsWith('ADR-')) {
        if (!adrIds.has(token)) fail(where, `${token} does not exist`);
      } else if (!ids.has(token)) fail(where, `${token} does not exist`);
    }
  };

  // Objectives
  const areaCodes = new Set(AREAS.map((a) => a.code));
  for (const o of OBJECTIVES) {
    o.sources.forEach((s) => checkSource(o.id, s));
    o.areas.forEach((a) => areaCodes.has(a) || fail(o.id, `no area ${a}`));
  }
  for (const a of AREAS) {
    if (!OBJECTIVES.some((o) => o.areas.includes(a.code))) fail(a.code, 'serves no objective');
    if (!REQUIREMENTS.some((r) => areaOf(r) === a.code)) fail(a.code, 'has no requirements');
  }

  // Features
  const features = new Map(FEATURES.map((f) => [f.id, f]));
  for (const f of FEATURES) {
    f.decisions?.forEach((d) => {
      if (!adrIds.has(d)) fail(f.id, `no ${d}`);
      referencedAdrs.add(d);
    });
    f.checks?.forEach((c) => checkCheck(f.id, c));
    f.shortfalls?.forEach((s) => checkShortfall(f.id, s));
    checkText(f.id, f.note);
    out.push(...featureStatusProblems(f));
    if (BUILT.includes(f.status)) {
      f.code?.forEach((p) => exists(p) || fail(f.id, `${p} does not exist`));
    }
    if (f.status === 'Planned' && (f.backlog === undefined || !open(f.backlog))) {
      fail(f.id, 'a planned feature names the open backlog item that builds it');
    }
    if (!REQUIREMENTS.some((r) => r.features?.includes(f.id))) {
      fail(f.id, 'no requirement needs it');
    }
  }

  // Requirements
  const capabilities = capabilityMap();
  const capabilityKeys = new Set(capabilities.map((c) => c.key));
  for (const r of REQUIREMENTS) {
    const area = AREAS.find((a) => a.code === areaOf(r));
    if (!area) fail(r.id, 'no such area');
    else if (!r.id.startsWith(`${area.kind}-`)) fail(r.id, `${area.code} holds ${area.kind}s`);
    r.sources.forEach((s) => checkSource(r.id, s));
    if (r.sources.length === 0) fail(r.id, 'has no source');
    r.checks?.forEach((c) => checkCheck(r.id, c));
    r.shortfalls?.forEach((s) => checkShortfall(r.id, s));
    r.backlog?.forEach((n) => open(n) || fail(r.id, `#${n} is not an open backlog item`));
    r.capabilities?.forEach(
      (c) => capabilityKeys.has(c) || fail(r.id, `"${c}" is not in the capability map`),
    );
    if (r.capabilities && r.id.startsWith('NFR')) fail(r.id, 'capabilities are for FRs');
    if (r.id.startsWith('NFR') && !r.enforcedBy) fail(r.id, 'says how it is enforced');
    checkText(r.id, `${r.text} ${r.note ?? ''} ${r.enforcedBy ?? ''}`);
    const linked = (r.features ?? []).map((id) => {
      const f = features.get(id);
      if (!f) fail(r.id, `no feature ${id}`);
      return f;
    });
    out.push(
      ...requirementStatusProblems(
        r,
        linked.filter((f): f is Feature => f !== undefined),
      ),
    );
  }
  for (const c of capabilities) {
    if (!REQUIREMENTS.some((r) => r.capabilities?.includes(c.key))) {
      fail(c.key, `capability (${c.phase}) is delivered by no requirement`);
    }
  }

  // The code is fully claimed: every operation, page, workflow and flag, exactly once.
  const claims = (
    what: string,
    actual: readonly string[],
    claimed: (f: Feature) => readonly string[] | undefined,
  ) => {
    const owners = new Map<string, string[]>();
    for (const f of FEATURES) {
      for (const c of claimed(f) ?? []) owners.set(c, [...(owners.get(c) ?? []), f.id]);
    }
    for (const a of actual) {
      const o = owners.get(a) ?? [];
      if (o.length === 0) fail(a, `${what} claimed by no feature`);
      if (o.length > 1) fail(a, `${what} claimed by ${o.join(' and ')}`);
    }
    for (const c of owners.keys()) {
      if (!actual.includes(c))
        fail(c, `${what} claimed by ${owners.get(c)!.join(', ')} does not exist`);
    }
  };
  claims('API operation', apiOperations(), (f) => f.api);
  claims('page', webRoutes(), (f) => f.screens);
  claims('workflow', workflowIds(), (f) => f.workflows);
  claims('flag', FLAG_KEYS, (f) => f.flags);

  // Every decision and every test file is traced.
  for (const a of adrList) {
    if (!a.superseded && !referencedAdrs.has(a.id))
      fail(a.id, 'no requirement or feature cites it');
  }
  for (const alias of tests.keys()) {
    if (!referencedTests.has(alias)) fail(alias, 'test file verifies no requirement or feature');
  }

  // Gaps and the backlog agree.
  for (const g of GAPS) {
    const item = items.get(g.backlog);
    if (!item) fail(g.id, `#${g.backlog} does not exist`);
    else if (Boolean(g.closed) !== Boolean(item.done)) {
      fail(
        g.id,
        `${g.closed ? 'closed' : 'open'}, but #${g.backlog} is ${item.done ? 'done' : 'open'}`,
      );
    }
    g.affects.forEach((a) => known(a) || fail(g.id, `affects unknown ${a}`));
    checkText(g.id, `${g.title} ${g.evidence} ${g.fix}`);
  }
  for (const q of QUESTIONS) {
    q.affects.forEach((a) => known(a) || fail(q.id, `affects unknown ${a}`));
    checkText(q.id, `${q.ask} ${q.why} ${q.recommendation ?? ''} ${q.answer?.text ?? ''}`);
  }
  for (const b of BACKLOG) {
    const where = `#${b.num}`;
    b.affects?.forEach((a) => known(a) || fail(where, `affects unknown ${a}`));
    checkText(where, `${b.title} ${b.detail}`);
    if (b.blocker.kind === 'items') {
      for (const n of b.blocker.items) {
        if (n === b.num) fail(where, 'waits on itself');
        else if (!open(n) && !b.done) fail(where, `waits on #${n}, which is not open`);
      }
    }
    if (b.done && !/^\d{4}-\d{2}-\d{2}$/.test(b.done.date)) fail(where, 'done date is YYYY-MM-DD');
  }
  SEQUENCING.forEach((s, i) => checkText(`sequencing note ${i + 1}`, s));

  // The change log reads newest first.
  CHANGE_LOG.forEach((entry, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) fail('change log', `${entry.date} is not a date`);
    const next = CHANGE_LOG[i + 1];
    if (next && next.date > entry.date) fail('change log', 'is not newest first');
    checkText('change log', entry.change);
  });

  return out;
}

export const areaOf = (r: Requirement) => r.id.split('-')[1]!;

function featureStatusProblems(f: Feature): string[] {
  const out: string[] = [];
  const fail = (what: string) => out.push(`${f.id}: ${f.status}, ${what}`);
  const checks = f.checks?.length ?? 0;
  const shortfalls = f.shortfalls?.length ?? 0;
  if (BUILT.includes(f.status) && !f.code?.length) fail('but no code is named');
  if (BUILT.includes(f.status) && !f.delivered) fail('but no delivering PR is named');
  if (f.status === 'Verified' && (checks === 0 || shortfalls > 0)) {
    fail('needs a check and no open shortfall');
  }
  if (f.status === 'Implemented' && (checks > 0 || shortfalls > 0)) {
    fail('has checks or shortfalls: Verified or Partial instead');
  }
  if (f.status === 'Partial' && shortfalls === 0)
    fail('needs a shortfall that names what is missing');
  if (f.status === 'In review' && f.review === undefined) fail('needs its pull request number');
  if (!BUILT.includes(f.status) && (checks > 0 || f.code?.length)) {
    fail('but names code or checks, so it is built');
  }
  return out;
}

function requirementStatusProblems(r: Requirement, linked: readonly Feature[]): string[] {
  const out: string[] = [];
  const fail = (what: string) => out.push(`${r.id}: ${r.status}, ${what}`);
  const checks = r.checks?.length ?? 0;
  const shortfalls = r.shortfalls?.length ?? 0;
  const status: Status = r.status;
  if ((r.priority === "Won't") !== (status === 'Deferred')) {
    fail("Won't and Deferred go together");
  }
  if (status === 'Verified' && (checks === 0 || shortfalls > 0)) {
    fail('needs a check and no open shortfall');
  }
  if (status === 'Implemented' && (checks > 0 || shortfalls > 0)) {
    fail('has checks or shortfalls: Verified or Partial instead');
  }
  if (status === 'Partial' && shortfalls === 0)
    fail('needs a shortfall that names what is missing');
  if ((status === 'Planned' || status === 'Deferred') && (checks > 0 || shortfalls > 0)) {
    fail('but names checks or shortfalls, so something is built');
  }
  if (status === 'Planned' || status === 'Deferred') {
    const built = linked.filter((f) => f.kind !== 'foundation' && BUILT.includes(f.status));
    if (built.length > 0) fail(`but ${built.map((f) => f.id).join(', ')} is built`);
  } else {
    // A requirement is only as done as its weakest feature.
    const weakest = linked.find((f) => RANK[f.status] < RANK[status]);
    if (weakest) fail(`but ${weakest.id} is only ${weakest.status}`);
    if (r.id.startsWith('FR') && linked.length === 0) fail('but no feature delivers it');
  }
  return out;
}
