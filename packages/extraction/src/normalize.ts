import {
  assertCurrency,
  checkLines,
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
import { itemizationOfReading } from './lines.ts';
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
  /**
   * What the item lines come to, a discount or credit taking off: null when none were read, or
   * when any can't be read exactly. Never a problem on its own; the sums check uses it when no
   * subtotal is printed (checks.ts, #92).
   */
  readonly itemTotal: Money | null;
  /** How many item lines were read, each rounded on its own. */
  readonly itemLines: number;
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
  /**
   * A document of several purchases (FR-INT-23, `receipts.purchases`): how many, and whether
   * they add up, each one's lines making its own total and their totals the document's
   * (`checkLines`). Absent for a document of one, or not asked; the sums check then reads it.
   */
  readonly purchases?: { readonly count: number; readonly addUp: boolean };
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

/** Where a journey went, each end as printed, and the day its first leg departs. */
export interface Journey {
  readonly from: Field<string> | null;
  readonly to: Field<string> | null;
  /** YYYY-MM-DD; a date that isn't one is blank. */
  readonly departs: Field<string> | null;
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
  const itemTotal = itemsOf(extraction.lineItems, code);

  // With several purchases, the expense is dated and carded as the first, the purchase the
  // document is for (US-EXP-10 AC3), whatever the document's own date and card say.
  const purchases = extraction.purchases ?? [];
  const first = purchases.length > 1 ? purchases[0] : undefined;
  const readDate = first?.date ?? extraction.date;
  let date: Field<string> | null = null;
  if (readDate) {
    if (isIsoDate(readDate.value)) {
      date = { value: readDate.value, confidence: readDate.confidence };
    } else {
      problems.push('date');
    }
  }

  const readCard = first?.cardLastFour ?? extraction.cardLastFour;
  let cardLastFour: Field<string> | null = null;
  if (readCard) {
    if (/^\d{4}$/.test(readCard.value)) {
      cardLastFour = readCard;
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
    itemTotal,
    itemLines: extraction.lineItems.length,
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
    ...(first ? { purchases: purchasesOf(extraction) } : {}),
    problems,
  };
}

/**
 * Whether a document's purchases add up: each one's lines make its own total, and their totals
 * the document's (`checkLines`, R-LINES-TOLERANCE). Lines that can't all be read exactly don't,
 * so the reading is held for a look rather than filed with taxes in the wrong purchase.
 */
function purchasesOf(extraction: ReceiptExtraction) {
  const lines = itemizationOfReading(extraction);
  const check = lines ? checkLines(lines) : null;
  return {
    count: extraction.purchases?.length ?? 0,
    addUp: check !== null && (check.addsUp || check.problem === 'not_positive'),
  };
}

/**
 * What the item lines come to, as printed: a discount or credit is a negative line and takes
 * off. Null with none, or when any can't be read exactly. Item lines have no confidence of
 * their own and never decide filing, so one that doesn't read is no problem; its receipt then
 * shows no lines (lines.ts) and has none to check, as before.
 */
function itemsOf(
  items: ReceiptExtraction['lineItems'],
  code: CurrencyCode | undefined,
): Money | null {
  if (!code || items.length === 0) return null;
  try {
    return sum(
      code,
      items.map((item) => fromDecimal(item.amount.trim(), code)),
    );
  } catch (error) {
    if (error instanceof DomainError) return null;
    throw error;
  }
}

type Read = { readonly value: string; readonly confidence: ConfidenceLevel } | null | undefined;

const textField = (read: Read): Field<string> | null => {
  const value = text(read?.value);
  return read && value ? { value, confidence: read.confidence } : null;
};

/** A field read as a date, blank when it isn't one. */
const dayField = (read: Read): Field<string> | null => {
  const field = textField(read);
  return field && isIsoDate(field.value) ? field : null;
};

/**
 * A journey is kept only from a ride receipt, an airline ticket or a rail ticket, each end
 * as printed, with the day it departs; like time and place, a part that doesn't read is
 * blank, never a problem.
 */
function journeyOf(type: DocumentType, read: ReceiptExtraction['journey']): Journey | null {
  if (!read || !JOURNEY_DOCUMENTS.includes(type)) return null;
  const from = textField(read.from);
  const to = textField(read.to);
  // A reading made before journeys-v2 has no departs.
  const departs = dayField(read.departs);
  return from || to || departs ? { from, to, departs } : null;
}

/**
 * A stay is kept only from a hotel folio. A date that isn't one is blank; the nights are
 * worked out from both dates, never read, and are not sure when they can't be right.
 */
function stayOf(type: DocumentType, read: ReceiptExtraction['stay']): Stay | null {
  if (!read || !STAY_DOCUMENTS.includes(type)) return null;
  const checkIn = dayField(read.checkIn);
  const checkOut = dayField(read.checkOut);
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
    departsOn: reading.journey?.departs?.value ?? null,
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
