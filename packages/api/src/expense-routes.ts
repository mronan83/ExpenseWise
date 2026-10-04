import type { Membership } from '@expensewise/db';
import { amountMatches, type DetailField } from '@expensewise/domain';
import { timeZoneFor } from '@expensewise/extraction/place';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { expenseDetail, expenseSummaries } from './expense-views.ts';
import type { ExpenseStore } from './expenses.ts';
import { ProblemError } from './problem.ts';
import {
  editExpenseRoute,
  getExpenseRoute,
  listExpensesRoute,
  setExpenseTripRoute,
} from './routes/expenses.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface ExpenseRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly expenses?: ExpenseStore;
}

const LIST_LIMIT = 100;

export function registerExpenseRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ExpenseRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [listExpensesRoute, getExpenseRoute, editExpenseRoute, setExpenseTripRoute].map((r) =>
      r.getRoutingPath(),
    ),
  );
  for (const path of paths) app.use(path, auth);

  const stores = () => {
    if (!options.workspace || !options.expenses) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        {
          code: 'database_not_configured',
        },
      );
    }
    return { workspace: options.workspace, expenses: options.expenses };
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
  const notFound = () =>
    new ProblemError(404, 'not-found', 'No such expense', { code: 'not_found' });

  app.openapi(listExpensesRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { amount, onTrip, ...search } = c.req.valid('query');
    // The schema admits only plain decimals, which always read in some currency.
    const amounts = amount === undefined ? undefined : (amountMatches(amount) ?? []);
    const found = await stores().expenses.list(who.orgId, LIST_LIMIT, {
      ...search,
      amounts,
      onTrip: onTrip === undefined ? undefined : onTrip === 'yes',
    });
    return c.json({ expenses: expenseSummaries(found) }, 200);
  });

  app.openapi(getExpenseRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { expenseId } = c.req.valid('param');
    const found = await stores().expenses.get(who.orgId, expenseId);
    if (!found) throw notFound();
    return c.json(expenseDetail(found.expense, found.proof), 200);
  });

  app.openapi(editExpenseRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { expenseId } = c.req.valid('param');
    const { expenses } = stores();
    const { time, timeZone, address, city, region, country, ...values } = c.req.valid('json');
    const given = { time, timeZone, address, city, region, country };
    const details: Partial<Record<DetailField, string>> = Object.fromEntries(
      Object.entries(given).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    // A new place means a new time zone, worked out again unless the person set one; a blank
    // time zone asks for it to be worked out from the place.
    const fromPlace =
      timeZone === undefined ? (city ?? region ?? country) !== undefined : timeZone.trim() === '';
    if (fromPlace) {
      const found = await expenses.get(who.orgId, expenseId);
      if (!found) throw notFound();
      const place = (now: string | undefined, was: string | null) =>
        now === undefined ? was : now.trim() || null;
      const zone = timeZoneFor({
        city: place(city, found.expense.city),
        region: place(region, found.expense.region),
        country: place(country, found.expense.country)?.toUpperCase() ?? null,
      });
      details.timeZone = zone ?? '';
    }
    const result = await expenses.edit(
      who.orgId,
      expenseId,
      {
        ...values,
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
      caller.userId,
    );
    if (result.status === 'missing') throw notFound();
    if (result.status === 'not_editable') {
      const reading = result.current === 'processing';
      throw new ProblemError(409, 'not-editable', 'This expense can’t be edited now', {
        code: reading ? 'being_read' : 'locked',
        detail: reading
          ? 'Its receipt is being read. Try again in a few seconds.'
          : 'It is submitted or approved. An approved expense is corrected by a reversal.',
      });
    }
    if (result.status === 'mileage') {
      throw new ProblemError(409, 'not-editable', 'This expense can’t be edited here', {
        code: 'mileage',
        detail: `It is a drive, paid at miles × its rate: change it with PATCH /v1/mileage/${expenseId}.`,
      });
    }
    if (result.status === 'invalid') {
      throw new ProblemError(422, 'invalid-value', 'A value is not valid', {
        code: 'invalid_value',
        detail: result.problem.message,
        field: result.problem.field,
      });
    }
    const found = await expenses.get(who.orgId, expenseId);
    if (!found) throw notFound();
    return c.json(expenseDetail(found.expense, found.proof), 200);
  });

  app.openapi(setExpenseTripRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { expenseId } = c.req.valid('param');
    const { expenses } = stores();
    const result = await expenses.setTrip(who.orgId, expenseId, c.req.valid('json'), caller.userId);
    if (result.status === 'missing') throw notFound();
    if (result.status === 'not_movable') {
      throw new ProblemError(409, 'not-movable', 'This expense can’t move to another trip now', {
        code: 'locked',
        detail: 'It is submitted or later, so it stays with its report.',
      });
    }
    if (result.status === 'no_such_trip' || result.status === 'other_member') {
      const missing = result.status === 'no_such_trip';
      throw new ProblemError(422, 'invalid-trip', 'That trip can’t take this expense', {
        code: missing ? 'no_such_trip' : 'other_members_trip',
        detail: missing
          ? 'There is no such trip in this organization.'
          : 'The trip is another member’s. An expense goes on its owner’s trips.',
        field: 'tripId',
      });
    }
    const found = await expenses.get(who.orgId, expenseId);
    if (!found) throw notFound();
    return c.json(expenseDetail(found.expense, found.proof), 200);
  });
}
