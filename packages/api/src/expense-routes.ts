import type { Membership } from '@expensewise/db';
import {
  amountMatches,
  applyExpenseEdit,
  type DetailField,
  type TravelEdit,
} from '@expensewise/domain';
import { timeZoneFor } from '@expensewise/extraction/place';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import type { CategoryStore } from './categories.ts';
import { categorize, detailWithCategory } from './category-views.ts';
import { receiptCheckOf } from './approval.ts';
import { checkView } from './approval-views.ts';
import { expenseSummaries, proofOf } from './expense-views.ts';
import type { ExpenseStore } from './expenses.ts';
import { featureGate, type FeatureGate } from './features.ts';
import type { ItemizedStore } from './itemized.ts';
import { itemizedSections } from './itemized-routes.ts';
import { ProblemError } from './problem.ts';
import { withTravel } from './travel-views.ts';
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
  /** Categories and types; while they are switched on, each expense shows its own. */
  readonly categories?: CategoryStore;
  /** Lines and splits; while they are switched on, each expense shows its own. */
  readonly itemized?: ItemizedStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
}

const LIST_LIMIT = 100;

export function registerExpenseRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ExpenseRouteOptions,
) {
  const features = options.features ?? featureGate({ workspace: options.workspace });
  /** The category store while categories are on for the organization (FR-EXP-11). */
  const categoriesOn = async (orgId: string) =>
    options.categories && (await features.isOn(orgId, 'expenses.categories'))
      ? options.categories
      : undefined;
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
    // A person's Expenses are their own, whatever else their role lets them open (ADR-0035).
    const found = await stores().expenses.list(who.orgId, LIST_LIMIT, {
      ...search,
      amounts,
      onTrip: onTrip === undefined ? undefined : onTrip === 'yes',
      memberId: who.memberId,
    });
    const summaries = expenseSummaries(found);
    const categories = await categoriesOn(who.orgId);
    if (!categories) return c.json({ expenses: summaries }, 200);
    const shown = await categorize(
      categories,
      who.orgId,
      found.expenses.map((expense) => {
        const receipt = found.receipts.find((r) => r.id === expense.receiptId);
        return { expense, proof: receipt ? { ...found, receipt } : null };
      }),
    );
    return c.json({ expenses: summaries.map((s) => ({ ...s, category: shown.get(s.id) })) }, 200);
  });

  const sections = itemizedSections(options.itemized, features);
  /**
   * One expense as its page shows it: its category and type, lines and split included while
   * each is on, and its journey and stay while Journeys and stays is (FR-INT-20, FR-INT-21).
   */
  const detail = async (
    orgId: string,
    found: NonNullable<Awaited<ReturnType<ExpenseStore['get']>>>,
  ) => {
    const shown = {
      ...(await detailWithCategory(await categoriesOn(orgId), orgId, found)),
      ...(await sections(orgId, found)),
      // How it holds up against its receipt, while approval is on (FR-EXP-10, FR-GOV-13).
      ...((await features.isOn(orgId, 'reports.approval'))
        ? {
            claim: {
              reason: found.expense.claimReason ?? null,
              check: checkView(receiptCheckOf(found.expense, found.proof)),
            },
          }
        : {}),
    };
    return (await features.isOn(orgId, 'receipts.journeys')) ? withTravel(shown, found) : shown;
  };

  /**
   * While approval is on, an expense never claims more than its receipt (FR-EXP-10, Q6): an
   * edit to an amount above the receipt's total, in its currency, is refused.
   */
  const refuseOverReceipt = async (
    orgId: string,
    expenseId: string,
    values: { merchant?: string; date?: string; currency?: string; amount?: string },
  ) => {
    if (values.amount === undefined && values.currency === undefined) return;
    if (!(await features.isOn(orgId, 'reports.approval'))) return;
    const found = await stores().expenses.get(orgId, expenseId);
    if (!found?.proof) return;
    const receipt = proofOf(found.proof).values;
    const applied = applyExpenseEdit(found.expense, values);
    if (!applied.ok || receipt.amountMinor === null) return;
    const { amountMinor, currency } = applied.value.values;
    if (
      currency === receipt.currency &&
      amountMinor !== null &&
      amountMinor > receipt.amountMinor
    ) {
      throw new ProblemError(422, 'over-receipt', 'An expense never claims more than its receipt', {
        code: 'over_receipt',
        detail:
          'Claim its receipt’s total or less. Claiming less, say why on the expense (FR-EXP-10).',
        field: 'amount',
      });
    }
  };

  app.openapi(getExpenseRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const { expenseId } = c.req.valid('param');
    const found = await stores().expenses.get(who.orgId, expenseId);
    if (!found) throw notFound();
    return c.json(await detail(who.orgId, found), 200);
  });

  app.openapi(editExpenseRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { expenseId } = c.req.valid('param');
    const { expenses } = stores();
    const {
      time,
      timeZone,
      address,
      city,
      region,
      country,
      journeyFrom,
      journeyTo,
      departsOn,
      checkIn,
      checkOut,
      ...values
    } = c.req.valid('json');
    const sent = (given: Record<string, string | undefined>) =>
      Object.fromEntries(
        Object.entries(given).filter((entry): entry is [string, string] => entry[1] !== undefined),
      );
    const given = { time, timeZone, address, city, region, country };
    const details: Partial<Record<DetailField, string>> = sent(given);
    // A journey or a stay is corrected only while Journeys and stays is on.
    const travel: TravelEdit = sent({ journeyFrom, journeyTo, departsOn, checkIn, checkOut });
    if (Object.keys(travel).length > 0) await features.require(who.orgId, 'receipts.journeys');
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
    await refuseOverReceipt(who.orgId, expenseId, values);
    const result = await expenses.edit(
      who.orgId,
      expenseId,
      {
        ...values,
        ...(Object.keys(details).length > 0 ? { details } : {}),
        ...(Object.keys(travel).length > 0 ? { travel } : {}),
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
    if (result.status === 'itemized') {
      throw new ProblemError(409, 'not-editable', 'Its amount is made of its lines', {
        code: 'itemized',
        detail:
          'A line is left out of it, or it is split: include the lines again, or take the ' +
          'split away, to change its amount or currency.',
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
    return c.json(await detail(who.orgId, found), 200);
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
    if (result.status === 'trip_submitted') {
      throw new ProblemError(409, 'trip-submitted', 'That trip takes no more expenses', {
        code: 'trip_submitted',
        detail: 'Its report is submitted. The expense goes on your next report as local.',
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
    return c.json(await detail(who.orgId, found), 200);
  });
}
