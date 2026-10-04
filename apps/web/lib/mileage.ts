import type { ExpenseAmount, ExpenseDetail } from './expenses';

/** The rate copied onto a drive when it was logged, or when its date or miles last changed. */
export interface MileageRate {
  /** Currency units a mile, as a plain decimal: "0.725". */
  perUnit: string;
  currency: string;
  unit: 'mi' | 'km';
  effectiveFrom: string;
  source: string;
}

/** A drive logged by hand (FR-CAP-03). */
export interface Mileage {
  date: string;
  destination: string;
  purpose: string;
  miles: string;
  unit: 'mi' | 'km';
  method: 'manual' | 'route' | 'gps';
  rate: MileageRate;
}

/** A drive, as the expense that claims it. */
export interface MileageEntry extends ExpenseDetail {
  mileage: Mileage;
}

/** What a drive would pay, before it is logged. */
export interface MileageQuote {
  date: string;
  miles: string;
  rate: MileageRate;
  amount: ExpenseAmount;
}

/** The feature flag mileage ships behind (ADR-0032). */
export const MILEAGE_FLAG = 'expenses.mileage';

/** The longest purpose kept: a drive's purpose is its expense's justification. */
export const PURPOSE_MAX = 500;

const SOURCES: Record<string, string> = { 'irs-business': 'the IRS business rate' };

/** "$0.725 a mile, the IRS business rate from 2026-01-01". */
export function describeRate(rate: MileageRate): string {
  const digits = rate.perUnit.split('.')[1]?.length ?? 0;
  let amount: string;
  try {
    // Intl takes the decimal string exactly; no float conversion.
    amount = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: rate.currency,
      maximumFractionDigits: Math.max(digits, 2),
    }).format(rate.perUnit as unknown as number);
  } catch {
    amount = `${rate.perUnit} ${rate.currency}`;
  }
  const per = rate.unit === 'mi' ? 'a mile' : 'a kilometre';
  const source = SOURCES[rate.source] ?? rate.source;
  return `${amount} ${per}, ${source} from ${rate.effectiveFrom}`;
}

/** "38.4 mi". */
export const distanceOf = (m: Pick<Mileage, 'miles' | 'unit'>) => `${m.miles} ${m.unit}`;
