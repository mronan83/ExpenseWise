import type { ExpenseRecord, ExtractionRunRecord, ReceiptRecord } from '@expensewise/db';
import { stayNights, TRAVEL_FIELDS, type ExpenseTravel } from '@expensewise/domain';
import { travelOf, type Field } from '@expensewise/extraction';
import { filedReading, latestRuns, normalized } from './receipt-views.ts';
import type { ReceiptWithReadings } from './receipts.ts';

/*
 * Journeys and stays (FR-INT-20, FR-INT-21, `receipts.journeys`): what the expense and receipt
 * pages add while the feature is on. With it off they are as they always were.
 */

/** An expense's journey and stay as kept; a record without them has none. */
const kept = (e: Partial<ExpenseTravel>): ExpenseTravel => ({
  journeyFrom: e.journeyFrom ?? null,
  journeyTo: e.journeyTo ?? null,
  checkIn: e.checkIn ?? null,
  checkOut: e.checkOut ?? null,
});

/** A journey and a stay as the API shows them, the nights worked out from the dates. */
export function travelView(travel: ExpenseTravel) {
  const nights = stayNights(travel);
  return {
    journey: { from: travel.journeyFrom, to: travel.journeyTo },
    stay: {
      checkIn: travel.checkIn,
      checkOut: travel.checkOut,
      nights: nights?.sure ? nights.nights : null,
      doubt: nights && !nights.sure ? nights.doubt : null,
    },
  };
}

/**
 * An expense's page with its journey and stay, and its receipt's beside them, with where they
 * differ. A difference shows; it never rejects the expense, as for time and place (ADR-0030).
 */
export function withTravel<D extends { readonly proof: object | null }>(
  detail: D,
  found: { readonly expense: ExpenseRecord; readonly proof: ReceiptWithReadings | null },
) {
  const travel = kept(found.expense);
  const { proof } = found;
  const read = proof ? travelOf(filedReading(proof.receipt, proof.runs, proof.reviews)) : undefined;
  return {
    ...detail,
    ...travelView(travel),
    proof: detail.proof
      ? {
          ...detail.proof,
          ...(read ? travelView(read) : { journey: null, stay: null }),
          travelDifferences: read
            ? TRAVEL_FIELDS.filter((f) => read[f] !== null && read[f] !== travel[f])
            : [],
        }
      : null,
  };
}

const textView = (field: Field<string> | null | undefined) =>
  field ? { value: field.value, confidence: field.confidence } : null;

/**
 * A receipt's readings with the journey and stay each model read, as read: the reading table
 * keeps every value as the model gave it. A reading not asked for them reads none.
 */
export function withJourneys<
  R extends { readonly model: string; readonly state: string; readonly fields: object | null },
>(receipt: ReceiptRecord, runs: readonly ExtractionRunRecord[], readings: readonly R[]) {
  const latest = latestRuns(receipt.id, runs);
  return readings.map((reading) => {
    if (!reading.fields || reading.state === 'pending') return reading;
    const n = normalized(latest.find((run) => run.model === reading.model));
    return {
      ...reading,
      fields: {
        ...reading.fields,
        from: textView(n?.journey?.from),
        to: textView(n?.journey?.to),
        checkIn: textView(n?.stay?.checkIn),
        checkOut: textView(n?.stay?.checkOut),
      },
    };
  });
}
