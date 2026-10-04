import type { OrgFeature } from '@expensewise/db';
import { describe, expect, it } from 'vitest';
import { featureGate, ORG_FEATURE_KEYS } from '../src/features.ts';
import { ProblemError } from '../src/problem.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';

const storeWith = (switched: OrgFeature[]) =>
  ({
    listFeatures: () => Promise.resolve(switched),
    featureOn: (_org: string, flag: string) =>
      Promise.resolve(switched.find((f) => f.flag === flag)?.enabled ?? false),
  }) as unknown as WorkspaceStore;

describe('featureGate', () => {
  it('is off by default, on when the organization switches it, and the override beats both', async () => {
    const at = new Date('2026-10-04T12:00:00Z');
    const workspace = storeWith([
      { flag: 'expenses.mileage', enabled: true, updatedAt: at },
      { flag: 'reports.export', enabled: true, updatedAt: at },
    ]);
    const gate = featureGate({ workspace, flagOverrides: 'reports.export=off' });
    expect(await gate.isOn(ORG, 'expenses.mileage')).toBe(true);
    expect(await gate.isOn(ORG, 'reports.export')).toBe(false);
    expect(await gate.isOn(ORG, 'team.invites')).toBe(false);
    expect(await featureGate({}).isOn(ORG, 'expenses.mileage')).toBe(false);
    expect(await featureGate({ flagOverrides: 'team.invites=on' }).isOn(ORG, 'team.invites')).toBe(
      true,
    );
  });

  it('answers 404 feature_off for a feature that is off, so it looks absent', async () => {
    const gate = featureGate({ workspace: storeWith([]) });
    await expect(gate.require(ORG, 'expenses.mileage')).rejects.toBeInstanceOf(ProblemError);
    await expect(gate.require(ORG, 'expenses.mileage')).rejects.toMatchObject({
      status: 404,
      extra: { code: 'feature_off' },
    });
  });

  it('never offers the server’s own flags to an organization', () => {
    expect(ORG_FEATURE_KEYS.some((k) => k.startsWith('shell.'))).toBe(false);
    expect(ORG_FEATURE_KEYS).toContain('expenses.mileage');
  });
});
