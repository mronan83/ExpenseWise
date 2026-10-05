import type { LineChangeResult, Membership } from '@expensewise/db';
import {
  EXCLUSION_NOTE_MAX,
  format,
  isCurrencyCode,
  money,
  SPLIT_PARTS_MAX,
} from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import type { CategoryStore } from './categories.ts';
import { detailWithCategory } from './category-views.ts';
import type { ExpenseStore } from './expenses.ts';
import { featureGate, type FeatureGate } from './features.ts';
import type { ItemizedStore } from './itemized.ts';
import { categoriesView, itemizedView, readLinesOf, splitWithLines } from './itemized-views.ts';
import { ProblemError } from './problem.ts';
import type { ReceiptWithReadings } from './receipts.ts';
import {
  excludeLineRoute,
  includeLineRoute,
  reportCategoriesRoute,
  splitExpenseRoute,
  unsplitExpenseRoute,
} from './routes/itemized.ts';
import type { WorkspaceStore } from './workspace.ts';
import type { ExpenseRecord } from '@expensewise/db';

/** A receipt's itemized lines shown, and lines excluded (FR-INT-22, FR-EXP-16). */
export const ITEMIZED_FLAG = 'expenses.itemized' as const;
/** An expense split into parts by category and type (FR-EXP-15); needs categories on too. */
export const SPLIT_FLAG = 'expenses.split' as const;
const CATEGORIES_FLAG = 'expenses.categories' as const;
const CONVERSION_FLAG = 'reports.currency-conversion' as const;

export interface ItemizedRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly expenses?: ExpenseStore;
  readonly categories?: CategoryStore;
  /** Lines and splits. Without it, these routes answer 503 and expenses show neither. */
  readonly itemized?: ItemizedStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
}

type Found = { readonly expense: ExpenseRecord; readonly proof: ReceiptWithReadings | null };

/**
 * An expense's itemized lines and split, for its page, while each is on: `itemized` with
 * `expenses.itemized`, `split` with `expenses.split` and categories. Off, neither key is there,
 * so the page reads as it always has.
 */
export function itemizedSections(store: ItemizedStore | undefined, features: FeatureGate) {
  return async (orgId: string, found: Found) => {
    if (!store) return {};
    const [lines, split] = await Promise.all([
      features.isOn(orgId, ITEMIZED_FLAG),
      splitOn(features, orgId),
    ]);
    if (!lines && !split) return {};
    const kept = await store.of(orgId, [found.expense.id]);
    const own = kept.lines.find((l) => l.expenseId === found.expense.id);
    const parts = kept.parts.filter((p) => p.expenseId === found.expense.id);
    return {
      ...(lines ? { itemized: itemizedView(found.expense, own ?? readLinesOf(found.proof)) } : {}),
      ...(split ? { split: splitWithLines(parts, own) } : {}),
    };
  };
}

const splitOn = async (features: FeatureGate, orgId: string) =>
  (await features.isOn(orgId, SPLIT_FLAG)) && (await features.isOn(orgId, CATEGORIES_FLAG));

const PROBLEM_TEXT: Record<string, string> = {
  unknown_reason: 'Pick a reason: personal, paid by someone else, not reimbursable, or other.',
  note_needed: 'Other needs a note saying why.',
  note_too_long: `A note is at most ${EXCLUSION_NOTE_MAX} characters.`,
  no_such_line: 'There is no such line on its receipt.',
  not_an_item: 'Only an item is left out or split off; tax, tip and fees go with the items.',
  takes_off: 'A discount or credit takes money off what was paid, so it can’t be left out.',
  below_zero: 'That would claim less than nothing.',
  lines_dont_add_up: 'Its lines don’t add up, so nothing can be spread across them.',
  nothing_split: 'Give at least one line a category and type.',
  line_excluded: 'An excluded line is in no part. Include it again first.',
  assigned_twice: 'Each line goes in one part.',
  part_not_positive: 'Each part must come to more than zero.',
  too_few_parts: 'A split by amount has at least two parts.',
  too_many_parts: `An expense is split into at most ${SPLIT_PARTS_MAX} parts.`,
  invalid_amount: 'Enter each amount in the expense’s currency, such as 12.50.',
  no_such_category: 'There is no such category.',
  no_such_type: 'There is no such type.',
  category_retired: 'That category is retired. Choose one in use.',
  type_retired: 'That type is retired. Choose one in use.',
  type_not_allowed: 'That category doesn’t allow that type. Choose one of the types it offers.',
};

const UNUSABLE: Record<string, string> = {
  lines_dont_add_up:
    'Its lines don’t add up, so they can’t be excluded or split by line. Split it by amount instead.',
  other_currency: 'It is in another currency than its receipt’s lines.',
  amount_changed:
    'Its amount was changed by hand from what its lines come to, so they no longer make it up.',
};

export function registerItemizedRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ItemizedRouteOptions,
) {
  const features = options.features ?? featureGate({ workspace: options.workspace });
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [
      excludeLineRoute,
      includeLineRoute,
      splitExpenseRoute,
      unsplitExpenseRoute,
      reportCategoriesRoute,
    ].map((r) => r.getRoutingPath()),
  );
  for (const path of paths) app.use(path, auth);
  const sections = itemizedSections(options.itemized, features);

  const stores = () => {
    if (!options.workspace || !options.expenses || !options.itemized) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, expenses: options.expenses, itemized: options.itemized };
  };
  /** The caller's membership, once each feature named is on for their organization. */
  const member = async (userId: string, ...flags: Parameters<FeatureGate['require']>[1][]) => {
    const membership: Membership | undefined = await stores().workspace.findMembership(userId);
    if (!membership) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        { code: 'no_organization', detail: 'Call POST /v1/me/organization after signing in.' },
      );
    }
    for (const flag of flags) await features.require(membership.orgId, flag);
    return membership;
  };
  const notFound = (what = 'expense') =>
    new ProblemError(404, 'not-found', `No such ${what}`, { code: 'not_found' });
  const found = async (orgId: string, expenseId: string) => {
    const expense = await stores().expenses.get(orgId, expenseId);
    if (!expense) throw notFound();
    return expense;
  };
  /** The expense as its page shows it, after a change, or the problem the change ran into. */
  const answer = async (orgId: string, before: Found, result: LineChangeResult, field: string) => {
    const conflict = (code: string, title: string, detail: string) =>
      new ProblemError(409, code.replaceAll('_', '-'), title, { code, detail });
    switch (result.status) {
      case 'missing':
        throw notFound();
      case 'not_editable':
        throw conflict(
          result.current === 'processing' ? 'being_read' : 'locked',
          'This expense can’t change now',
          result.current === 'processing'
            ? 'Its receipt is being read. Try again in a few seconds.'
            : 'It is submitted or approved, so its claim stays as it went in.',
        );
      case 'not_itemized':
        throw conflict('not_itemized', 'Its receipt has no lines', 'Its receipt prints no items.');
      case 'not_usable':
        throw conflict(
          result.problem,
          'Its lines can’t be used now',
          UNUSABLE[result.problem] ?? '',
        );
      case 'no_claim':
        throw conflict('no_claim', 'This expense claims nothing yet', 'Fill in its amount first.');
      case 'mileage':
        throw conflict(
          'mileage',
          'A drive isn’t split',
          'It is paid at miles × its rate, and changed as mileage.',
        );
      case 'split_by_amount':
        throw conflict(
          'split_by_amount',
          'It is split by amount',
          'Take the split away, or split it by line, before changing what its lines claim.',
        );
      case 'invalid': {
        const { amountMinor, currency } = before.expense;
        const claim =
          amountMinor !== null && currency !== null && isCurrencyCode(currency)
            ? format(money(amountMinor, currency))
            : 'what it claims';
        throw new ProblemError(422, 'invalid-value', 'A value is not valid', {
          code: result.problem,
          detail:
            result.problem === 'parts_dont_add_up'
              ? `The parts must add up to ${claim} exactly.`
              : PROBLEM_TEXT[result.problem],
          field: result.index === undefined ? field : `${field}[${result.index}]`,
        });
      }
      case 'changed':
      case 'unchanged': {
        const after = await found(orgId, before.expense.id);
        const categories = (await features.isOn(orgId, CATEGORIES_FLAG))
          ? options.categories
          : undefined;
        return {
          ...(await detailWithCategory(categories, orgId, after)),
          ...(await sections(orgId, after)),
        };
      }
    }
  };

  app.openapi(excludeLineRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId, ITEMIZED_FLAG);
    const { expenseId, position } = c.req.valid('param');
    const before = await found(who.orgId, expenseId);
    const result = await stores().itemized.exclude(
      who.orgId,
      expenseId,
      position,
      c.req.valid('json'),
      userId,
      readLinesOf(before.proof),
    );
    const field =
      result.status === 'invalid' && result.problem.startsWith('note') ? 'note' : 'reason';
    return c.json(await answer(who.orgId, before, result, field), 200);
  });

  app.openapi(includeLineRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId, ITEMIZED_FLAG);
    const { expenseId, position } = c.req.valid('param');
    const before = await found(who.orgId, expenseId);
    const result = await stores().itemized.include(
      who.orgId,
      expenseId,
      position,
      userId,
      readLinesOf(before.proof),
    );
    return c.json(await answer(who.orgId, before, result, 'position'), 200);
  });

  app.openapi(splitExpenseRoute, async (c) => {
    const { userId } = c.var.identity;
    const request = c.req.valid('json');
    const who = await member(
      userId,
      SPLIT_FLAG,
      CATEGORIES_FLAG,
      ...(request.basis === 'lines' ? [ITEMIZED_FLAG] : []),
    );
    const { expenseId } = c.req.valid('param');
    const before = await found(who.orgId, expenseId);
    const result = await stores().itemized.split(
      who.orgId,
      expenseId,
      request,
      userId,
      readLinesOf(before.proof),
    );
    return c.json(
      await answer(who.orgId, before, result, request.basis === 'lines' ? 'lines' : 'parts'),
      200,
    );
  });

  app.openapi(unsplitExpenseRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId, SPLIT_FLAG, CATEGORIES_FLAG);
    const { expenseId } = c.req.valid('param');
    const before = await found(who.orgId, expenseId);
    const result = await stores().itemized.unsplit(who.orgId, expenseId, userId);
    return c.json(await answer(who.orgId, before, result, 'split'), 200);
  });

  app.openapi(reportCategoriesRoute, async (c) => {
    const who = await member(c.var.identity.userId, SPLIT_FLAG, CATEGORIES_FLAG);
    const { reportId } = c.req.valid('param');
    const report = await stores().itemized.byCategory(who.orgId, reportId);
    if (!report) throw notFound('report');
    const converting = await features.isOn(who.orgId, CONVERSION_FLAG);
    return c.json(categoriesView(reportId, report.currency, report.expenses, converting), 200);
  });
}
