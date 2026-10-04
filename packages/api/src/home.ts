import {
  homeSnapshot,
  listExtractionRuns,
  listOpenDuplicatePairs,
  listReceiptReviews,
  listReceipts,
  type Database,
  type DuplicatePairRecord,
  type ExtractionRunRecord,
  type HomeSnapshot,
  type ReceiptRecord,
  type ReceiptReviewRecord,
} from '@expensewise/db';
import { asCaller } from './caller.ts';
import { reportsNeedingYou, type NeedsYouOptions, type ReportsNeedingYou } from './reports.ts';

/** What Home shows one member on one day, with the receipts that need them. */
export interface HomeData {
  readonly home: HomeSnapshot;
  readonly receipts: ReceiptRecord[];
  readonly runs: ExtractionRunRecord[];
  readonly reviews: ReceiptReviewRecord[];
  readonly pairs: DuplicatePairRecord[];
  /**
   * The member's open and closed reports, their unjustified local expenses and, while
   * categories are on, their expenses with no category and type.
   */
  readonly reports: ReportsNeedingYou;
}

/** What the API needs from the database for Home. Tests use an in-memory fake. */
export interface HomeStore {
  /** Read in one transaction, so the sections agree with each other. */
  snapshot(
    orgId: string,
    memberId: string,
    day: string,
    needsLimit: number,
    options?: NeedsYouOptions,
  ): Promise<HomeData>;
}

/**
 * The Home store on Postgres, as expensewise_app, for the request's caller: they see only
 * what their role allows (ADR-0035). It checks the role once.
 */
export function dbHomeStore(db: Database): HomeStore {
  const inOrg = asCaller(db);

  return {
    snapshot: (orgId, memberId, day, needsLimit, options) =>
      inOrg(orgId, async (tx) => {
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
          reports: await reportsNeedingYou(tx, memberId, needsLimit, options),
        };
      }),
  };
}
