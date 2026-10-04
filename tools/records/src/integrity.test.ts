import { describe, expect, it } from 'vitest';
import { problems, resolveCheck, resolveSource } from './integrity.ts';
import { storyProblems } from './integrity-stories.ts';
import type { Rule, Story } from './model.ts';
import { aliasOf, capabilityMap } from './repo.ts';

/**
 * Reads every record, test file, doc and migration in the repository: about 1.5 s alone, and
 * several times that while the other packages' tests run beside it. Vitest's 5 s default
 * failed it under that load, so it has a budget of its own.
 */
const WHOLE_REPOSITORY_MS = 30_000;

describe('the records', () => {
  it(
    'agree with themselves and with the repository',
    () => {
      expect(problems()).toEqual([]);
    },
    WHOLE_REPOSITORY_MS,
  );
});

describe('references', () => {
  it('name test files by a short alias', () => {
    expect(aliasOf('packages/db/test/tenancy.int.test.ts')).toBe('db/tenancy.int');
    expect(aliasOf('packages/db/src/readiness.test.ts')).toBe('db/readiness');
    expect(aliasOf('packages/domain/src/lifecycle/expense.test.ts')).toBe(
      'domain/lifecycle/expense',
    );
    expect(aliasOf('apps/web/e2e/shell.spec.ts')).toBe('e2e/shell');
    expect(aliasOf('evals/src/datasets/cord.test.ts')).toBe('evals/datasets/cord');
    expect(aliasOf('tools/records/src/render.test.ts')).toBe('records/render');
  });

  it('resolve a named test, and refuse one that does not exist', () => {
    expect(
      resolveCheck('domain/approvals › blocks self-approval in any team, even for owners'),
    ).toMatchObject({
      file: 'packages/domain/src/approvals.test.ts',
    });
    expect(() => resolveCheck('domain/approvals › approves anything')).toThrow('no test');
    expect(() => resolveCheck('domain/nothing')).toThrow('no test file');
    expect(() => resolveCheck('ci:nothing')).toThrow('no CI job');
  });

  it('resolve sources to the doc that holds them, and refuse what is not there', () => {
    expect(resolveSource('journeys §4.6').file).toBe('docs/03-journeys-and-workflows.md');
    expect(resolveSource('arch AP5').file).toBe('docs/05-architecture.md');
    expect(resolveSource('roadmap inc 2').file).toBe('docs/07-roadmap.md');
    expect(resolveSource('owner 2026-10-02')).toEqual({ label: 'Product owner, 2026-10-02' });
    expect(resolveSource('ADR-0017').file).toMatch(/^docs\/adr\/0017-/);
    expect(() => resolveSource('arch AP99')).toThrow('not found');
    expect(() => resolveSource('ADR-9999')).toThrow('no ADR-9999');
    expect(() => resolveSource('somewhere')).toThrow('not a source reference');
  });

  it('read every cell of the capability map', () => {
    const map = capabilityMap();
    expect(map).toContainEqual(
      expect.objectContaining({ key: 'Capture · Camera and upload', phase: 'P1' }),
    );
    expect(map).toContainEqual(
      expect.objectContaining({ key: 'Governance · Budgets', phase: 'P4' }),
    );
    expect(map.length).toBeGreaterThan(50);
  });
});

describe('the user stories (NFR-DEL-09)', () => {
  /** The problems the story checks find in these stories and rules, against the real records. */
  const check = (stories: readonly Story[], rules: readonly Rule[] = []) => {
    const out: string[] = [];
    const guard = (where: string, run: () => unknown) => {
      try {
        run();
      } catch (error) {
        out.push(`${where}: ${(error as Error).message}`);
      }
    };
    storyProblems(
      {
        fail: (where, what) => out.push(`${where}: ${what}`),
        checkText: () => undefined,
        checkSource: (where, ref) => guard(where, () => resolveSource(ref)),
        checkCheck: (where, ref) => guard(where, () => resolveCheck(ref)),
        open: (num) => num === 66,
      },
      { stories, rules },
    );
    return out;
  };
  const story = (over: Partial<Story> = {}): Story => ({
    id: 'US-TST-01',
    title: 'A test story',
    as: 'Alex, who travels for work',
    want: 'a receipt held when I file it twice',
    soThat: 'it is never paid twice',
    feature: 'F-48',
    requirements: ['FR-INT-18'],
    status: 'Delivered',
    criteria: [
      {
        id: 'AC1',
        given: 'a copy',
        when: 'it is read',
        then: 'it is held',
        decided: { by: 'owner', source: 'owner 2026-10-04' },
        checks: ['db/duplicates.int › holds an exact copy: the same time, place and total'],
      },
    ],
    ...over,
  });
  const mine = (found: string[]) =>
    found.filter((p) => p.startsWith('US-TST') || p.startsWith('R-TST'));

  it('accepts a delivered story whose every criterion a test proves', () => {
    expect(mine(check([story()]))).toEqual([]);
  });

  it('refuses a built criterion no test proves, unless it names the open item that adds one', () => {
    const criterion = { ...story().criteria[0]!, checks: [] };
    expect(mine(check([story({ criteria: [criterion] })]))).toEqual([
      'US-TST-01 AC1: is built but no test proves it: name the open item that adds one',
      'US-TST-01: Delivered, but a criterion is untested: Partial',
    ]);
    expect(
      mine(check([story({ status: 'Partial', criteria: [{ ...criterion, untested: 66 }] })])),
    ).toEqual([]);
  });

  it('refuses a test that doesn’t exist, and a decision credited to a question that doesn’t', () => {
    const criterion = {
      ...story().criteria[0]!,
      checks: ['db/duplicates.int › holds everything forever'],
      decided: { by: 'owner', source: 'Q999' } as const,
    };
    expect(mine(check([story({ criteria: [criterion] })]))).toEqual([
      'US-TST-01 AC1: Q999 does not exist',
      'US-TST-01 AC1: no test "holds everything forever" in packages/db/test/duplicates.int.test.ts',
    ]);
  });

  it('refuses a rule whose value differs from the code', () => {
    const rule: Rule = {
      id: 'R-TST-WINDOW',
      name: 'Days a report stays open',
      value: '27 days',
      decided: { by: 'owner', source: 'owner 2026-10-04' },
      code: {
        file: 'packages/domain/src/reports.ts',
        constant: 'REPORT_WINDOW_DAYS',
        literal: '27',
      },
    };
    const used = story({
      criteria: [{ ...story().criteria[0]!, rules: ['R-TST-WINDOW'] }],
    });
    expect(mine(check([used], [rule]))).toEqual([
      'R-TST-WINDOW: REPORT_WINDOW_DAYS in packages/domain/src/reports.ts is not 27: the code and the register disagree',
    ]);
  });

  it('refuses a built requirement or feature that no delivered story covers', () => {
    const found = check([]);
    expect(found).toContain('FR-INT-18: Verified, but no delivered story covers it');
    expect(found).toContain('F-48: Verified, but no delivered story covers it');
  });
});
