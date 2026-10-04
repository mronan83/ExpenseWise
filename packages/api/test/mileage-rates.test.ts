import type { Membership, MileageRateChangeRecord } from '@expensewise/db';
import { IRS_BUSINESS_RATES, ownMileageRate, type MemberRole } from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { MileageStore } from '../src/mileage.ts';
import type { MileageRateStore } from '../src/mileage-rates.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const NOW = new Date('2026-10-04T12:00:00.000Z');

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const ROLES: Record<string, MemberRole> = {
  riley: 'owner',
  sam: 'finance_admin',
  alex: 'member',
  jordan: 'approver',
  pat: 'auditor',
};

/** An in-memory rate store, checked by the domain's own rules, in US dollars. */
function fakeRates() {
  const changes: MileageRateChangeRecord[] = [];
  const set: { userId: string; memberId: string; effectiveFrom: string }[] = [];
  let next = 0;
  const store: MileageRateStore = {
    policy: () => Promise.resolve({ own: changes, irs: IRS_BUSINESS_RATES }),
    settings: () =>
      Promise.resolve({
        homeCurrency: 'USD',
        changes: [...changes].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)),
        policy: { own: changes, irs: IRS_BUSINESS_RATES },
      }),
    set: (_org, input, actor) => {
      const checked = ownMileageRate(input, 'USD');
      if (!checked.ok) return Promise.resolve({ status: 'invalid', problem: checked.error });
      set.push({ ...actor, effectiveFrom: checked.value.effectiveFrom });
      const i = changes.findIndex((c) => c.effectiveFrom === checked.value.effectiveFrom);
      const id = `rate-${next++}`;
      const record = { ...checked.value, id, setBy: actor.userId, setAt: NOW };
      if (i === -1) changes.push(record);
      else changes[i] = record;
      return Promise.resolve({ status: 'set', id });
    },
  };
  return { store, set };
}

function setup(flags = 'expenses.mileage=on') {
  const rates = fakeRates();
  const memberships: Record<string, Membership> = Object.fromEntries(
    Object.entries(ROLES).map(([user, role]) => [
      user,
      { orgId: ORG, memberId: `m-${user}`, role },
    ]),
  );
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    mileage: {} as MileageStore,
    mileageRates: rates.store,
    flagOverrides: flags,
    now: () => NOW,
  });
  const call = async (method: string, path: string, who: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown>,
    };
  };
  return { call, ...rates };
}

const IRS_TODAY = {
  perUnit: '0.725',
  currency: 'USD',
  unit: 'mi',
  effectiveFrom: '2026-01-01',
  source: 'irs-business',
};

describe('the organization’s rate a mile (Q28, #77)', () => {
  it('shows every member the rate in force today, where it comes from, and each change', async () => {
    const s = setup();
    const first = await s.call('GET', '/v1/mileage-rates', 'alex');
    expect(first).toEqual({
      status: 200,
      body: {
        today: '2026-10-04',
        inForce: { rate: IRS_TODAY, problem: null },
        changes: [],
        homeCurrency: 'USD',
        irsThrough: '2026-12-31',
        canChange: false,
      },
    });
    await s.call('PUT', '/v1/settings/mileage-rates/2026-09-01', 'riley', { perMile: '0.65' });
    const after = await s.call('GET', '/v1/mileage-rates', 'alex');
    expect(after.body).toMatchObject({
      inForce: {
        rate: { perUnit: '0.65', effectiveFrom: '2026-09-01', source: 'organization' },
      },
      changes: [
        {
          effectiveFrom: '2026-09-01',
          source: 'organization',
          perMile: '0.65',
          currency: 'USD',
          setBy: 'riley',
          setAt: NOW.toISOString(),
        },
      ],
    });
    expect((await s.call('GET', '/v1/mileage-rates', 'riley')).body.canChange).toBe(true);
  });

  it('lets an owner or finance admin set their own rate from a day, or go back to the IRS rate', async () => {
    const s = setup();
    const own = await s.call('PUT', '/v1/settings/mileage-rates/2026-09-01', 'riley', {
      perMile: '0.65',
    });
    expect(own.status).toBe(200);
    const back = await s.call('PUT', '/v1/settings/mileage-rates/2026-10-01', 'sam', {
      perMile: null,
    });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({
      inForce: { rate: IRS_TODAY },
      changes: [
        { effectiveFrom: '2026-10-01', source: 'irs-business', perMile: null, currency: null },
        { effectiveFrom: '2026-09-01', source: 'organization', perMile: '0.65' },
      ],
      canChange: true,
    });
    expect(s.set).toEqual([
      { userId: 'riley', memberId: 'm-riley', effectiveFrom: '2026-09-01' },
      { userId: 'sam', memberId: 'm-sam', effectiveFrom: '2026-10-01' },
    ]);
  });

  it.each(['alex', 'jordan', 'pat'])(
    'refuses %s, who is neither an owner nor a finance admin, and changes nothing',
    async (who) => {
      const s = setup();
      const res = await s.call('PUT', '/v1/settings/mileage-rates/2026-09-01', who, {
        perMile: '0.65',
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden_role');
      expect(s.set).toEqual([]);
    },
  );

  it('names the field that is not valid, and sets nothing', async () => {
    const s = setup();
    const zero = await s.call('PUT', '/v1/settings/mileage-rates/2026-09-01', 'riley', {
      perMile: '0',
    });
    expect(zero.status).toBe(422);
    expect(zero.body).toMatchObject({ code: 'invalid_value', field: 'perMile' });
    const day = await s.call('PUT', '/v1/settings/mileage-rates/2026-02-30', 'riley', {
      perMile: '0.65',
    });
    expect(day.body).toMatchObject({ code: 'invalid_value', field: 'effectiveFrom' });
    const extra = await s.call('PUT', '/v1/settings/mileage-rates/2026-09-01', 'riley', {
      perMile: '0.65',
      currency: 'EUR',
    });
    expect(extra.status).toBe(400);
    expect(s.set).toEqual([]);
  });

  it('quotes a drive at the organization’s own rate, which has no last day known', async () => {
    const s = setup();
    await s.call('PUT', '/v1/settings/mileage-rates/2026-09-01', 'riley', { perMile: '0.65' });
    const quote = await s.call('GET', '/v1/mileage/quote?date=2026-09-22&miles=38.4', 'alex');
    expect(quote.body).toMatchObject({
      rate: { perUnit: '0.65', source: 'organization', effectiveFrom: '2026-09-01' },
      // 38.4 × $0.65 = $24.96
      amount: { amountMinor: 2496, currency: 'USD', decimal: '24.96' },
    });
    const before = await s.call('GET', '/v1/mileage/quote?date=2026-08-31&miles=10', 'alex');
    expect(before.body).toMatchObject({ rate: { source: 'irs-business' } });
  });

  it.each(['expenses.mileage=off', ''])(
    'answers 404 feature_off when mileage is off (%s), and sets nothing',
    async (flags) => {
      const s = setup(flags);
      const answers = await Promise.all([
        s.call('GET', '/v1/mileage-rates', 'riley'),
        s.call('PUT', '/v1/settings/mileage-rates/2026-09-01', 'riley', { perMile: '0.65' }),
      ]);
      expect(answers.map((a) => [a.status, a.body.code])).toEqual([
        [404, 'feature_off'],
        [404, 'feature_off'],
      ]);
      expect(s.set).toEqual([]);
    },
  );
});
