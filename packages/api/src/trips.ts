import {
  assertRowSecurityApplies,
  createTrip,
  deleteTrip,
  editTrip,
  getTrip,
  listTrips,
  listTripExpenses,
  tallyTrips,
  withOrg,
  type Database,
  type DeleteTripResult,
  type SaveTripResult,
  type TripFilter,
  type TripRecord,
  type TripTally,
} from '@expensewise/db';
import type { TripInput } from '@expensewise/domain';
import { withProofs, type ExpensesWithProof } from './expenses.ts';

/** What the API needs from the database for trips. Tests use an in-memory fake. */
export interface TripStore {
  list(
    orgId: string,
    limit: number,
    filter: TripFilter,
  ): Promise<{ trips: TripRecord[]; tallies: TripTally[] }>;
  /** One trip with its expenses, each with what its receipt shows. */
  get(
    orgId: string,
    tripId: string,
  ): Promise<{ trip: TripRecord; tallies: TripTally[]; expenses: ExpensesWithProof } | undefined>;
  /** Makes a trip for a member and files their expenses dated in it. */
  create(
    orgId: string,
    memberId: string,
    input: TripInput,
    actorUserId: string,
  ): Promise<SaveTripResult>;
  edit(
    orgId: string,
    tripId: string,
    input: TripInput,
    actorUserId: string,
  ): Promise<SaveTripResult>;
  remove(orgId: string, tripId: string, actorUserId: string): Promise<DeleteTripResult>;
}

/** The trip store on Postgres, as expensewise_app. It checks the role once. */
export function dbTripStore(db: Database): TripStore {
  let checked: Promise<void> | undefined;
  const safe = () =>
    (checked ??= assertRowSecurityApplies(db).catch((error: unknown) => {
      checked = undefined;
      throw error;
    }));
  const inOrg = async <T>(orgId: string, work: Parameters<typeof withOrg<T>>[2]) => {
    await safe();
    return withOrg(db, orgId, work);
  };

  return {
    list: (orgId, limit, filter) =>
      inOrg(orgId, async (tx) => {
        const trips = await listTrips(tx, limit, filter);
        return {
          trips,
          tallies: await tallyTrips(
            tx,
            trips.map((t) => t.id),
          ),
        };
      }),
    get: (orgId, tripId) =>
      inOrg(orgId, async (tx) => {
        const trip = await getTrip(tx, tripId);
        if (!trip) return undefined;
        return {
          trip,
          tallies: await tallyTrips(tx, [tripId]),
          expenses: await withProofs(tx, await listTripExpenses(tx, tripId)),
        };
      }),
    create: (orgId, memberId, input, actor) =>
      inOrg(orgId, (tx) => createTrip(tx, orgId, memberId, input, actor)),
    edit: (orgId, tripId, input, actor) =>
      inOrg(orgId, (tx) => editTrip(tx, orgId, tripId, input, actor)),
    remove: (orgId, tripId, actor) => inOrg(orgId, (tx) => deleteTrip(tx, orgId, tripId, actor)),
  };
}
