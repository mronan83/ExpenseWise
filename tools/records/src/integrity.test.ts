import { describe, expect, it } from 'vitest';
import { problems, resolveCheck, resolveSource } from './integrity.ts';
import { aliasOf, capabilityMap } from './repo.ts';

describe('the records', () => {
  it('agree with themselves and with the repository', () => {
    expect(problems()).toEqual([]);
  });
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
