import {
  assertCurrency,
  DomainError,
  fromDecimal,
  isCountryCode,
  isIsoDate,
  nightsOf,
  readTime,
  sum,
  type CurrencyCode,
  type ExpenseTravel,
  type Money,
  type StayNights,
} from '@expensewise/domain';
import { addsUp } from './checks.ts';
import {
  JOURNEY_DOCUMENTS,
  STAY_DOCUMENTS,
  type ConfidenceLevel,
  type DocumentType,
  type ReceiptExtraction,
} from './schema.ts';

export interface Field<T> {
  readonly value: T;
  readonly confidence: ConfidenceLevel;
}

/** An extraction in domain terms: money as integer minor units, dates as ISO dates. */
export interface NormalizedExtraction {
  readonly documentType: DocumentType;
  readonly merchant: Field<string> | null;
  readonly date: Field<string> | null;
  readonly currency: Field<CurrencyCode> | null;
  readonly total: Field<Money> | null;
  readonly subtotal: Field<Money> | null;
  readonly taxTotal: Field<Money> | null;
  /** How many tax lines were read, each rounded on its own (checks.ts allows for that). */
  readonly taxLines: number;
  /** Fees and surcharges that are neither tax nor tip, such as a booking fee. */
  readonly feeTotal: Field<Money> | null;
  readonly feeLines: number;
  readonly tip: Field<Money> | null;
  readonly cardLastFour: Field<string> | null;
  /** When it was bought, HH:MM local time. Never a reason for review (FR-INT-17). */
  readonly time: Field<string> | null;
  /** Where it was bought. Never a reason for review either. */
  readonly place: Field<Place> | null;
  /**
   * Where a ride, flight or train went (FR-INT-20). Absent from a reading not asked for it
   * (`receipts.journeys` off); null when asked and the document is no such ticket or prints
   * neither end.
   */
  readonly journey?: Journey | null;
  /**
   * A hotel folio's stay and its nights (FR-INT-21). Absent and null as for the journey. A stay
   * whose nights aren't sure fails the stay check, so it needs a look (checks.ts).
   */
  readonly stay?: Stay | null;
  /** Fields that could not be read as valid values; each becomes a Needs review reason. */
  readonly problems: readonly string[];
}

/** The merchant's address as printed, with what the time zone is worked out from. */
export interface Place {
  readonly address: string;
  readonly city: string | null;
  readonly region: string | null;
  /** ISO 3166-1 alpha-2, or null when none could be read. */
  readonly country: string | null;
}

/** Where a journey went, each end as printed. */
export interface Journey {
  readonly from: Field<string> | null;
  readonly to: Field<string> | null;
}

/** A stay's check-in and check-out days, and the nights worked out from both. */
export interface Stay {
  readonly checkIn: Field<string> | null;
  readonly checkOut: Field<string> | null;
  /** Null until both dates are read. */
  readonly nights: StayNights | null;
}

const text = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const RANK: Record<ConfidenceLevel, number> = { high: 2, medium: 1, low: 0 };
const lowest = (levels: readonly ConfidenceLevel[]): ConfidenceLevel =>
  levels.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), 'high' as ConfidenceLevel);

/**
 * Converts what the model returned into domain values without rounding anything away.
 * An amount with more decimals than its currency allows, an unknown currency or an
 * impossible date becomes a problem, never a silently "fixed" value.
 */
export function normalizeExtraction(
  extraction: ReceiptExtraction,
  options: { fallbackCurrency?: CurrencyCode } = {},
): NormalizedExtraction {
  const problems: string[] = [];

  let currency: Field<CurrencyCode> | null = null;
  if (extraction.currency) {
    try {
      currency = {
        value: assertCurrency(extraction.currency.code.trim().toUpperCase()),
        confidence: extraction.currency.confidence,
      };
    } catch {
      problems.push('currency');
    }
  }
  const code = currency?.value ?? options.fallbackCurrency;

  const amount = (
    name: string,
    field: { value: string; confidence: ConfidenceLevel } | null,
  ): Field<Money> | null => {
    if (!field) return null;
    if (!code) {
      problems.push(name);
      return null;
    }
    try {
      return { value: fromDecimal(field.value, code), confidence: field.confidence };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      problems.push(name);
      return null;
    }
  };

  // Read in field order, so problems are reported in the order a reviewer sees the fields.
  const total = amount('total', extraction.total);
  const subtotal = amount('subtotal', extraction.subtotal);
  const tip = amount('tip', extraction.tip);
  const lines = (name: string, read: readonly { value: string; confidence: ConfidenceLevel }[]) => {
    const each = read.map((line, i) => amount(`${name}[${i}]`, line));
    const readable = each.filter((t): t is Field<Money> => t !== null);
    return code && each.length > 0 && readable.length === each.length
      ? {
          value: sum(
            code,
            readable.map((t) => t.value),
          ),
          confidence: lowest(readable.map((t) => t.confidence)),
        }
      : null;
  };
  const taxTotal = lines('taxes', extraction.taxes);
  const feeTotal = lines('fees', extraction.fees);

  let date: Field<string> | null = null;
  if (extraction.date) {
    if (isIsoDate(extraction.date.value)) {
      date = { value: extraction.date.value, confidence: extraction.date.confidence };
    } else {
      problems.push('date');
    }
  }

  let cardLastFour: Field<string> | null = null;
  if (extraction.cardLastFour) {
    if (/^\d{4}$/.test(extraction.cardLastFour.value)) {
      cardLastFour = extraction.cardLastFour;
    } else {
      problems.push('cardLastFour');
    }
  }

  // Time and place may be blank, and one that doesn't read is blank too: neither is a reason
  // for review (FR-INT-17), so neither becomes a problem.
  const timeValue = extraction.time ? readTime(extraction.time.value) : null;
  const time =
    extraction.time && timeValue
      ? { value: timeValue, confidence: extraction.time.confidence }
      : null;
  const address = text(extraction.address?.printed);
  const country = text(extraction.address?.country)?.toUpperCase() ?? null;
  const place =
    extraction.address && address
      ? {
          value: {
            address,
            city: text(extraction.address.city),
            region: text(extraction.address.region),
            country: country && isCountryCode(country) ? country : null,
          },
          confidence: extraction.address.confidence,
        }
      : null;

  const merchantName = extraction.merchant?.name.trim();
  // Asked for only where journeys and stays are switched on; absent stays absent.
  const asked = extraction.journey !== undefined || extraction.stay !== undefined;
  return {
    documentType: extraction.documentType,
    merchant:
      extraction.merchant && merchantName
        ? { value: merchantName, confidence: extraction.merchant.confidence }
        : null,
    date,
    currency,
    total,
    subtotal,
    taxTotal,
    taxLines: extraction.taxes.length,
    feeTotal,
    feeLines: extraction.fees.length,
    tip,
    cardLastFour,
    time,
    place,
    ...(asked
      ? {
          journey: journeyOf(extraction.documentType, extraction.journey),
          stay: stayOf(extraction.documentType, extraction.stay),
        }
      : {}),
    problems,
  };
}

type Read = { readonly value: string; readonly confidence: ConfidenceLevel } | null | undefined;

const textField = (read: Read): Field<string> | null => {
  const value = text(read?.value);
  return read && value ? { value, confidence: read.confidence } : null;
};

/**
 * A journey is kept only from a ride receipt, an airline ticket or a rail ticket, each end
 * as printed; like time and place, an end that doesn't read is blank, never a problem.
 */
function journeyOf(type: DocumentType, read: ReceiptExtraction['journey']): Journey | null {
  if (!read || !JOURNEY_DOCUMENTS.includes(type)) return null;
  const from = textField(read.from);
  const to = textField(read.to);
  return from || to ? { from, to } : null;
}

/**
 * A stay is kept only from a hotel folio. A date that isn't one is blank; the nights are
 * worked out from both dates, never read, and are not sure when they can't be right.
 */
function stayOf(type: DocumentType, read: ReceiptExtraction['stay']): Stay | null {
  if (!read || !STAY_DOCUMENTS.includes(type)) return null;
  const day = (r: Read): Field<string> | null => {
    const field = textField(r);
    return field && isIsoDate(field.value) ? field : null;
  };
  const checkIn = day(read.checkIn);
  const checkOut = day(read.checkOut);
  if (!checkIn && !checkOut) return null;
  return {
    checkIn,
    checkOut,
    nights: checkIn && checkOut ? nightsOf(checkIn.value, checkOut.value) : null,
  };
}

/**
 * The journey and stay a reading would file its expense with (ADR-0022), or undefined for a
 * reading not asked for them, which leaves the expense's as they are.
 */
export function travelOf(reading: NormalizedExtraction | null): ExpenseTravel | undefined {
  if (!reading || (reading.journey === undefined && reading.stay === undefined)) {
    return undefined;
  }
  return {
    journeyFrom: reading.journey?.from?.value ?? null,
    journeyTo: reading.journey?.to?.value ?? null,
    checkIn: reading.stay?.checkIn?.value ?? null,
    checkOut: reading.stay?.checkOut?.value ?? null,
  };
}

/** Amounts a receipt may simply not print. */
export type OptionalAmount = 'taxTotal' | 'tip';

/**
 * Which of tax and tip count as zero because the receipt prints no such line (product
 * owner, 2 Oct). The reading itself keeps them absent, since that is what was read; this is
 * the rule for showing and filing it. Never assumed when the line is printed but couldn't be
 * read, nor when a printed subtotal and the lines that were read don't reach the total:
 * then a line was most likely missed, and a zero would hide it.
 */
export function assumedZeros(n: NormalizedExtraction): OptionalAmount[] {
  const total = n.total?.value;
  if (!total) return [];
  const unread = (name: string) => n.problems.some((p) => p === name || p.startsWith(`${name}[`));
  const absent: OptionalAmount[] = [];
  if (n.taxTotal === null && !unread('taxes')) absent.push('taxTotal');
  if (n.tip === null && !unread('tip')) absent.push('tip');
  if (absent.length === 0 || !n.subtotal) return absent;
  return addsUp(n) ? absent : [];
}
