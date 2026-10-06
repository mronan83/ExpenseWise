import type { ReceiptCheck } from './approval';
import type { ExpenseCategory } from './categories';
import type { PaidBy } from './company-paid';
import type { ExpenseSplit, Itemized } from './itemized';
import type { ReceiptSummary } from './receipts';

export type ExpenseStatus =
  'processing' | 'needs_review' | 'ready' | 'submitted' | 'approved' | 'settled';

export interface ExpenseAmount {
  amountMinor: number;
  currency: string;
  decimal: string;
}

export type ExpenseField = 'merchant' | 'date' | 'currency' | 'amount';

export interface ExpenseSummary {
  id: string;
  status: ExpenseStatus;
  source: string;
  owner: string;
  merchant: string | null;
  date: string | null;
  amount: ExpenseAmount | null;
  /** Its receipt, the proof (FR-EXP-08). */
  receiptId: string | null;
  /** The trip it is filed to (FR-EXP-04), or null. */
  trip: { id: string; name: string } | null;
  /** person: someone chose its trip, or no trip, and filing by date leaves it there. */
  tripFiledBy: 'date' | 'person';
  /** Null without a receipt. */
  matchesReceipt: boolean | null;
  /** On no trip, with a date: it needs a justification before its report can close. */
  local: boolean;
  /** Why a local expense was for business. */
  justification: string | null;
  /** The report it is on: its trip’s, or its own when local. */
  reportId: string | null;
  /** Its category and type, while that feature is on (FR-EXP-11). */
  category?: ExpenseCategory;
  /** Who paid it, while Paid by the company is on (FR-EXP-17). */
  paidBy?: PaidBy;
  /** A person set who paid it, so the policy for its type leaves it alone (Q46). */
  paidByPinned?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ExpenseDetail extends ExpenseSummary {
  editable: boolean;
  editedAt: string | null;
  proof: {
    receiptId: string;
    status: ReceiptSummary['status'];
    confirmedBy: string | null;
    merchant: string | null;
    date: string | null;
    amount: ExpenseAmount | null;
    differences: ExpenseField[];
    time: string | null;
    address: string | null;
    city: string | null;
    country: string | null;
    /** Shown, never a reason to reject. */
    detailDifferences: ('time' | 'address' | 'city' | 'country')[];
    /** As its receipt reads them; only while Journeys and stays is on. */
    journey?: Journey | null;
    stay?: Stay | null;
    travelDifferences?: TravelField[];
  } | null;
  /** When it was bought, HH:MM local time (FR-INT-17). */
  time: string | null;
  /** The IANA time zone of that time, worked out from the place. */
  timeZone: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string | null;
  /** Where a ride, flight or train went; only while Journeys and stays is on (FR-INT-20). */
  journey?: Journey;
  /** A hotel stay and its nights, worked out; only while the feature is on (FR-INT-21). */
  stay?: Stay;
  /** Its receipt's lines, while that feature is on (FR-INT-22). */
  itemized?: Itemized | null;
  /** Its parts, while splits are on (FR-EXP-15). */
  split?: ExpenseSplit | null;
  /** How it holds up against its receipt, and why it claims less; while approval is on. */
  claim?: { reason: string | null; check: ReceiptCheck };
}

export interface Journey {
  from: string | null;
  to: string | null;
  /** The day a ticket's first leg departs; it files to its trip by this day (FR-EXP-19). */
  departsOn?: string | null;
}

export interface Stay {
  checkIn: string | null;
  checkOut: string | null;
  /** Worked out from the dates; null until both are known, or when they aren't sure. */
  nights: number | null;
  doubt: 'check_out_before_check_in' | 'too_long' | null;
}

/** The journey and stay a person can correct (FR-INT-20, FR-INT-21). */
export type TravelField = 'journeyFrom' | 'journeyTo' | 'departsOn' | 'checkIn' | 'checkOut';

export const TRAVEL_LABELS: Record<TravelField, string> = {
  journeyFrom: 'From',
  journeyTo: 'To',
  departsOn: 'Departs',
  checkIn: 'Check-in',
  checkOut: 'Check-out',
};

/** A journey and a stay as the domain's lines read them. */
export const travelOf = (journey?: Journey | null, stay?: Stay | null) => ({
  journeyFrom: journey?.from ?? null,
  journeyTo: journey?.to ?? null,
  departsOn: journey?.departsOn ?? null,
  checkIn: stay?.checkIn ?? null,
  checkOut: stay?.checkOut ?? null,
});

/** The parts of when and where a person can edit. A blank time zone follows the place. */
export type DetailField = 'time' | 'timeZone' | 'address' | 'city' | 'region' | 'country';

export const DETAIL_LABELS: Record<DetailField, string> = {
  time: 'Time',
  timeZone: 'Time zone',
  address: 'Address',
  city: 'City',
  region: 'State or region',
  country: 'Country',
};

/** Where it was bought, in a line: the printed address, or else the city, region and country. */
export function placeOf(p: {
  address: string | null;
  city: string | null;
  region?: string | null;
  country: string | null;
}): string | null {
  if (p.address) return p.address;
  const parts = [p.city, p.region, p.country].filter((x): x is string => Boolean(x));
  return parts.length > 0 ? parts.join(', ') : null;
}

/** Every time zone the browser knows, with the given one kept in even if it doesn't. */
export function timeZones(keep: string | null): string[] {
  const known =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return keep && !known.includes(keep) ? [keep, ...known] : known;
}

/** A time with its zone named by its city: "18:42, Chicago time". */
export function timeOf(time: string | null, timeZone: string | null): string | null {
  if (!time) return null;
  const city = timeZone?.split('/').at(-1)?.replaceAll('_', ' ');
  return city ? `${time}, ${city} time` : time;
}

export const EXPENSE_STATUS: Record<ExpenseStatus, { label: string; tone: string }> = {
  processing: { label: 'Reading…', tone: 'text-ink-2' },
  needs_review: { label: 'Needs a look', tone: 'text-warn' },
  ready: { label: 'Ready', tone: 'text-ok' },
  submitted: { label: 'Submitted', tone: 'text-ink-2' },
  approved: { label: 'Approved', tone: 'text-ok' },
  settled: { label: 'Paid', tone: 'text-ok' },
};

/** How a list shows an expense's state: a drive is measured, not read (ADR-0039). */
export function statusOf(e: Pick<ExpenseSummary, 'status' | 'source'>) {
  return e.source === 'mileage' && e.status === 'processing'
    ? { label: 'Measuring…', tone: EXPENSE_STATUS.processing.tone }
    : EXPENSE_STATUS[e.status];
}

export const EXPENSE_FIELD_LABELS: Record<ExpenseField, string> = {
  merchant: 'Merchant',
  date: 'Date',
  currency: 'Currency',
  amount: 'Amount',
};
