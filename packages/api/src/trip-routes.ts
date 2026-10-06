import type { Membership } from '@expensewise/db';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { paidByView, showCompanyPaid } from './company-paid.ts';
import { expenseSummaries } from './expense-views.ts';
import { featureGate, type FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';
import {
  createTripRoute,
  deleteTripRoute,
  editTripRoute,
  getTripRoute,
  listTripsRoute,
} from './routes/trips.ts';
import { tripSummary } from './trip-views.ts';
import type { TripStore } from './trips.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface TripRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly trips?: TripStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
}

const LIST_LIMIT = 200;

export function registerTripRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: TripRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  const features = options.features ?? featureGate(options);
  const paths = new Set(
    [listTripsRoute, createTripRoute, getTripRoute, editTripRoute, deleteTripRoute].map((r) =>
      r.getRoutingPath(),
    ),
  );
  for (const path of paths) app.use(path, auth);

  const stores = () => {
    if (!options.workspace || !options.trips) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, trips: options.trips };
  };
  const member = async (userId: string): Promise<Membership> => {
    const membership = await stores().workspace.findMembership(userId);
    if (!membership) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        {
          code: 'no_organization',
          detail: 'Call POST /v1/me/organization after signing in.',
        },
      );
    }
    return membership;
  };
  const notFound = () => new ProblemError(404, 'not-found', 'No such trip', { code: 'not_found' });
  const invalid = (problem: { field: string; message: string }) =>
    new ProblemError(422, 'invalid-value', 'A value is not valid', {
      code: 'invalid_value',
      detail: problem.message,
      field: problem.field,
    });
  /**
   * A trip with its expenses. While Paid by the company is on, its cost is split into what is
   * claimed and what the company paid, and each expense says who paid it (FR-EXP-17).
   */
  const shown = async (orgId: string, tripId: string) => {
    const found = await stores().trips.get(orgId, tripId);
    if (!found) throw notFound();
    const paid = await showCompanyPaid(features, orgId, found.payers !== undefined);
    const expenses = expenseSummaries(found.expenses);
    return {
      ...tripSummary(found.trip, found.tallies, paid ? found.payers : undefined),
      expenses: paid
        ? expenses.map((e, i) => {
            const record = found.expenses.expenses[i];
            return record ? { ...e, ...paidByView(record) } : e;
          })
        : expenses,
    };
  };

  app.openapi(listTripsRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    // A person's Trips are their own, whatever else their role lets them open (ADR-0035).
    const { trips, tallies, payers } = await stores().trips.list(who.orgId, LIST_LIMIT, {
      ...c.req.valid('query'),
      memberId: who.memberId,
    });
    const split = (await showCompanyPaid(features, who.orgId, payers !== undefined))
      ? payers
      : undefined;
    return c.json({ trips: trips.map((t) => tripSummary(t, tallies, split)) }, 200);
  });

  app.openapi(createTripRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const result = await stores().trips.create(
      who.orgId,
      who.memberId,
      c.req.valid('json'),
      caller.userId,
    );
    if (result.status === 'invalid') throw invalid(result.problem);
    if (result.status !== 'saved') throw new Error(`A new trip came back ${result.status}`);
    return c.json(await shown(who.orgId, result.tripId), 201);
  });

  app.openapi(getTripRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    return c.json(await shown(who.orgId, c.req.valid('param').tripId), 200);
  });

  app.openapi(editTripRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { tripId } = c.req.valid('param');
    const result = await stores().trips.edit(who.orgId, tripId, c.req.valid('json'), caller.userId);
    if (result.status === 'missing') throw notFound();
    if (result.status === 'invalid') throw invalid(result.problem);
    return c.json(await shown(who.orgId, tripId), 200);
  });

  app.openapi(deleteTripRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { tripId } = c.req.valid('param');
    const result = await stores().trips.remove(who.orgId, tripId, caller.userId);
    if (result.status === 'missing') throw notFound();
    if (result.status === 'has_submitted') {
      throw new ProblemError(409, 'trip-in-use', 'This trip can’t be deleted', {
        code: 'has_submitted',
        detail: `${result.count} of its expenses ${result.count === 1 ? 'is' : 'are'} submitted or later, and stay with their trip.`,
      });
    }
    return c.body(null, 204);
  });
}
