import { newId } from '@expensewise/domain';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { withOrg } from '../src/client.ts';
import { reportForExport } from '../src/report-export.ts';
import {
  categories,
  categoryTypes,
  expenseTypes,
  expenses,
  receiptDuplicates,
  receipts,
  reports,
  trips,
} from '../src/schema.ts';
import { connectAs, seedOrg } from './helpers.ts';

const app = connectAs('app');
afterAll(async () => {
  await app.pool.end();
});

const OPENED = new Date('2026-09-04T12:00:00Z');
const CLOSED = new Date('2026-09-05T08:30:00Z');

/** An organization with a closed report: a trip with three expenses, and a local expense. */
async function closedReport(name: string) {
  const org = await seedOrg(app.db, name);
  const inOrg = <T>(work: Parameters<typeof withOrg<T>>[2]) => withOrg(app.db, org.orgId, work);
  const reportId = newId();
  const otherReportId = newId();
  const tripId = newId();
  const travel = newId();
  const ids = await inOrg(async (tx) => {
    for (const [id, closedAt] of [
      [reportId, CLOSED],
      [otherReportId, null],
    ] as const) {
      await tx.insert(reports).values({
        id,
        orgId: org.orgId,
        memberId: org.memberId,
        title: 'Report from 4 Sept 2026',
        status: closedAt ? 'closed' : 'open',
        currency: 'USD',
        closesAt: new Date('2026-10-02T12:00:00Z'),
        closedAt,
        createdAt: OPENED,
      });
    }
    await tx.insert(trips).values({
      id: tripId,
      orgId: org.orgId,
      memberId: org.memberId,
      name: 'Chicago · partner review',
      purpose: 'Partner review',
      startDate: '2026-09-01',
      endDate: '2026-09-03',
      reportId,
    });
    await tx.insert(categories).values({ id: travel, orgId: org.orgId, name: 'Client travel' });
    const lodging = newId();
    await tx.insert(expenseTypes).values({ id: lodging, orgId: org.orgId, name: 'Hotel stay' });
    await tx
      .insert(categoryTypes)
      .values({ id: newId(), orgId: org.orgId, categoryId: travel, typeId: lodging });
    const expense = async (values: Partial<typeof expenses.$inferInsert>) => {
      const id = newId();
      await tx.insert(expenses).values({
        id,
        orgId: org.orgId,
        memberId: org.memberId,
        status: 'ready',
        source: 'manual',
        merchant: 'Uber',
        transactionDate: '2026-09-01',
        currency: 'USD',
        amountMinor: 3145,
        ...values,
      });
      return id;
    };
    return {
      hotel: await expense({
        tripId,
        merchant: 'Hotel Lindley',
        transactionDate: '2026-09-03',
        currency: 'EUR',
        amountMinor: 41_280,
        categoryId: travel,
        typeId: lodging,
        classifiedAt: new Date('2026-09-04T09:00:00Z'),
        notes: 'Two nights',
      }),
      ride: await expense({ tripId }),
      copy: await expense({ tripId, transactionDate: '2026-09-02' }),
      lunch: await expense({
        reportId,
        merchant: 'Zuni Café',
        transactionDate: '2026-09-02',
        amountMinor: 1225,
        justification: 'Lunch with the Acme architecture team',
      }),
      elsewhere: await expense({ reportId: otherReportId, merchant: 'Elsewhere' }),
    };
  });
  return { org, inOrg, reportId, ids };
}

describe('a report as its export lists it (FR-SET-01)', () => {
  it('lists every expense on a report, through its trips and as local expenses, in date order', async () => {
    const r = await closedReport('Export Riley');
    const found = await r.inOrg((tx) => reportForExport(tx, r.reportId));
    expect(found?.report).toEqual({
      id: r.reportId,
      memberId: r.org.memberId,
      owner: 'Export Riley',
      organization: 'Export Riley',
      title: 'Report from 4 Sept 2026',
      status: 'closed',
      openedAt: OPENED,
      closedAt: CLOSED,
    });
    expect(found?.expenses).toEqual([
      {
        date: '2026-09-01',
        merchant: 'Uber',
        category: null,
        type: null,
        trip: 'Chicago · partner review',
        purpose: 'Partner review',
        note: null,
        amountMinor: 3145,
        currency: 'USD',
      },
      expect.objectContaining({ date: '2026-09-02', merchant: 'Uber' }),
      {
        date: '2026-09-02',
        merchant: 'Zuni Café',
        category: null,
        type: null,
        trip: null,
        purpose: 'Lunch with the Acme architecture team',
        note: null,
        amountMinor: 1225,
        currency: 'USD',
      },
      {
        date: '2026-09-03',
        merchant: 'Hotel Lindley',
        category: 'Client travel',
        type: 'Hotel stay',
        trip: 'Chicago · partner review',
        purpose: 'Partner review',
        note: 'Two nights',
        amountMinor: 41_280,
        currency: 'EUR',
      },
    ]);
  });

  it('leaves out a possible duplicate, as the report’s totals do', async () => {
    const r = await closedReport('Export held');
    await r.inOrg(async (tx) => {
      const receipt = (expenseId: string, sha: string) => ({
        id: newId(),
        orgId: r.org.orgId,
        memberId: r.org.memberId,
        expenseId,
        source: 'camera' as const,
        storageKey: `k/${sha}`,
        contentType: 'image/jpeg',
        byteSize: 10,
        sha256: sha.repeat(64),
        status: 'needs_review' as const,
      });
      const earlier = receipt(r.ids.ride, 'a');
      const later = receipt(r.ids.copy, 'b');
      await tx.insert(receipts).values([earlier, later]);
      await tx.insert(receiptDuplicates).values({
        orgId: r.org.orgId,
        receiptId: later.id,
        otherReceiptId: earlier.id,
        settledStatus: 'extracted',
      });
    });
    const found = await r.inOrg((tx) => reportForExport(tx, r.reportId));
    expect(found?.expenses.map((e) => `${e.date} ${e.merchant}`)).toEqual([
      '2026-09-01 Uber',
      '2026-09-02 Zuni Café',
      '2026-09-03 Hotel Lindley',
    ]);
  });

  it('finds no report in another organization', async () => {
    const r = await closedReport('Export mine');
    const other = await seedOrg(app.db, 'Export theirs');
    expect(await withOrg(app.db, other.orgId, (tx) => reportForExport(tx, r.reportId))).toBe(
      undefined,
    );
    expect(await r.inOrg((tx) => reportForExport(tx, newId()))).toBe(undefined);
  });

  it('carries an expense’s journey and stay as kept, and nothing for one with neither', async () => {
    const r = await closedReport('Export travel');
    await r.inOrg(async (tx) => {
      await tx
        .update(expenses)
        .set({ checkIn: '2026-09-01', checkOut: '2026-09-03' })
        .where(eq(expenses.id, r.ids.hotel));
      await tx
        .update(expenses)
        .set({ journeyFrom: 'Hilton Omaha', journeyTo: null })
        .where(eq(expenses.id, r.ids.ride));
    });
    const found = await r.inOrg((tx) => reportForExport(tx, r.reportId));
    expect(found?.expenses.map((e) => [e.merchant, e.travel])).toEqual([
      [
        'Uber',
        {
          journeyFrom: 'Hilton Omaha',
          journeyTo: null,
          departsOn: null,
          checkIn: null,
          checkOut: null,
        },
      ],
      ['Uber', undefined],
      ['Zuni Café', undefined],
      [
        'Hotel Lindley',
        {
          journeyFrom: null,
          journeyTo: null,
          departsOn: null,
          checkIn: '2026-09-01',
          checkOut: '2026-09-03',
        },
      ],
    ]);
  });
});
