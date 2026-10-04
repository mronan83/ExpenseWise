import { describe, expect, it } from 'vitest';
import { featureSwitch } from './features.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';

/** An organization whose own switch reads `switched`, counting how often it is asked. */
function organization(switched: boolean) {
  const asked: string[] = [];
  const inOrg = <T>(orgId: string): Promise<T> => {
    asked.push(orgId);
    return Promise.resolve(switched as T);
  };
  return { inOrg, asked };
}

describe('a feature switch, read in a workflow', () => {
  it('follows the organization’s own switch when the server forces nothing', async () => {
    const on = organization(true);
    expect(await featureSwitch(on.inOrg, undefined)(ORG, 'receipts.field-sources')).toBe(true);
    expect(on.asked).toEqual([ORG]);
    const off = organization(false);
    expect(await featureSwitch(off.inOrg, '')(ORG, 'receipts.field-sources')).toBe(false);
  });

  it('lets FLAG_OVERRIDES win, either way, without asking the organization', async () => {
    const on = organization(true);
    const killed = featureSwitch(on.inOrg, 'receipts.field-sources=off');
    expect(await killed(ORG, 'receipts.field-sources')).toBe(false);
    const off = organization(false);
    const forced = featureSwitch(off.inOrg, 'receipts.field-sources=on');
    expect(await forced(ORG, 'receipts.field-sources')).toBe(true);
    expect([...on.asked, ...off.asked]).toEqual([]);
    // Another flag's override decides nothing for this one.
    expect(await forced(ORG, 'receipts.capture-time')).toBe(false);
    expect(off.asked).toEqual([ORG]);
  });
});
