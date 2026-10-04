import {
  rateDecimal,
  toDecimal,
  type MileageRate,
  type MileageReimbursement,
} from '@expensewise/domain';
import { expenseDetail } from './expense-views.ts';
import type { MileageEntry } from './mileage.ts';

/** A copied rate as shown: "0.7250" dollars a mile is "0.725". */
export function rateView(rate: MileageRate) {
  return {
    perUnit: rateDecimal(rate),
    currency: rate.currency,
    unit: rate.unit,
    effectiveFrom: rate.effectiveFrom,
    source: rate.source,
  };
}

/** A drive with the expense that claims it (FR-CAP-03): the expense's detail, and the drive. */
export function mileageEntry({ expense, mileage }: MileageEntry) {
  return {
    ...expenseDetail(expense, null),
    mileage: {
      date: mileage.date,
      destination: mileage.destination,
      purpose: mileage.purpose,
      miles: mileage.miles,
      unit: mileage.unit,
      method: mileage.method,
      rate: rateView(mileage.rate),
    },
  };
}

/** What a drive would pay. */
export function mileageQuote(date: string, claim: MileageReimbursement) {
  const { amount } = claim;
  return {
    date,
    miles: claim.distance,
    rate: rateView(claim.rate),
    amount: {
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      decimal: toDecimal(amount),
    },
  };
}
