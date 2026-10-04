import {
  assertRowSecurityApplies,
  homeSnapshot,
  listExtractionRuns,
  listOpenDuplicatePairs,
  listReceiptReviews,
  listReceipts,
  withOrg,
  type Database,
  type DuplicatePairRecord,
  type ExtractionRunRecord,
  type HomeSnapshot,
  type ReceiptRecord,
  type ReceiptReviewRecord,
} from '@expensewise/db';

/** What Home shows one member on one day, with the receipts that need them. */
export interface HomeData {
  readonly home: HomeSnapshot;
  readonly receipts: ReceiptRecord[];
  readonly runs: ExtractionRunRecord[];
  readonly reviews: ReceiptReviewRecord[];
  readonly pairs: DuplicatePairRecord[];
}

/** What the API needs from the database for Home. Tests use an in-memory fake. */
export interface HomeStore {
  /** Read in one transaction, so the sections agree with each other. */
  snapshot(orgId: string, memberId: string, day: string, needsLimit: number): Promise<HomeData>;
}

/** The Home store on Postgres, as expensewise_app. It checks the role once. */
export function dbHomeStore(db: Database): HomeStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));

  return {
    snapshot: async (orgId, memberId, day, needsLimit) => {
      await safe();
      return withOrg(db, orgId, async (tx) => {
        const receipts = await listReceipts(tx, needsLimit, {
          statuses: ['needs_review', 'failed'],
          memberId,
        });
        const ids = receipts.map((r) => r.id);
        return {
          home: await homeSnapshot(tx, memberId, day),
          receipts,
          runs: await listExtractionRuns(tx, ids),
          reviews: await listReceiptReviews(tx, ids),
          pairs: await listOpenDuplicatePairs(tx, ids),
        };
      });
    },
  };
}
