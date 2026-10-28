import { merchantLikeness } from './card-transactions.ts';
import { daysBetween, isIsoDate } from './dates.ts';
import { err, ok, type Result } from './result.ts';

/*
 * Refunds (FR-EXP-21, Q59, Q60, ADR-0054). A refund is money a merchant gave back: an expense
 * whose amount is below zero. It never counts on its own. Until a person pairs it with the
 * purchase it refunds, it is on no trip, no report and in no total, and waits in Needs you.
 * Paired, it goes where its purchase goes, so the two net down together; when the purchase was
 * claimed already, it goes on the person's open report instead, as money paid back.
 */

/**
 * How long after a purchase its refund may be dated and still be paired with it: 180 days
 * (R-REFUND-DAYS). Returns are taken for 30 to 90 days, and a card dispute is settled within
 * 120; half a year covers both with room to spare, and keeps the purchases offered few.
 */
export const REFUND_DAYS = 180;

/** An expense's values as far as a refund is concerned. */
export interface RefundValues {
  readonly transactionDate: string | null;
  readonly currency: string | null;
  readonly amountMinor: number | null;
}

/** Whether these values are a refund's: an amount below zero. */
export function isRefund(v: { readonly amountMinor: number | null }): boolean {
  return v.amountMinor !== null && v.amountMinor < 0;
}

/** A purchase a refund might be paired with. */
export interface RefundablePurchase extends RefundValues {
  readonly id: string;
  readonly merchant: string | null;
  /** What the refunds already paired with it come to, in its currency, as a negative or zero. */
  readonly refundedMinor: number;
  /** A drive is paid at miles × its rate, so nothing is refunded on it. */
  readonly mileage: boolean;
}

/** Why a purchase can't take a refund. */
export type RefundProblem =
  /** The refund has no amount, currency or date yet, or isn't below zero. */
  | 'not_a_refund'
  /** The purchase is a refund itself, a drive, or has no amount, currency or date yet. */
  | 'not_a_purchase'
  | 'currency'
  /** The refund is dated before the purchase, or more than REFUND_DAYS after it. */
  | 'date'
  /** It would give back more than is left of the purchase. */
  | 'amount';

export const REFUND_PROBLEMS: Record<RefundProblem, string> = {
  not_a_refund: 'Only an expense below zero is a refund. Enter its amount as, say, -25.00.',
  not_a_purchase: 'Pair a refund with a purchase: an expense of yours above zero, not a drive.',
  currency: 'A refund is paired with a purchase in its own currency.',
  date: `A refund is paired with a purchase on or before its date, within ${REFUND_DAYS} days.`,
  amount: 'That would give back more than is left of the purchase.',
};

/**
 * Whether a refund can be paired with a purchase (R-REFUND-DAYS): the same currency, the
 * purchase dated on or before the refund and no more than REFUND_DAYS before it, and what the
 * refunds paired with it give back, this one too, no more than it cost. A partial refund fits;
 * so do several that together give back all of it. The same person's is checked by the caller.
 */
export function refundFits(
  refund: RefundValues,
  purchase: RefundablePurchase,
): Result<void, RefundProblem> {
  if (
    !isRefund(refund) ||
    refund.currency === null ||
    refund.transactionDate === null ||
    !isIsoDate(refund.transactionDate)
  ) {
    return err('not_a_refund');
  }
  if (
    purchase.mileage ||
    purchase.amountMinor === null ||
    purchase.amountMinor <= 0 ||
    purchase.currency === null ||
    purchase.transactionDate === null ||
    !isIsoDate(purchase.transactionDate)
  ) {
    return err('not_a_purchase');
  }
  if (purchase.currency !== refund.currency) return err('currency');
  const days = daysBetween(purchase.transactionDate, refund.transactionDate);
  if (days < 0 || days > REFUND_DAYS) return err('date');
  const left = purchase.amountMinor + purchase.refundedMinor;
  if (-refund.amountMinor! > left) return err('amount');
  return ok(undefined);
}

/** A purchase offered for a refund: how alike its merchant is, and what is left of it. */
export interface RefundCandidate extends RefundablePurchase {
  /** From 0 to 1, as card charges are matched (`merchantLikeness`). */
  readonly likeness: number;
  /** Days from the purchase to the refund. */
  readonly days: number;
}

/**
 * The purchases a refund fits, most likely first: the closer merchant name, then the amount
 * the refund gives back all of what is left, then the nearer date. Ranked only: the person
 * chooses, as nothing about a refund is guessed.
 */
export function refundCandidates(
  refund: RefundValues & { readonly merchant: string | null },
  purchases: readonly RefundablePurchase[],
): RefundCandidate[] {
  return purchases
    .filter((p) => refundFits(refund, p).ok)
    .map((p) => ({
      ...p,
      likeness: refund.merchant && p.merchant ? merchantLikeness(refund.merchant, p.merchant) : 0,
      days: daysBetween(p.transactionDate!, refund.transactionDate!),
    }))
    .sort((a, b) => {
      const whole = (c: RefundCandidate) =>
        c.amountMinor! + c.refundedMinor + refund.amountMinor! === 0 ? 1 : 0;
      return b.likeness - a.likeness || whole(b) - whole(a) || a.days - b.days;
    });
}
