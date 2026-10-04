import type { Transaction } from '@expensewise/db';
import { describe, expect, it } from 'vitest';
import { featureOn } from './features.ts';
import { readingPlanFor } from './reading-plan.ts';

const saved = {
  primary: 'gpt-5.6-luna',
  models: [
    { model: 'claude-haiku-4-5', enabled: true },
    { model: 'gpt-5.6-luna', enabled: true },
    { model: 'claude-sonnet-5-5', enabled: false },
  ],
  updatedAt: new Date('2026-10-04T12:00:00Z'),
};

describe('the plan for a reading', () => {
  it('reads side by side, as before, while AI model settings are off', () => {
    expect(readingPlanFor({ settingsOn: false, saved })).toEqual({
      mode: 'compare',
      stopped: [],
    });
  });

  it('reads with the primary, then the back-ups that are on, once they are on', () => {
    expect(readingPlanFor({ settingsOn: true, saved })).toEqual({
      mode: 'primary',
      order: ['gpt-5.6-luna', 'claude-haiku-4-5'],
    });
    // Before anyone saves a choice: the defaults.
    expect(readingPlanFor({ settingsOn: true })).toEqual({
      mode: 'primary',
      order: ['claude-sonnet-5-5', 'claude-haiku-4-5', 'gpt-5.6-luna'],
    });
  });

  it('leaves out a model whose provider has no key: it stays off', () => {
    expect(readingPlanFor({ settingsOn: true, saved, keyed: new Set(['anthropic']) })).toEqual({
      mode: 'primary',
      order: ['claude-haiku-4-5'],
    });
    expect(readingPlanFor({ settingsOn: true, keyed: new Set() })).toEqual({
      mode: 'primary',
      order: [],
    });
  });

  it('leaves out a model the operator stopped, whatever the organization chose', () => {
    const overrides = 'operator.gpt-5.6-luna=off,operator.claude-sonnet-5-5=off';
    expect(readingPlanFor({ settingsOn: true, saved, overrides })).toEqual({
      mode: 'primary',
      order: ['claude-haiku-4-5'],
    });
    expect(readingPlanFor({ settingsOn: false, overrides })).toEqual({
      mode: 'compare',
      stopped: ['claude-sonnet-5-5', 'gpt-5.6-luna'],
    });
    // An operator switch set on changes nothing: each organization decides.
    expect(
      readingPlanFor({ settingsOn: true, saved, overrides: 'operator.gpt-5.6-luna=on' }),
    ).toEqual({ mode: 'primary', order: ['gpt-5.6-luna', 'claude-haiku-4-5'] });
  });
});

describe('a feature, as a workflow reads it', () => {
  // The override decides before the organization's switch is read.
  const unread = {} as Transaction;

  it('lets the server’s override win over the organization’s switch', async () => {
    expect(
      await featureOn(unread, 'org', 'receipts.model-settings', 'receipts.model-settings=on'),
    ).toBe(true);
    expect(
      await featureOn(unread, 'org', 'receipts.model-settings', 'receipts.model-settings=off'),
    ).toBe(false);
  });
});
