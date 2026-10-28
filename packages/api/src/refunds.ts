import {
  listRefundCandidates,
  pairRefund,
  unpairRefund,
  type Database,
  type PairRefundResult,
  type RefundLinks,
  type RefundOption,
  type UnpairRefundResult,
  refundLinksOf,
} from '@expensewise/db';
import { asCaller } from './caller.ts';

/** Refunds and the purchases they are paired with (FR-EXP-21). Tests use an in-memory fake. */
export interface RefundStore {
  /** What a refund is paired with, and the refunds paired with a purchase. */
  links(orgId: string, expenseId: string): Promise<RefundLinks>;
  /** The purchases a refund can be paired with; undefined for no such expense. */
  candidates(orgId: string, expenseId: string): Promise<RefundOption[] | undefined>;
  pair(
    orgId: string,
    refundId: string,
    purchaseId: string,
    actorUserId: string,
  ): Promise<PairRefundResult>;
  unpair(orgId: string, refundId: string, actorUserId: string): Promise<UnpairRefundResult>;
}

/** The refund store on Postgres, as expensewise_app, for the request's caller (ADR-0035). */
export function dbRefundStore(db: Database): RefundStore {
  const inOrg = asCaller(db);
  return {
    links: (orgId, expenseId) => inOrg(orgId, (tx) => refundLinksOf(tx, expenseId)),
    candidates: (orgId, expenseId) => inOrg(orgId, (tx) => listRefundCandidates(tx, expenseId)),
    pair: (orgId, refundId, purchaseId, actor) =>
      inOrg(orgId, (tx) => pairRefund(tx, orgId, refundId, purchaseId, actor)),
    unpair: (orgId, refundId, actor) =>
      inOrg(orgId, (tx) => unpairRefund(tx, orgId, refundId, actor)),
  };
}
