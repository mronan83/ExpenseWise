import type { ExpenseRecord, Membership, MileageRecord } from '@expensewise/db';
import {
  applyMileageInput,
  isExpenseEditable,
  type MileageReimbursement,
} from '@expensewise/domain';
import { describe, expect, it } from 'vitest';
import { createApi } from '../src/app.ts';
import type { Identity } from '../src/auth.ts';
import type { ExpenseStore } from '../src/expenses.ts';
import type { MileageStore } from '../src/mileage.ts';
import type { WorkspaceStore } from '../src/workspace.ts';

const ORG = '0192f7a0-0000-7000-8000-0000000000a1';
const MEMBER = '0192f7a0-0000-7000-8000-0000000000b1';
const JORDAN = '0192f7a0-0000-7000-8000-0000000000b2';
const THEIRS = '0192f7a0-0000-7000-8000-0000000000e9';
const NOW = new Date('2026-10-04T12:00:00.000Z');

const identity = (userId: string): Identity => ({
  userId,
  email: `${userId}@example.com`,
  assuranceLevel: 'aal1',
  sessionId: 's',
  issuedAt: NOW,
});

const drive = {
  date: '2026-09-22',
  destination: 'IAH, George Bush Intercontinental',
  purpose: 'Drive to the airport for the Acme onsite',
  miles: '38.4',
};

/** An in-memory mileage store, priced by the domain's own rules. */
function fakeMileage() {
  const entries = new Map<string, { expense: ExpenseRecord; mileage: MileageRecord }>();
  const logged: { memberId: string; today: string }[] = [];
  let next = 0;
  const put = (
    id: string,
    memberId: string,
    values: typeof drive,
    { amount, rate }: Pick<MileageReimbursement, 'amount' | 'rate'>,
  ) => {
    const was = entries.get(id);
    entries.set(id, {
      expense: {
        id,
        memberId,
        owner: memberId === MEMBER ? 'riley' : 'jordan',
        status: was?.expense.status ?? 'ready',
        source: 'mileage',
        merchant: values.destination,
        transactionDate: values.date,
        currency: amount.currency,
        amountMinor: amount.amountMinor,
        receiptId: null,
        tripId: null,
        tripName: null,
        tripPinned: false,
        time: null,
        timeZone: null,
        address: null,
        city: null,
        region: null,
        country: null,
        reportId: null,
        tripReportId: null,
        justification: values.purpose,
        editedAt: was ? NOW : null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      mileage: {
        ...values,
        expenseId: id,
        memberId,
        status: was?.expense.status ?? 'ready',
        method: 'manual',
        unit: 'mi',
        rate,
        amountMinor: amount.amountMinor,
      },
    });
  };
  const store: MileageStore = {
    log: (_org, memberId, input, _actor, today) => {
      const applied = applyMileageInput(null, input, today);
      if (!applied.ok) return Promise.resolve({ status: 'invalid', problem: applied.error });
      const id = `0192f7a0-0000-7000-8000-00000000f0${String(next++).padStart(2, '0')}`;
      logged.push({ memberId, today });
      put(id, memberId, applied.value.values, applied.value.claim!);
      return Promise.resolve({ status: 'logged', expenseId: id });
    },
    get: (_org, memberId, id) => {
      const found = entries.get(id);
      return Promise.resolve(found?.expense.memberId === memberId ? found : undefined);
    },
    edit: (_org, memberId, id, input, _actor, today) => {
      const found = entries.get(id);
      if (found?.expense.memberId !== memberId) return Promise.resolve({ status: 'missing' });
      if (!isExpenseEditable(found.expense.status)) {
        return Promise.resolve({ status: 'not_editable', current: found.expense.status });
      }
      const applied = applyMileageInput(found.mileage, input, today);
      if (!applied.ok) return Promise.resolve({ status: 'invalid', problem: applied.error });
      const { values, changes, claim } = applied.value;
      if (changes.length === 0) return Promise.resolve({ status: 'unchanged' });
      const was = {
        amountMinor: found.mileage.amountMinor ?? 0,
        currency: found.mileage.rate.currency,
      };
      put(id, memberId, values, claim ?? { amount: was, rate: found.mileage.rate });
      return Promise.resolve({ status: 'edited', changes, repriced: claim !== null });
    },
  };
  return { store, entries, logged, put };
}

function setup(flags = 'expenses.mileage=on') {
  const mileage = fakeMileage();
  const memberships: Record<string, Membership> = {
    riley: { orgId: ORG, memberId: MEMBER, role: 'owner' },
  };
  const expenses = {
    edit: () => Promise.resolve({ status: 'mileage' }),
  } as unknown as ExpenseStore;
  const api = createApi({
    version: 't',
    verifyToken: (token) => Promise.resolve(identity(token)),
    workspace: {
      findMembership: (userId: string) => Promise.resolve(memberships[userId]),
      // No switch is on: the override alone decides, as the kill switch would.
      featureOn: () => Promise.resolve(false),
    } as unknown as WorkspaceStore,
    mileage: mileage.store,
    expenses,
    flagOverrides: flags,
    now: () => NOW,
  });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await api.request(path, {
      method,
      headers: {
        authorization: 'Bearer riley',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => null)) as Record<string, unknown> & {
        mileage?: Record<string, unknown>;
      },
    };
  };
  return { call, ...mileage };
}

describe('mileage (FR-CAP-03)', () => {
  it('logs a drive for the caller and answers with it as an expense, its rate copied on', async () => {
    const s = setup();
    const res = await s.call('POST', '/v1/mileage', drive);
    expect(res.status).toBe(201);
    expect(s.logged).toEqual([{ memberId: MEMBER, today: '2026-10-04' }]);
    expect(res.body).toMatchObject({
      status: 'ready',
      source: 'mileage',
      merchant: drive.destination,
      date: '2026-09-22',
      amount: { amountMinor: 2784, currency: 'USD', decimal: '27.84' },
      justification: drive.purpose,
      editable: true,
      proof: null,
      mileage: {
        date: '2026-09-22',
        destination: drive.destination,
        purpose: drive.purpose,
        miles: '38.4',
        unit: 'mi',
        method: 'manual',
        rate: {
          perUnit: '0.725',
          currency: 'USD',
          unit: 'mi',
          effectiveFrom: '2026-01-01',
          source: 'irs-business',
        },
      },
    });
    const opened = await s.call('GET', `/v1/mileage/${res.body.id as string}`);
    expect(opened).toEqual({ status: 200, body: res.body });
  });

  it('quotes what a drive would pay before it is logged', async () => {
    const s = setup();
    const res = await s.call('GET', '/v1/mileage/quote?date=2025-06-02&miles=12.3');
    expect(res).toEqual({
      status: 200,
      body: {
        date: '2025-06-02',
        miles: '12.3',
        rate: {
          perUnit: '0.70',
          currency: 'USD',
          unit: 'mi',
          effectiveFrom: '2025-01-01',
          source: 'irs-business',
        },
        // 12.3 × $0.70 = $8.61
        amount: { amountMinor: 861, currency: 'USD', decimal: '8.61' },
      },
    });
  });

  it('names the field that is not valid, and logs nothing', async () => {
    const s = setup();
    const zero = await s.call('POST', '/v1/mileage', { ...drive, miles: '0' });
    expect(zero.status).toBe(422);
    expect(zero.body).toMatchObject({ code: 'invalid_value', field: 'miles' });
    const later = await s.call('GET', '/v1/mileage/quote?date=2027-01-04&miles=3');
    expect(later.status).toBe(422);
    expect(later.body).toMatchObject({ field: 'date' });
    const unknown = await s.call('POST', '/v1/mileage', { ...drive, odometer: '45231' });
    expect(unknown.status).toBe(400);
    expect(s.logged).toEqual([]);
  });

  it('corrects a drive, pricing it again when its miles change', async () => {
    const s = setup();
    const { body } = await s.call('POST', '/v1/mileage', drive);
    const res = await s.call('PATCH', `/v1/mileage/${body.id as string}`, { miles: '40' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      amount: { amountMinor: 2900 },
      mileage: { miles: '40', rate: { perUnit: '0.725' } },
    });
    const empty = await s.call('PATCH', `/v1/mileage/${body.id as string}`, {});
    expect(empty.status).toBe(400);
  });

  it('refuses a change once the drive is submitted', async () => {
    const s = setup();
    const { body } = await s.call('POST', '/v1/mileage', drive);
    const id = body.id as string;
    const entry = s.entries.get(id)!;
    s.entries.set(id, { ...entry, expense: { ...entry.expense, status: 'approved' } });
    const res = await s.call('PATCH', `/v1/mileage/${id}`, { miles: '50' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'locked' });
  });

  it('opens and changes only the caller’s own drives', async () => {
    const s = setup();
    const claim = applyMileageInput(null, drive, '2026-10-04');
    if (!claim.ok) throw new Error(claim.error.message);
    s.put(THEIRS, JORDAN, claim.value.values, claim.value.claim!);
    expect((await s.call('GET', `/v1/mileage/${THEIRS}`)).body).toMatchObject({
      code: 'not_found',
    });
    expect((await s.call('PATCH', `/v1/mileage/${THEIRS}`, { miles: '1' })).status).toBe(404);
  });

  it('refuses editing a drive as an ordinary expense', async () => {
    const s = setup();
    const res = await s.call('PATCH', `/v1/expenses/${THEIRS}`, { amount: '99.00' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'mileage' });
  });

  it.each(['expenses.mileage=off', ''])(
    'answers 404 feature_off to every mileage operation when it is off (%s)',
    async (flags) => {
      const s = setup(flags);
      const answers = await Promise.all([
        s.call('GET', '/v1/mileage/quote?date=2026-09-22&miles=3'),
        s.call('POST', '/v1/mileage', drive),
        s.call('GET', `/v1/mileage/${THEIRS}`),
        s.call('PATCH', `/v1/mileage/${THEIRS}`, { miles: '3' }),
      ]);
      expect(answers.map((a) => [a.status, a.body.code])).toEqual([
        [404, 'feature_off'],
        [404, 'feature_off'],
        [404, 'feature_off'],
        [404, 'feature_off'],
      ]);
      expect(s.logged).toEqual([]);
    },
  );
});
