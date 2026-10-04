import {
  assertCurrency,
  conversionCurrent,
  convert,
  fxRate,
  hasReferenceRate,
  money,
  referenceRate,
  referenceRateDue,
  REFERENCE_RATE_SOURCE,
  type ConversionRecord,
  type CurrencyCode,
  type EuroRate,
  type FxRate,
  type IsoDate,
} from '@expensewise/domain';
import { and, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { appendAuditEvent, lockOrgWrites, type AuditEntry } from './audit.ts';
import type { Database, Transaction } from './client.ts';
import { featureOn } from './features.ts';
import { enqueueOutbox } from './outbox.ts';
import type { CommittedEvent } from './receipts.ts';
import { expenseConversions, expenses, members, organizations, reports, trips } from './schema.ts';

/** The feature that converts reports to each person's reimbursement currency (FR-EXP-13). */
export const CONVERSION_FLAG = 'reports.currency-conversion';

/**
 * Asks the conversion workflow to convert what is waiting in an organization (ADR-0034). The
 * payload is empty: the workflow works out what is waiting when it runs.
 */
export const CONVERSIONS_DUE = 'report.conversions_due';

const CONVERTER: AuditEntry['actor'] = { type: 'system', id: 'amount-conversion' };

/** The reports conversions follow: those not yet submitted, which a person can still change. */
const UNSUBMITTED = ['open', 'closed'] as const;

/** A member's reimbursement currency (FR-EXP-13, Q23). */
export interface ReimbursementCurrency {
  /** What their reports are converted to: their choice, or the organization's home currency. */
  readonly currency: string;
  /** What they chose in Settings; null until they choose. */
  readonly chosen: string | null;
  readonly homeCurrency: string;
}

const memberCurrency = {
  chosen: members.reimbursementCurrency,
  homeCurrency: organizations.homeCurrency,
};

/** A member's reimbursement currency, or undefined for no such member. Call inside withOrg(). */
export async function getReimbursementCurrency(
  tx: Transaction,
  memberId: string,
): Promise<ReimbursementCurrency | undefined> {
  const [row] = await tx
    .select(memberCurrency)
    .from(members)
    .innerJoin(organizations, eq(organizations.id, members.orgId))
    .where(eq(members.id, memberId));
  return row && { currency: row.chosen ?? row.homeCurrency, ...row };
}

/**
 * Points each open or closed report at its member's reimbursement currency, where it differs:
 * after the member chooses another, or their organization's home currency changes for someone
 * who never chose. A submitted report keeps its own. Each move is audited. Returns the reports
 * moved. Call inside withOrg(), holding the organization's write lock.
 */
export async function followReimbursementCurrencies(
  tx: Transaction,
  orgId: string,
  actor: AuditEntry['actor'],
  memberId?: string,
): Promise<string[]> {
  const effective = sql<string>`coalesce(${members.reimbursementCurrency}, ${organizations.homeCurrency})`;
  const behind = await tx
    .select({ id: reports.id, from: reports.currency, to: effective })
    .from(reports)
    .innerJoin(members, and(eq(members.orgId, reports.orgId), eq(members.id, reports.memberId)))
    .innerJoin(organizations, eq(organizations.id, reports.orgId))
    .where(
      and(
        inArray(reports.status, [...UNSUBMITTED]),
        ne(reports.currency, effective),
        memberId ? eq(reports.memberId, memberId) : undefined,
      ),
    )
    .orderBy(reports.id)
    .for('update', { of: reports });
  const now = new Date();
  for (const report of behind) {
    await tx
      .update(reports)
      .set({ currency: report.to, updatedAt: now })
      .where(eq(reports.id, report.id));
    await appendAuditEvent(tx, orgId, {
      actor,
      entityType: 'report',
      entityId: report.id,
      action: 'report.currency_changed',
      payload: { from: report.from, to: report.to },
    });
  }
  return behind.map((r) => r.id);
}

/** An amount on an unsubmitted report, in another currency than the report's. */
interface ToConvert {
  readonly expenseId: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly purchaseDate: IsoDate;
  readonly into: string;
  readonly recorded: ConversionRecord | null;
}

/** A stored conversion's columns, for a select. */
export const recordColumns = {
  amountMinor: expenseConversions.amountMinor,
  currency: expenseConversions.currency,
  purchaseDate: expenseConversions.purchaseDate,
  into: expenseConversions.reimbursementCurrency,
  outcome: expenseConversions.outcome,
  convertedMinor: expenseConversions.convertedMinor,
  rate: expenseConversions.rate,
  rateDate: expenseConversions.rateDate,
  source: expenseConversions.source,
};

/** A stored conversion's columns, each null where none is stored. */
export interface RecordRow {
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly purchaseDate: string | null;
  readonly into: string | null;
  readonly outcome: 'converted' | 'unavailable' | null;
  readonly convertedMinor: number | null;
  readonly rate: string | null;
  readonly rateDate: string | null;
  readonly source: string | null;
}

/** A stored conversion as the domain sees it; null for none. */
export function conversionRecord(row: RecordRow): ConversionRecord | null {
  if (row.amountMinor === null || !row.currency || !row.purchaseDate || !row.into) return null;
  const base = {
    amount: money(row.amountMinor, row.currency),
    purchaseDate: row.purchaseDate,
    into: assertCurrency(row.into),
  };
  if (row.outcome === 'converted' && row.rate && row.rateDate && row.convertedMinor !== null) {
    return {
      ...base,
      outcome: 'converted',
      converted: money(row.convertedMinor, row.into),
      rate: fxRate({
        base: row.currency,
        quote: row.into,
        rate: row.rate,
        asOf: row.rateDate,
        source: row.source ?? REFERENCE_RATE_SOURCE,
      }),
    };
  }
  return { ...base, outcome: 'unavailable', source: row.source ?? REFERENCE_RATE_SOURCE };
}

/** An expense's trip, joined beside the report it may be on. */
export const tripOf = alias(trips, 'trip_of');

/** The report an expense is on: its own, as a local expense, or its trip's. */
export const onItsReport = () =>
  and(
    eq(reports.orgId, expenses.orgId),
    or(eq(expenses.reportId, reports.id), eq(tripOf.reportId, reports.id)),
  );

/**
 * Every amount on an unsubmitted report in another currency than the report's, its amount,
 * currency and date known, with what is recorded for it. Call inside withOrg().
 */
async function amountsToConvert(tx: Transaction): Promise<ToConvert[]> {
  const rows = await tx
    .select({
      expenseId: expenses.id,
      amount: expenses.amountMinor,
      expenseCurrency: expenses.currency,
      date: expenses.transactionDate,
      reportCurrency: reports.currency,
      ...recordColumns,
    })
    .from(expenses)
    .leftJoin(tripOf, and(eq(tripOf.orgId, expenses.orgId), eq(tripOf.id, expenses.tripId)))
    .innerJoin(reports, onItsReport())
    .leftJoin(
      expenseConversions,
      and(
        eq(expenseConversions.orgId, expenses.orgId),
        eq(expenseConversions.expenseId, expenses.id),
      ),
    )
    .where(
      and(
        inArray(reports.status, [...UNSUBMITTED]),
        isNotNull(expenses.amountMinor),
        isNotNull(expenses.currency),
        isNotNull(expenses.transactionDate),
        ne(expenses.currency, reports.currency),
      ),
    )
    .orderBy(expenses.transactionDate, expenses.id);
  return rows.map((r) => ({
    expenseId: r.expenseId,
    amountMinor: r.amount!,
    currency: r.expenseCurrency!,
    purchaseDate: r.date!,
    into: r.reportCurrency,
    recorded: conversionRecord(r),
  }));
}

/** The amounts whose conversion isn't recorded for exactly them yet, and whose rate is due. */
function waiting(amounts: readonly ToConvert[], now: Date): ToConvert[] {
  return amounts.filter(
    (a) =>
      referenceRateDue(a.purchaseDate, now) &&
      !(
        a.recorded &&
        conversionCurrent(
          a.recorded,
          money(a.amountMinor, a.currency),
          a.purchaseDate,
          assertCurrency(a.into),
        )
      ),
  );
}

/** Rates to ask the source for: on a purchase date, against the euro, for these currencies. */
export interface RateRequest {
  readonly date: IsoDate;
  readonly currencies: readonly CurrencyCode[];
}

/** Rates fetched for some requests: what the source published in their lookback. */
export interface FetchedRates {
  readonly asked: readonly RateRequest[];
  readonly rates: readonly EuroRate[];
}

export interface ConversionRun {
  /** Off for this organization: nothing was done. */
  readonly skipped: boolean;
  /** Reports pointed at their member's reimbursement currency. */
  readonly followed: number;
  readonly converted: number;
  /** Recorded as having no rate at the source. */
  readonly unavailable: number;
  /** What still needs rates from the source. */
  readonly needed: readonly RateRequest[];
}

const keyOf = (from: string, to: string, date: string) => `${from}>${to}@${date}`;
const euroLegs = (...currencies: CurrencyCode[]) =>
  [...new Set(currencies.filter((c) => c !== 'EUR'))].sort();

/** Records a conversion, or that there is no rate, replacing any before it, with its audit. */
async function record(
  tx: Transaction,
  orgId: string,
  item: ToConvert,
  rate: FxRate | 'unavailable',
): Promise<void> {
  const amount = money(item.amountMinor, item.currency);
  const into = assertCurrency(item.into);
  const converted = rate === 'unavailable' ? null : convert(amount, rate);
  const values = {
    amountMinor: amount.amountMinor,
    currency: amount.currency,
    purchaseDate: item.purchaseDate,
    reimbursementCurrency: into,
    outcome: converted ? ('converted' as const) : ('unavailable' as const),
    convertedMinor: converted?.amountMinor ?? null,
    rate: rate === 'unavailable' ? null : rate.rate,
    rateDate: rate === 'unavailable' ? null : rate.asOf,
    source: rate === 'unavailable' ? REFERENCE_RATE_SOURCE : rate.source,
    updatedAt: new Date(),
  };
  await tx
    .insert(expenseConversions)
    .values({ orgId, expenseId: item.expenseId, ...values })
    .onConflictDoUpdate({
      target: [expenseConversions.orgId, expenseConversions.expenseId],
      set: values,
    });
  await appendAuditEvent(tx, orgId, {
    actor: CONVERTER,
    entityType: 'expense',
    entityId: item.expenseId,
    action: converted ? 'expense.converted' : 'expense.not_converted',
    payload: {
      amountMinor: amount.amountMinor,
      currency: amount.currency,
      purchaseDate: item.purchaseDate,
      into,
      ...(converted && rate !== 'unavailable'
        ? { convertedMinor: converted.amountMinor, rate: rate.rate, rateDate: rate.asOf }
        : { reason: 'the source publishes no rate for it' }),
      source: values.source,
    },
  });
}

/**
 * Converts what waits on the organization's unsubmitted reports (FR-EXP-13, Q25), first
 * pointing each at its member's reimbursement currency. An amount takes the rate already
 * recorded for the same currency, purchase date and reimbursement currency, by any expense, so
 * one day's rate is fetched once and applied alike; else a rate from `fetched`. A currency the
 * source never publishes, or one it published nothing for in the lookback it was asked about,
 * is recorded as having no rate. What is left is returned as `needed`, for the workflow to
 * fetch. Does nothing while the feature is off. Call inside withOrg().
 */
export async function convertAmounts(
  tx: Transaction,
  orgId: string,
  now: Date,
  fetched?: FetchedRates,
): Promise<ConversionRun> {
  if (!(await featureOn(tx, orgId, CONVERSION_FLAG))) {
    return { skipped: true, followed: 0, converted: 0, unavailable: 0, needed: [] };
  }
  await lockOrgWrites(tx, orgId);
  const followed = await followReimbursementCurrencies(tx, orgId, CONVERTER);
  const all = await amountsToConvert(tx);
  const todo = waiting(all, now);
  // Rates already applied, by currency, reimbursement currency and purchase date.
  const known = new Map<string, FxRate | 'unavailable'>();
  for (const a of all) {
    const r = a.recorded;
    if (!r) continue;
    known.set(
      keyOf(r.amount.currency, r.into, r.purchaseDate),
      r.outcome === 'converted' ? r.rate : 'unavailable',
    );
  }
  const asked = (from: CurrencyCode, to: CurrencyCode, date: string) =>
    fetched?.asked.some(
      (q) => q.date === date && euroLegs(from, to).every((c) => q.currencies.includes(c)),
    ) ?? false;
  let converted = 0;
  let unavailable = 0;
  const needed = new Map<string, Set<CurrencyCode>>();
  for (const item of todo) {
    const from = assertCurrency(item.currency);
    const to = assertCurrency(item.into);
    const key = keyOf(from, to, item.purchaseDate);
    // A rate recorded for the same currency, date and reimbursement currency, this expense's
    // own among them when only its amount changed.
    let rate: FxRate | 'unavailable' | undefined = known.get(key);
    if (!rate && (!hasReferenceRate(from) || !hasReferenceRate(to))) rate = 'unavailable';
    rate ??= fetched && referenceRate(fetched.rates, from, to, item.purchaseDate);
    if (!rate && asked(from, to, item.purchaseDate)) rate = 'unavailable';
    if (!rate) {
      const legs = needed.get(item.purchaseDate) ?? new Set<CurrencyCode>();
      euroLegs(from, to).forEach((c) => legs.add(c));
      needed.set(item.purchaseDate, legs);
      continue;
    }
    await record(tx, orgId, item, rate);
    known.set(key, rate);
    if (rate === 'unavailable') unavailable++;
    else converted++;
  }
  return {
    skipped: false,
    followed: followed.length,
    converted,
    unavailable,
    needed: [...needed]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, legs]) => ({ date, currencies: [...legs].sort() })),
  };
}

/**
 * Asks the workflow to convert, when the feature is on and something waits: a report behind
 * its member's currency, or an amount on one not yet converted as it is. Called in the
 * transaction of a change that may leave something waiting, such as an edit or a trip joining
 * a report. Returns the event, for the caller to hand on at once, or null.
 */
export async function requestConversions(
  tx: Transaction,
  orgId: string,
  now = new Date(),
): Promise<CommittedEvent | null> {
  if (!(await featureOn(tx, orgId, CONVERSION_FLAG))) return null;
  const effective = sql<string>`coalesce(${members.reimbursementCurrency}, ${organizations.homeCurrency})`;
  const [behind] = await tx
    .select({ id: reports.id })
    .from(reports)
    .innerJoin(members, and(eq(members.orgId, reports.orgId), eq(members.id, reports.memberId)))
    .innerJoin(organizations, eq(organizations.id, reports.orgId))
    .where(and(inArray(reports.status, [...UNSUBMITTED]), ne(reports.currency, effective)))
    .limit(1);
  if (!behind && waiting(await amountsToConvert(tx), now).length === 0) return null;
  const payload = {};
  const outboxId = await enqueueOutbox(tx, orgId, CONVERSIONS_DUE, payload);
  return { outboxId, topic: CONVERSIONS_DUE, orgId, payload };
}

export type SetReimbursementCurrencyResult =
  | { readonly status: 'missing' }
  | { readonly status: 'unchanged'; readonly currency: ReimbursementCurrency }
  | {
      readonly status: 'set';
      readonly currency: ReimbursementCurrency;
      /** Open and closed reports now in the new currency. */
      readonly reports: readonly string[];
      /** The request to convert them, to hand on at once; null when nothing waits. */
      readonly event: CommittedEvent | null;
    };

/**
 * A member chooses the currency they are reimbursed in, or null to go back to the
 * organization's home currency (FR-EXP-13, Q23). Their open and closed reports follow it, and
 * the conversion workflow is asked to convert them. A submitted report keeps its currency.
 * Every change is audited. Call inside withOrg().
 */
export async function setReimbursementCurrency(
  tx: Transaction,
  orgId: string,
  memberId: string,
  choice: string | null,
  actorUserId: string,
): Promise<SetReimbursementCurrencyResult> {
  const chosen = choice === null ? null : assertCurrency(choice);
  await lockOrgWrites(tx, orgId);
  const [before] = await tx
    .select({ chosen: members.reimbursementCurrency })
    .from(members)
    .where(eq(members.id, memberId))
    .for('update');
  if (!before) return { status: 'missing' };
  if (before.chosen === chosen) {
    return { status: 'unchanged', currency: (await getReimbursementCurrency(tx, memberId))! };
  }
  await tx.update(members).set({ reimbursementCurrency: chosen }).where(eq(members.id, memberId));
  const currency = (await getReimbursementCurrency(tx, memberId))!;
  const actor = { type: 'user', id: actorUserId } as const;
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'member',
    entityId: memberId,
    action: 'member.reimbursement_currency_set',
    payload: { from: before.chosen, to: chosen, currency: currency.currency },
  });
  const moved = await followReimbursementCurrencies(tx, orgId, actor, memberId);
  return {
    status: 'set',
    currency,
    reports: moved,
    event: await requestConversions(tx, orgId),
  };
}

/**
 * The organizations with amounts to convert at `now`, asked outside any organization: the
 * database answers with ids and nothing else (conversion_work_due()). `everyOrg` when the
 * server's override has the feature on for all; otherwise only those whose owner switched it
 * on count.
 */
export async function conversionWorkDue(
  db: Database,
  now: Date,
  everyOrg: boolean,
): Promise<string[]> {
  const { rows } = await db.execute<{ org_id: string }>(
    sql`select conversion_work_due as org_id from conversion_work_due(${now.toISOString()}::timestamptz, ${everyOrg})`,
  );
  return rows.map((r) => r.org_id);
}
