import {
  applyRouteDriveInput,
  claimRouteMiles,
  IRS_BUSINESS_RATES,
  isExpenseEditable,
  milesFromMetres,
  newId,
  plainMiles,
  quoteMileage,
  reimburse,
  routePoints,
  type ExpenseStatus,
  type IsoDate,
  type MileageProblem,
  type MileageRate,
  type MileageRateTable,
  type MileageReimbursement,
  type RouteDriveChange,
  type RouteDriveInput,
  type RouteDriveValues,
  type RouteProblem,
  type RouteProvider,
  type RouteStatus,
} from '@expensewise/domain';
import { and, asc, eq } from 'drizzle-orm';
import { appendAuditEvent, lockOrgWrites, type AuditEntry } from './audit.ts';
import type { Transaction } from './client.ts';
import { getMileage, type MileageRecord } from './mileage.ts';
import { enqueueOutbox } from './outbox.ts';
import type { CommittedEvent } from './receipts.ts';
import { reopenChangedReports, reportsOfExpenses } from './report-touch.ts';
import {
  expenses,
  mileageLogs,
  mileageRoutes,
  mileageRouteStops,
  organizations,
} from './schema.ts';
import { fileExpenseToTrip } from './trips.ts';

/*
 * Route-based mileage (FR-CAP-04, ADR-0039). A route drive is a drive like one logged by hand
 * (ADR-0038): an expense with source mileage and a mileage log of method `route`, whose
 * distance is the miles claimed and whose rate is the one in force on its date. Beside the log,
 * its route keeps the stops as typed and how they were measured. Measuring calls another
 * service, so it is asked for through the outbox and done by a workflow; until then the
 * expense is processing, and a drive that can't be measured needs a look.
 */

/** The flag route mileage ships behind (ADR-0032). */
export const ROUTE_MILEAGE_FLAG = 'expenses.route-mileage';

/** Asks the measuring workflow to measure a route drive's stops as they are now. */
export const ROUTE_MEASURE_REQUESTED = 'mileage.route_measure_requested';

/** The workflow, as the audit trail names it. */
const MEASURING: AuditEntry['actor'] = { type: 'system', id: 'route-measuring' };

/** One stop of a route drive: as typed, and where it was found once measured. */
export interface RouteStopRecord {
  readonly position: number;
  readonly address: string;
  readonly label: string | null;
  readonly longitude: string | null;
  readonly latitude: string | null;
  /** The leg to it from the stop before, in whole metres; null for the start. */
  readonly legMetres: number | null;
}

/** How a route drive was measured, or why it was not. */
export interface RouteRecord {
  readonly status: RouteStatus;
  readonly roundTrip: boolean;
  readonly requestId: string;
  readonly problem: string | null;
  readonly provider: RouteProvider | null;
  readonly profile: string | null;
  readonly measuredAt: Date | null;
  readonly distanceMetres: number | null;
  readonly returnMetres: number | null;
  readonly measuredMiles: string | null;
  readonly milesReason: string | null;
  readonly stops: readonly RouteStopRecord[];
}

/** A route drive: the drive, as one logged by hand is, and its route. */
export interface RouteDrive {
  readonly mileage: MileageRecord;
  readonly route: RouteRecord;
}

const routeColumns = {
  status: mileageRoutes.status,
  roundTrip: mileageRoutes.roundTrip,
  requestId: mileageRoutes.requestId,
  problem: mileageRoutes.problem,
  provider: mileageRoutes.provider,
  profile: mileageRoutes.profile,
  measuredAt: mileageRoutes.measuredAt,
  distanceMetres: mileageRoutes.distanceMetres,
  returnMetres: mileageRoutes.returnMetres,
  measuredMiles: mileageRoutes.measuredMiles,
  milesReason: mileageRoutes.milesReason,
};

/** The route of a drive, with its stops in order, or undefined. Call inside withOrg(). */
async function routeOf(
  tx: Transaction,
  expenseId: string,
  lock = false,
): Promise<RouteRecord | undefined> {
  const query = tx
    .select(routeColumns)
    .from(mileageRoutes)
    .where(eq(mileageRoutes.expenseId, expenseId));
  const [route] = lock ? await query.for('update') : await query;
  if (!route) return undefined;
  const stops = await tx
    .select({
      position: mileageRouteStops.position,
      address: mileageRouteStops.address,
      label: mileageRouteStops.label,
      longitude: mileageRouteStops.longitude,
      latitude: mileageRouteStops.latitude,
      legMetres: mileageRouteStops.legMetres,
    })
    .from(mileageRouteStops)
    .where(eq(mileageRouteStops.expenseId, expenseId))
    .orderBy(asc(mileageRouteStops.position));
  return {
    ...route,
    measuredMiles: route.measuredMiles === null ? null : plainMiles(route.measuredMiles),
    stops,
  };
}

/**
 * One of the member's route drives, or undefined: a drive logged by hand, or another
 * member's, is not one. Call inside withOrg().
 */
export async function getRouteDrive(
  tx: Transaction,
  memberId: string,
  expenseId: string,
): Promise<RouteDrive | undefined> {
  const mileage = await getMileage(tx, memberId, expenseId);
  if (mileage?.method !== 'route') return undefined;
  const route = await routeOf(tx, expenseId);
  return route && { mileage, route };
}

const rateColumns = (rate: MileageRate) => ({
  rateCurrency: rate.currency,
  ratePerUnit: rate.perUnit,
  rateEffectiveFrom: rate.effectiveFrom,
  rateSource: rate.source,
});

/** What the audit trail keeps of what a drive pays. */
const claimPayload = (claim: MileageReimbursement) => ({
  rate: {
    perUnit: claim.rate.perUnit,
    currency: claim.rate.currency,
    unit: claim.rate.unit,
    effectiveFrom: claim.rate.effectiveFrom,
    source: claim.rate.source,
  },
  amountMinor: claim.amount.amountMinor,
  currency: claim.amount.currency,
});

/** Asks for the drive's stops to be measured: its outbox event, in this transaction. */
async function requestMeasuring(
  tx: Transaction,
  orgId: string,
  expenseId: string,
): Promise<CommittedEvent> {
  const payload = { expenseId };
  const outboxId = await enqueueOutbox(tx, orgId, ROUTE_MEASURE_REQUESTED, payload);
  return { outboxId, topic: ROUTE_MEASURE_REQUESTED, orgId, payload };
}

const stopRows = (orgId: string, expenseId: string, stops: readonly string[]) =>
  stops.map((address, position) => ({ orgId, expenseId, position, address }));

/** The route as it is before it is measured: nothing measured, nothing claimed. */
const unmeasured = {
  status: 'measuring' as const,
  problem: null,
  provider: null,
  profile: null,
  measuredAt: null,
  distanceMetres: null,
  returnMetres: null,
  measuredMiles: null,
  milesReason: null,
};

export type LogRouteMileageResult =
  | { readonly status: 'logged'; readonly expenseId: string; readonly event: CommittedEvent }
  | { readonly status: 'invalid'; readonly problem: RouteProblem | MileageProblem };

/**
 * Logs a route drive for a member (FR-CAP-04): an expense on its date, processing until it is
 * measured, with the rate in force that day copied onto its mileage log, its stops as typed,
 * the request to measure them and its audit event, in one transaction. It files to the trip
 * its date falls in, as any expense does. Hand the event to the workflow runner after the
 * commit. Call inside withOrg(), as the member.
 */
export async function logRouteMileage(
  tx: Transaction,
  orgId: string,
  memberId: string,
  input: RouteDriveInput,
  actorUserId: string,
  today: IsoDate,
  rates: MileageRateTable = IRS_BUSINESS_RATES,
): Promise<LogRouteMileageResult> {
  const applied = applyRouteDriveInput(null, input, today, rates);
  if (!applied.ok) return { status: 'invalid', problem: applied.error };
  const { values, rate } = applied.value;
  if (!rate) throw new Error('A new route drive was not given its rate');
  const actor = { type: 'user', id: actorUserId } as const;
  // Before any expense is locked, so filing it to a trip sees every trip settled (ADR-0023).
  await lockOrgWrites(tx, orgId);
  const id = newId();
  const start = values.stops[0]!;
  const end = values.stops[values.stops.length - 1]!;
  await tx.insert(expenses).values({
    id,
    orgId,
    memberId,
    status: 'processing',
    source: 'mileage',
    merchant: end,
    transactionDate: values.date,
    justification: values.purpose,
  });
  await tx.insert(mileageLogs).values({
    orgId,
    expenseId: id,
    method: 'route',
    travelDate: values.date,
    origin: start,
    destination: end,
    purpose: values.purpose,
    // No miles until it is measured; the expense claims nothing until then.
    distance: '0',
    unit: 'mi',
    ...rateColumns(rate),
  });
  const event = await requestMeasuring(tx, orgId, id);
  await tx.insert(mileageRoutes).values({
    orgId,
    expenseId: id,
    roundTrip: values.roundTrip,
    status: 'measuring',
    requestId: event.outboxId,
  });
  await tx.insert(mileageRouteStops).values(stopRows(orgId, id, values.stops));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: id,
    action: 'expense.created',
    payload: {
      source: 'mileage',
      method: 'route',
      status: 'processing',
      date: values.date,
      stops: values.stops,
      roundTrip: values.roundTrip,
      rate: { perUnit: rate.perUnit, currency: rate.currency, effectiveFrom: rate.effectiveFrom },
    },
  });
  await fileExpenseToTrip(tx, orgId, id, actor);
  return { status: 'logged', expenseId: id, event };
}

/** A route drive of the member's, its rows locked for a change. */
async function lockedDrive(tx: Transaction, memberId: string, expenseId: string) {
  const [row] = await tx
    .select({
      status: expenses.status,
      amountMinor: expenses.amountMinor,
      method: mileageLogs.method,
      date: mileageLogs.travelDate,
      purpose: mileageLogs.purpose,
      miles: mileageLogs.distance,
    })
    .from(mileageLogs)
    .innerJoin(
      expenses,
      and(eq(expenses.orgId, mileageLogs.orgId), eq(expenses.id, mileageLogs.expenseId)),
    )
    .where(and(eq(mileageLogs.expenseId, expenseId), eq(expenses.memberId, memberId)))
    .for('update');
  if (!row) return undefined;
  const route = row.method === 'route' ? await routeOf(tx, expenseId, true) : undefined;
  return { ...row, miles: plainMiles(row.miles), route };
}

/** A route drive changes until it is submitted; while it is measured, too. */
const routeEditable = (status: ExpenseStatus) =>
  status === 'processing' || isExpenseEditable(status);

type Refused =
  /** No such drive of this member's. */
  | { readonly status: 'missing' }
  /** A drive logged by hand: it is changed as one. */
  | { readonly status: 'not_route' }
  /** Submitted or later: an approved drive is corrected by a reversal. */
  | { readonly status: 'not_editable'; readonly current: ExpenseStatus };

export type ChangeRouteDriveResult =
  | {
      readonly status: 'changed';
      readonly changes: readonly RouteDriveChange[];
      /** The stops changed, or a drive not measured was asked to be measured again. */
      readonly remeasured: boolean;
      /** The request to measure it, to hand on after the commit; null when not measured again. */
      readonly event: CommittedEvent | null;
    }
  | { readonly status: 'unchanged' }
  | { readonly status: 'invalid'; readonly problem: RouteProblem | MileageProblem }
  | Refused;

/**
 * A member changes one of their route drives before it is submitted, with its audit event.
 * New stops, or a round trip switched on or off, measure it again: it is processing until the
 * workflow has measured it, and claims nothing meanwhile. Sending its stops unchanged measures
 * a drive that couldn't be measured again, such as after its stop was corrected or a key was
 * added; a measured drive is never measured again for that (Q33). A new date prices the miles
 * claimed again at that day's rate and files it again by date. A closed report it is on
 * reopens. Call inside withOrg(), as the member.
 */
export async function changeRouteDrive(
  tx: Transaction,
  orgId: string,
  memberId: string,
  expenseId: string,
  input: RouteDriveInput,
  actorUserId: string,
  today: IsoDate,
  rates: MileageRateTable = IRS_BUSINESS_RATES,
): Promise<ChangeRouteDriveResult> {
  await lockOrgWrites(tx, orgId);
  const found = await lockedDrive(tx, memberId, expenseId);
  if (!found) return { status: 'missing' };
  const { route } = found;
  if (!route) return { status: 'not_route' };
  if (!routeEditable(found.status)) return { status: 'not_editable', current: found.status };
  const current: RouteDriveValues = {
    date: found.date,
    purpose: found.purpose,
    stops: route.stops.map((s) => s.address),
    roundTrip: route.roundTrip,
  };
  const applied = applyRouteDriveInput(current, input, today, rates);
  if (!applied.ok) return { status: 'invalid', problem: applied.error };
  const { values, changes, rate } = applied.value;
  const remeasured =
    applied.value.remeasure || (input.stops !== undefined && route.status !== 'measured');
  if (changes.length === 0 && !remeasured) return { status: 'unchanged' };

  const actor = { type: 'user', id: actorUserId } as const;
  const now = new Date();
  const end = values.stops[values.stops.length - 1]!;
  let event: CommittedEvent | null = null;
  let claim: MileageReimbursement | null = null;
  if (remeasured) {
    event = await requestMeasuring(tx, orgId, expenseId);
    await tx.delete(mileageRouteStops).where(eq(mileageRouteStops.expenseId, expenseId));
    await tx.insert(mileageRouteStops).values(stopRows(orgId, expenseId, values.stops));
    await tx
      .update(mileageRoutes)
      .set({
        ...unmeasured,
        roundTrip: values.roundTrip,
        requestId: event.outboxId,
        updatedAt: now,
      })
      .where(eq(mileageRoutes.expenseId, expenseId));
  } else if (rate && found.amountMinor !== null) {
    // A new date: the miles claimed, at the rate in force on it, copied on afresh.
    claim = reimburse(found.miles, 'mi', rate);
  }
  await tx
    .update(mileageLogs)
    .set({
      travelDate: values.date,
      origin: values.stops[0]!,
      destination: end,
      purpose: values.purpose,
      ...(remeasured ? { distance: '0' } : {}),
      ...(rate ? rateColumns(rate) : {}),
    })
    .where(eq(mileageLogs.expenseId, expenseId));
  await tx
    .update(expenses)
    .set({
      merchant: end,
      transactionDate: values.date,
      justification: values.purpose,
      ...(remeasured ? { status: 'processing' as const, amountMinor: null, currency: null } : {}),
      ...(claim ? { amountMinor: claim.amount.amountMinor, currency: claim.amount.currency } : {}),
      editedAt: now,
      updatedAt: now,
    })
    .where(eq(expenses.id, expenseId));
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.edited',
    payload: {
      source: 'mileage',
      method: 'route',
      changes,
      remeasured,
      ...(claim ? { ...claimPayload(claim), previousAmountMinor: found.amountMinor } : {}),
    },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    actor,
    'an expense on it was edited',
  );
  if (changes.some((c) => c.field === 'date')) {
    await fileExpenseToTrip(tx, orgId, expenseId, actor);
  }
  return { status: 'changed', changes, remeasured, event };
}

export type ClaimRouteMilesResult =
  | { readonly status: 'claimed'; readonly miles: string; readonly reason: string | null }
  | { readonly status: 'unchanged' }
  | { readonly status: 'invalid'; readonly problem: RouteProblem | MileageProblem }
  /** It is still being measured: there are no measured miles to change yet. */
  | { readonly status: 'measuring' }
  | Refused;

/**
 * The miles a member claims for one of their route drives (Q33): those measured, or others
 * with a reason, or, when it couldn't be measured, miles entered by hand with a reason. They
 * are priced at the rate in force on its date, copied on afresh, and the drive is Ready. The
 * audit trail keeps the miles before and after, the reason and the miles measured; the
 * measurement itself never changes. Call inside withOrg(), as the member.
 */
export async function claimMilesForRoute(
  tx: Transaction,
  orgId: string,
  memberId: string,
  expenseId: string,
  input: { readonly miles: string; readonly reason?: string | null },
  actorUserId: string,
  today: IsoDate,
  rates: MileageRateTable = IRS_BUSINESS_RATES,
): Promise<ClaimRouteMilesResult> {
  await lockOrgWrites(tx, orgId);
  const found = await lockedDrive(tx, memberId, expenseId);
  if (!found) return { status: 'missing' };
  const { route } = found;
  if (!route) return { status: 'not_route' };
  if (!routeEditable(found.status)) return { status: 'not_editable', current: found.status };
  if (route.status === 'measuring') return { status: 'measuring' };
  const claimed = claimRouteMiles(input, route.measuredMiles, found.date, today, rates);
  if (!claimed.ok) return { status: 'invalid', problem: claimed.error };
  const { miles, reason, claim } = claimed.value;
  const claimedBefore = found.amountMinor === null ? null : found.miles;
  if (claimedBefore === miles && route.milesReason === reason && found.status === 'ready') {
    return { status: 'unchanged' };
  }
  const now = new Date();
  await tx
    .update(mileageLogs)
    .set({ distance: miles, ...rateColumns(claim.rate) })
    .where(eq(mileageLogs.expenseId, expenseId));
  await tx
    .update(mileageRoutes)
    .set({ milesReason: reason, updatedAt: now })
    .where(eq(mileageRoutes.expenseId, expenseId));
  await tx
    .update(expenses)
    .set({
      status: 'ready',
      amountMinor: claim.amount.amountMinor,
      currency: claim.amount.currency,
      editedAt: now,
      updatedAt: now,
    })
    .where(eq(expenses.id, expenseId));
  const actor = { type: 'user', id: actorUserId } as const;
  await appendAuditEvent(tx, orgId, {
    actor,
    entityType: 'expense',
    entityId: expenseId,
    action: 'expense.edited',
    payload: {
      source: 'mileage',
      method: 'route',
      changes: [{ field: 'miles', from: claimedBefore, to: miles }],
      reason,
      measuredMiles: route.measuredMiles,
      ...claimPayload(claim),
      previousAmountMinor: found.amountMinor,
    },
  });
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    actor,
    'an expense on it was edited',
  );
  return { status: 'claimed', miles, reason };
}

/** What the measuring workflow needs: the stops as typed, in order, and where to look. */
export interface RouteToMeasure {
  readonly stops: readonly string[];
  readonly roundTrip: boolean;
  /** The organization's country, ISO 3166-1 alpha-2, to look addresses up in; null if unset. */
  readonly country: string | null;
}

/**
 * The stops of a route drive, when `requestId` is still the measuring it waits for; undefined
 * once its stops have changed again, it was measured, or it is gone. For the workflow, which
 * acts for the system. Call inside withOrg().
 */
export async function routeToMeasure(
  tx: Transaction,
  expenseId: string,
  requestId: string,
): Promise<RouteToMeasure | undefined> {
  const route = await routeOf(tx, expenseId);
  if (route?.requestId !== requestId || route.status !== 'measuring') return undefined;
  const [org] = await tx.select({ country: organizations.country }).from(organizations);
  return {
    stops: route.stops.map((s) => s.address),
    roundTrip: route.roundTrip,
    country: org?.country ?? null,
  };
}

/** Where a stop was found. */
export interface FoundPlace {
  readonly label: string;
  /** Degrees, to six places: about 10 cm. */
  readonly longitude: string;
  readonly latitude: string;
}

/** What came of measuring a route drive. */
export type RouteOutcome =
  | {
      readonly kind: 'measured';
      readonly provider: RouteProvider;
      readonly profile: string;
      /** Where each stop was found, in order. */
      readonly places: readonly FoundPlace[];
      /** Each leg in whole metres, in order: one fewer than the points routed through. */
      readonly legs: readonly number[];
      readonly measuredAt: Date;
    }
  | {
      readonly kind: 'failed';
      /** Why, in plain words, with what the person can do about it. */
      readonly problem: string;
    };

export type RecordMeasurementResult =
  | { readonly status: 'measured'; readonly miles: string }
  | { readonly status: 'failed'; readonly problem: string }
  /** The stops changed again, or it was settled already: nothing was recorded. */
  | { readonly status: 'stale' };

/**
 * Records what measuring a route drive came to, for the request it was made for (ADR-0039).
 * Measured, each stop keeps the place it was found at and the leg to it; the route keeps the
 * distance in whole metres, its miles in hundredths, the provider, the profile and when; the
 * drive claims those miles at the rate in force on its date, copied on, and is Ready. Not
 * measured, or measured to a distance one drive can't claim, it needs a look, with the reason.
 * Either way the audit trail records it. For the workflow, which acts for the system; call
 * inside withOrg().
 */
export async function recordRouteMeasurement(
  tx: Transaction,
  orgId: string,
  expenseId: string,
  requestId: string,
  outcome: RouteOutcome,
  now: Date = new Date(),
  rates: MileageRateTable = IRS_BUSINESS_RATES,
): Promise<RecordMeasurementResult> {
  await lockOrgWrites(tx, orgId);
  const route = await routeOf(tx, expenseId, true);
  if (route?.requestId !== requestId || route.status !== 'measuring') return { status: 'stale' };
  const [log] = await tx
    .select({ date: mileageLogs.travelDate })
    .from(mileageLogs)
    .where(eq(mileageLogs.expenseId, expenseId));
  if (!log) return { status: 'stale' };

  let problem = outcome.kind === 'failed' ? outcome.problem : null;
  let measured: { miles: string; claim: MileageReimbursement; metres: number } | null = null;
  if (outcome.kind === 'measured') {
    const points = routePoints(route.stops, route.roundTrip).length;
    if (outcome.places.length !== route.stops.length || outcome.legs.length !== points - 1) {
      throw new Error('The measurement does not match the drive’s stops');
    }
    const metres = outcome.legs.reduce((sum, leg) => sum + leg, 0);
    const miles = milesFromMetres(metres);
    const priced = quoteMileage({ date: log.date, miles }, now.toISOString().slice(0, 10), rates);
    if (priced.ok) measured = { miles, claim: priced.value, metres };
    else {
      problem =
        miles === '0'
          ? 'Every stop was found at the same place, so the route measures no distance. Check the stops and measure it again, or enter the miles by hand.'
          : `The route measures ${miles} miles. ${priced.error.message}`;
    }
    for (const [position, place] of outcome.places.entries()) {
      await tx
        .update(mileageRouteStops)
        .set({
          label: place.label,
          longitude: place.longitude,
          latitude: place.latitude,
          legMetres: position === 0 ? null : outcome.legs[position - 1]!,
        })
        .where(
          and(eq(mileageRouteStops.expenseId, expenseId), eq(mileageRouteStops.position, position)),
        );
    }
  }

  if (measured && outcome.kind === 'measured') {
    const { miles, claim, metres } = measured;
    await tx
      .update(mileageRoutes)
      .set({
        status: 'measured',
        problem: null,
        provider: outcome.provider,
        profile: outcome.profile,
        measuredAt: outcome.measuredAt,
        distanceMetres: metres,
        returnMetres: route.roundTrip ? outcome.legs[outcome.legs.length - 1]! : null,
        measuredMiles: miles,
        milesReason: null,
        updatedAt: now,
      })
      .where(eq(mileageRoutes.expenseId, expenseId));
    await tx
      .update(mileageLogs)
      .set({ distance: miles, ...rateColumns(claim.rate) })
      .where(eq(mileageLogs.expenseId, expenseId));
    await tx
      .update(expenses)
      .set({
        status: 'ready',
        amountMinor: claim.amount.amountMinor,
        currency: claim.amount.currency,
        updatedAt: now,
      })
      .where(eq(expenses.id, expenseId));
    await appendAuditEvent(tx, orgId, {
      actor: MEASURING,
      entityType: 'expense',
      entityId: expenseId,
      action: 'expense.route_measured',
      payload: {
        provider: outcome.provider,
        profile: outcome.profile,
        distanceMetres: metres,
        legsMetres: outcome.legs,
        miles,
        ...claimPayload(claim),
      },
    });
  } else {
    const reason = problem ?? 'It could not be measured.';
    await tx
      .update(mileageRoutes)
      .set({ status: 'failed', problem: reason, updatedAt: now })
      .where(eq(mileageRoutes.expenseId, expenseId));
    await tx
      .update(expenses)
      .set({ status: 'needs_review', updatedAt: now })
      .where(eq(expenses.id, expenseId));
    await appendAuditEvent(tx, orgId, {
      actor: MEASURING,
      entityType: 'expense',
      entityId: expenseId,
      action: 'expense.route_not_measured',
      payload: { problem: reason },
    });
  }
  await reopenChangedReports(
    tx,
    orgId,
    await reportsOfExpenses(tx, [expenseId]),
    MEASURING,
    'a drive on it was measured',
    now,
  );
  return measured
    ? { status: 'measured', miles: measured.miles }
    : { status: 'failed', problem: problem ?? '' };
}
