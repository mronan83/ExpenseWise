import { newId } from '@expensewise/domain';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { getExpense } from '../src/expenses.ts';
import { editMileage, getMileage, logMileage } from '../src/mileage.ts';
import { listMileageRateChanges, mileagePolicy, setMileageRate } from '../src/mileage-rates.ts';
import { auditEvents, members, orgMileageRates, organizations } from '../src/schema.ts';
import { connectAs, expectDbError, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const TODAY = '2026-10-04';
const toAirport = {
  date: '2026-09-22',
  destination: 'IAH, George Bush Intercontinental',
  purpose: 'Drive to the airport for the Acme onsite',
  miles: '38.4',
};

async function workspace(name: string) {
  const org = await seedOrg(app.db, name);
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const actor = { userId: org.userId, memberId: org.memberId };
  const set = (effectiveFrom: string, perMile: string | null) =>
    inOrg((tx) => setMileageRate(tx, org.orgId, { effectiveFrom, perMile }, actor));
  const log = async (input: Partial<typeof toAirport> = {}) => {
    const logged = await inOrg((tx) =>
      logMileage(tx, org.orgId, org.memberId, { ...toAirport, ...input }, org.userId, TODAY),
    );
    if (logged.status !== 'logged') throw new Error(`expected a drive, got ${logged.status}`);
    return logged.expenseId;
  };
  const edit = (id: string, input: Parameters<typeof editMileage>[4]) =>
    inOrg((tx) => editMileage(tx, org.orgId, org.memberId, id, input, org.userId, TODAY));
  const drive = async (id: string) => ({
    mileage: await inOrg((tx) => getMileage(tx, org.memberId, id)),
    expense: await inOrg((tx) => getExpense(tx, id)),
  });
  const audit = () =>
    inOrg((tx) =>
      tx
        .select({
          action: auditEvents.action,
          actorId: auditEvents.actorId,
          entityId: auditEvents.entityId,
          payload: auditEvents.payload,
        })
        .from(auditEvents)
        .where(and(eq(auditEvents.orgId, org.orgId), eq(auditEvents.entityType, 'mileage_rate')))
        .orderBy(asc(auditEvents.sequence)),
    );
  return { org, inOrg, set, log, edit, drive, audit };
}

describe('the organization’s own rate a mile (Q28, #77)', () => {
  it('sets its own rate a mile from a day, in its home currency, each change in the audit trail', async () => {
    const w = await workspace('rates-set');
    await w.inOrg((tx) =>
      tx
        .update(organizations)
        .set({ homeCurrency: 'EUR' })
        .where(eq(organizations.id, w.org.orgId)),
    );
    const set = await w.set('2026-09-01', '0.65');
    expect(set.status).toBe('set');
    expect(await w.inOrg((tx) => listMileageRateChanges(tx))).toEqual([
      {
        id: expect.any(String) as string,
        effectiveFrom: '2026-09-01',
        rate: {
          currency: 'EUR',
          perUnit: '0.6500',
          unit: 'mi',
          effectiveFrom: '2026-09-01',
          source: 'organization',
        },
        setBy: 'rates-set',
        setAt: expect.any(Date) as Date,
      },
    ]);
    // The same again records nothing; a new rate for the day replaces it.
    expect(await w.set('2026-09-01', '0.650')).toEqual({
      status: 'unchanged',
      id: (set as { id: string }).id,
    });
    expect(await w.set('2026-09-01', '0.70')).toEqual(set);
    const changes = await w.inOrg((tx) => listMileageRateChanges(tx));
    expect(changes.map((c) => [c.effectiveFrom, c.rate?.perUnit])).toEqual([
      ['2026-09-01', '0.7000'],
    ]);
    expect(await w.audit()).toEqual([
      {
        action: 'mileage_rate.set',
        actorId: w.org.userId,
        entityId: changes[0]!.id,
        payload: {
          effectiveFrom: '2026-09-01',
          source: 'organization',
          perMile: '0.65',
          currency: 'EUR',
          replaced: null,
        },
      },
      {
        action: 'mileage_rate.set',
        actorId: w.org.userId,
        entityId: changes[0]!.id,
        payload: {
          effectiveFrom: '2026-09-01',
          source: 'organization',
          perMile: '0.70',
          currency: 'EUR',
          replaced: { source: 'organization', perMile: '0.6500', currency: 'EUR' },
        },
      },
    ]);
  });

  it('goes back to the IRS rate from a day, and refuses a rate that is not valid', async () => {
    const w = await workspace('rates-irs');
    await w.set('2026-03-01', '0.60');
    expect((await w.set('2026-06-01', null)).status).toBe('set');
    const policy = await w.inOrg((tx) => mileagePolicy(tx));
    expect(policy.irs.through).toBe('2026-12-31');
    expect(
      [...policy.own]
        .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
        .map((c) => [c.effectiveFrom, c.rate?.perUnit ?? 'irs']),
    ).toEqual([
      ['2026-03-01', '0.6000'],
      ['2026-06-01', 'irs'],
    ]);
    expect((await w.audit()).at(-1)?.payload).toEqual({
      effectiveFrom: '2026-06-01',
      source: 'irs-business',
      perMile: null,
      currency: null,
      replaced: null,
    });

    expect(await w.set('2026-07-01', '0')).toMatchObject({
      status: 'invalid',
      problem: { field: 'perMile' },
    });
    expect(await w.set('2026-02-30', '0.6')).toMatchObject({
      status: 'invalid',
      problem: { field: 'effectiveFrom' },
    });
    expect(await w.audit()).toHaveLength(2);
    // The database holds a rate and its currency together, and a rate more than zero.
    const row = { orgId: w.org.orgId, setByMemberId: w.org.memberId };
    await expectDbError(
      w.inOrg((tx) =>
        tx.insert(orgMileageRates).values({ ...row, effectiveFrom: '2026-08-01', perMile: '0.5' }),
      ),
      /org_mileage_rates_rate_and_currency/,
    );
    await expectDbError(
      w.inOrg((tx) =>
        tx
          .insert(orgMileageRates)
          .values({ ...row, effectiveFrom: '2026-08-01', perMile: '0', currency: 'USD' }),
      ),
      /org_mileage_rates_rate_positive/,
    );
  });

  it('logs and corrects a drive at its own rate, copied on with source organization', async () => {
    const w = await workspace('rates-log');
    await w.set('2026-09-01', '0.65');
    const id = await w.log();
    let { mileage, expense } = await w.drive(id);
    expect(mileage?.rate).toEqual({
      currency: 'USD',
      perUnit: '0.6500',
      unit: 'mi',
      effectiveFrom: '2026-09-01',
      source: 'organization',
    });
    // 38.4 mi × $0.65
    expect(expense).toMatchObject({ amountMinor: 2496, currency: 'USD' });

    // Moved before its rate took effect, it is priced again at the IRS rate of its new date.
    expect(await w.edit(id, { date: '2026-08-31' })).toMatchObject({ repriced: true });
    ({ mileage, expense } = await w.drive(id));
    expect(mileage?.rate).toMatchObject({ perUnit: '0.7250', source: 'irs-business' });
    expect(expense?.amountMinor).toBe(2784);
    // And back again, at the organization's own.
    await w.edit(id, { date: '2026-09-02', miles: '10' });
    ({ mileage, expense } = await w.drive(id));
    expect(mileage?.rate).toMatchObject({ perUnit: '0.6500', source: 'organization' });
    expect(expense?.amountMinor).toBe(650);
  });

  it('keeps a drive’s rate when the organization’s rate changes later', async () => {
    const w = await workspace('rates-snapshot');
    const id = await w.log();
    await w.set('2026-01-01', '0.50');
    await w.set('2026-09-01', '0.55');

    let { mileage, expense } = await w.drive(id);
    expect(mileage?.rate).toMatchObject({ perUnit: '0.7250', source: 'irs-business' });
    expect(expense?.amountMinor).toBe(2784);
    // A new destination prices nothing again, so it keeps the rate it was logged at.
    expect(await w.edit(id, { destination: 'Hobby Airport' })).toMatchObject({ repriced: false });
    ({ mileage, expense } = await w.drive(id));
    expect(mileage?.rate.source).toBe('irs-business');
    expect(expense?.amountMinor).toBe(2784);
  });

  it('keeps rates inside their organization, and every member reads them', async () => {
    const w = await workspace('rates-tenant-a');
    const other = await workspace('rates-tenant-b');
    await w.set('2026-09-01', '0.65');

    expect(await other.inOrg((tx) => tx.select().from(orgMileageRates))).toEqual([]);
    expect((await other.inOrg((tx) => mileagePolicy(tx))).own).toEqual([]);

    const memberId = newId();
    await w.inOrg((tx) =>
      tx.insert(members).values({
        id: memberId,
        orgId: w.org.orgId,
        userId: `user_${memberId}`,
        email: `${memberId}@example.com`,
        displayName: 'Jordan',
        role: 'member',
      }),
    );
    const asJordan = await withOrg(app.db, w.org.orgId, (tx) => mileagePolicy(tx), {
      member: { memberId, role: 'member' },
    });
    expect(asJordan.own.map((c) => c.rate?.perUnit)).toEqual(['0.6500']);
  });
});
