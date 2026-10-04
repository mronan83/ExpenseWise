import { FEATURES } from './features.ts';
import type { Decided, Requirement, Rule, Story } from './model.ts';
import { exists, fileText } from './repo.ts';
import { REQUIREMENTS } from './requirements.ts';
import { RULES } from './rules.ts';
import { STORIES } from './stories/index.ts';
import { QUESTIONS } from './tracing.ts';

const BUILT = ['Verified', 'Implemented', 'Partial'];
const isBuilt = (status: string) => BUILT.includes(status);
const fromOwner = (r: Requirement) => r.sources.some((s) => s.startsWith('owner '));

/** What the story checks need from the main integrity pass. */
export interface StoryCheckContext {
  readonly fail: (where: string, what: string) => void;
  readonly checkText: (where: string, text: string | undefined) => void;
  readonly checkSource: (where: string, ref: string) => void;
  readonly checkCheck: (where: string, ref: string) => void;
  /** An open backlog item. */
  readonly open: (num: number) => boolean;
}

/**
 * The user stories and the rule register hold: every built requirement and feature has a
 * story, every criterion of a built story is proved by a test or names the open item that
 * adds one, every decision is attributed to a source that exists, and every rule the code
 * keeps has the value written in the register (NFR-DEL-09).
 */
export function storyProblems(
  c: StoryCheckContext,
  records: { readonly stories: readonly Story[]; readonly rules: readonly Rule[] } = {
    stories: STORIES,
    rules: RULES,
  },
): void {
  const { fail } = c;
  const requirements = new Map(REQUIREMENTS.map((r) => [r.id, r]));
  const features = new Map(FEATURES.map((f) => [f.id, f]));
  const rules = new Map(records.rules.map((r) => [r.id, r]));
  const citedRules = new Set<string>();

  const checkDecided = (where: string, d: Decided) => {
    if (d.by === 'owner') {
      const q = /^Q\d+$/.test(d.source) ? QUESTIONS.find((x) => x.id === d.source) : undefined;
      if (/^Q\d+$/.test(d.source)) {
        if (!q) fail(where, `${d.source} does not exist`);
        else if (!q.answer) fail(where, `${d.source} is not answered, so it decided nothing`);
      } else if (!/^owner \d{4}-\d{2}-\d{2}$/.test(d.source)) {
        fail(where, `an owner decision cites "owner YYYY-MM-DD" or the question, not ${d.source}`);
      } else c.checkSource(where, d.source);
    } else if (d.by === 'blueprint') {
      if (d.source.startsWith('owner ')) fail(where, 'the product owner’s own word is by: owner');
      c.checkSource(where, d.source);
    } else if (d.source) c.checkSource(where, d.source);
  };

  // Rules
  for (const r of records.rules) {
    checkDecided(r.id, r.decided);
    c.checkText(r.id, `${r.name} ${r.value} ${r.note ?? ''}`);
    if (r.code) {
      const { file, constant, literal } = r.code;
      if (!exists(file)) fail(r.id, `${file} does not exist`);
      else {
        const line = fileText(file)
          .split('\n')
          .find((l) => new RegExp(`\\b${constant}\\b\\s*=`).test(l));
        if (!line) fail(r.id, `${file} has no ${constant}`);
        else if (!line.includes(`= ${literal}`)) {
          fail(
            r.id,
            `${constant} in ${file} is not ${literal}: the code and the register disagree`,
          );
        }
      }
    }
  }

  // Stories
  const covered = new Set<string>();
  const coveredFeatures = new Set<string>();
  for (const s of records.stories) {
    const built = s.status !== 'Planned';
    if (s.feature) {
      const f = features.get(s.feature);
      if (!f) fail(s.id, `no feature ${s.feature}`);
      else if (built && !isBuilt(f.status)) fail(s.id, `${s.status}, but ${f.id} is ${f.status}`);
      if (built) coveredFeatures.add(s.feature);
    }
    if (s.requirements.length === 0) fail(s.id, 'names no requirement');
    for (const id of s.requirements) {
      const r = requirements.get(id);
      if (!r) fail(s.id, `no requirement ${id}`);
      else if (built && !isBuilt(r.status)) fail(s.id, `${s.status}, but ${id} is ${r.status}`);
      covered.add(`${id}:${built ? 'built' : 'planned'}`);
    }
    for (const field of [s.title, s.as, s.want, s.soThat]) {
      if (!field.trim()) fail(s.id, 'has an empty title, persona, want or reason');
    }
    c.checkText(s.id, `${s.title} ${s.as} ${s.want} ${s.soThat} ${s.note ?? ''}`);
    checkCriteria(s);
  }

  function checkCriteria(s: Story) {
    if (s.criteria.length === 0) fail(s.id, 'has no acceptance criteria');
    let untested = 0;
    s.criteria.forEach((a, i) => {
      const where = `${s.id} ${a.id}`;
      if (a.id !== `AC${i + 1}`)
        fail(where, `should be AC${i + 1}: criteria are numbered in order`);
      if (!a.given.trim() || !a.when.trim() || !a.then.trim())
        fail(where, 'needs Given, When and Then');
      checkDecided(where, a.decided);
      c.checkText(where, `${a.given} ${a.when} ${a.then}`);
      a.rules?.forEach((r) => {
        if (!rules.has(r)) fail(where, `no rule ${r}`);
        citedRules.add(r);
      });
      a.checks.forEach((ref) => c.checkCheck(where, ref));
      if (s.status === 'Planned') {
        if (a.checks.length > 0 || a.untested !== undefined) {
          fail(where, 'is planned, so nothing proves it yet');
        }
        return;
      }
      if (a.checks.length === 0) {
        untested++;
        if (a.untested === undefined)
          fail(where, 'is built but no test proves it: name the open item that adds one');
        else if (!c.open(a.untested)) fail(where, `#${a.untested} is not an open backlog item`);
      } else if (a.untested !== undefined) fail(where, 'has a test, so it is not untested');
    });
    if (s.status === 'Delivered' && untested > 0)
      fail(s.id, 'Delivered, but a criterion is untested: Partial');
    if (s.status === 'Partial' && untested === 0)
      fail(s.id, 'Partial, but every criterion is tested: Delivered');
  }

  // Coverage: the whole build, and every requirement the product owner gave.
  for (const r of REQUIREMENTS) {
    if (isBuilt(r.status) && !covered.has(`${r.id}:built`)) {
      fail(r.id, `${r.status}, but no delivered story covers it`);
    }
    if (
      r.status === 'Planned' &&
      fromOwner(r) &&
      !covered.has(`${r.id}:planned`) &&
      !covered.has(`${r.id}:built`)
    ) {
      fail(r.id, 'yours and planned, but no story details it');
    }
  }
  for (const f of FEATURES) {
    // A foundation is rules built ahead of the screens that use them; its requirements carry it.
    if (f.kind !== 'foundation' && isBuilt(f.status) && !coveredFeatures.has(f.id)) {
      fail(f.id, `${f.status}, but no delivered story covers it`);
    }
  }
  for (const r of records.rules) {
    if (!citedRules.has(r.id)) fail(r.id, 'no acceptance criterion uses it');
  }
}
