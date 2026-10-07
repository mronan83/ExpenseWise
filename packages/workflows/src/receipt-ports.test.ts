import type { FlagKey } from '@expensewise/flags';
import { describe, expect, it } from 'vitest';
import { extractorOptions } from './receipt-ports.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';

/** An organization with these switches on, noting which it is asked about. */
function switches(...on: FlagKey[]) {
  const asked: FlagKey[] = [];
  const switchOn = (orgId: string, flag: FlagKey) => {
    asked.push(flag);
    return Promise.resolve(orgId === ORG && on.includes(flag));
  };
  return { switchOn, asked };
}

describe('what a reading asks the models', () => {
  it('asks for nothing more with neither switch on, as every reading always has', async () => {
    const { switchOn, asked } = switches();
    expect(await extractorOptions(switchOn, ORG)).toEqual({
      fieldSources: false,
      journeys: false,
      purchases: false,
    });
    expect(asked).toEqual(['receipts.field-sources', 'receipts.journeys', 'receipts.purchases']);
  });

  it('asks for journeys and stays only where receipts.journeys is on, whatever source lines are', async () => {
    expect(await extractorOptions(switches('receipts.journeys').switchOn, ORG)).toEqual({
      fieldSources: false,
      journeys: true,
      purchases: false,
    });
    expect(await extractorOptions(switches('receipts.field-sources').switchOn, ORG)).toEqual({
      fieldSources: true,
      journeys: false,
      purchases: false,
    });
    const both = switches('receipts.field-sources', 'receipts.journeys');
    expect(await extractorOptions(both.switchOn, ORG)).toEqual({
      fieldSources: true,
      journeys: true,
      purchases: false,
    });
    // Another organization's switches decide nothing here.
    expect(await extractorOptions(both.switchOn, 'another-org')).toEqual({
      fieldSources: false,
      journeys: false,
      purchases: false,
    });
  });

  it('asks for several purchases only where receipts.purchases is on (FR-INT-23)', async () => {
    expect(await extractorOptions(switches('receipts.purchases').switchOn, ORG)).toEqual({
      fieldSources: false,
      journeys: false,
      purchases: true,
    });
    const all = switches('receipts.field-sources', 'receipts.journeys', 'receipts.purchases');
    expect(await extractorOptions(all.switchOn, ORG)).toEqual({
      fieldSources: true,
      journeys: true,
      purchases: true,
    });
    expect(await extractorOptions(all.switchOn, 'another-org')).toEqual({
      fieldSources: false,
      journeys: false,
      purchases: false,
    });
  });
});
