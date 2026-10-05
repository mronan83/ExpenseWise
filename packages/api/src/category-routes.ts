import type { CatalogDeletion, CatalogWrite, Membership } from '@expensewise/db';
import type { MemberRole } from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type Identity, type TokenVerifier } from './auth.ts';
import type { CategoryStore } from './categories.ts';
import { catalogView, categoryView, detailWithCategory, typeView } from './category-views.ts';
import type { ExpenseStore } from './expenses.ts';
import { featureGate, type FeatureGate } from './features.ts';
import type { ItemizedStore } from './itemized.ts';
import { itemizedSections } from './itemized-routes.ts';
import { ProblemError } from './problem.ts';
import { requireAdminSecondFactor } from './second-factor.ts';
import {
  classifyExpenseRoute,
  createCategoryRoute,
  createTypeRoute,
  deleteCategoryRoute,
  deleteTypeRoute,
  getCatalogRoute,
  updateCategoryRoute,
  updateTypeRoute,
} from './routes/categories.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface CategoryRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly expenses?: ExpenseStore;
  /** Categories and types. Without it, these routes answer 503. */
  readonly categories?: CategoryStore;
  /** Lines and splits, shown on the expense a choice answers with while they are on. */
  readonly itemized?: ItemizedStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
}

export const CATEGORIES_FLAG = 'expenses.categories' as const;
const FLAG = CATEGORIES_FLAG;

/** Who keeps the lists: what is coded where is finance's call (design §5.2). */
const MANAGER_ROLES: ReadonlySet<MemberRole> = new Set(['owner', 'finance_admin']);

const PROBLEM_TEXT: Record<string, string> = {
  invalid_name: 'A name is needed, of at most 80 characters.',
  name_taken: 'Another one in this list has that name.',
  invalid_code: 'A code is at most 40 characters.',
  no_such_parent: 'There is no such one to put it under.',
  nests_in_itself: 'It can’t sit under itself or anything under it.',
  no_such_type: 'One of those types doesn’t exist.',
  no_such_category: 'There is no such category.',
  category_retired: 'That category is retired. Choose one in use.',
  type_retired: 'That type is retired. Choose one in use.',
  type_not_allowed: 'That category doesn’t allow that type. Choose one of the types it offers.',
};

export function registerCategoryRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: CategoryRouteOptions,
) {
  const features = options.features ?? featureGate({ workspace: options.workspace });
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [
      getCatalogRoute,
      createCategoryRoute,
      updateCategoryRoute,
      deleteCategoryRoute,
      createTypeRoute,
      updateTypeRoute,
      deleteTypeRoute,
      classifyExpenseRoute,
    ].map((r) => r.getRoutingPath()),
  );
  for (const path of paths) app.use(path, auth);

  const notConfigured = () =>
    new ProblemError(
      503,
      'database-not-configured',
      'The database is not configured on this server',
      {
        code: 'database_not_configured',
      },
    );
  const workspace = () => {
    if (!options.workspace) throw notConfigured();
    return options.workspace;
  };
  const store = () => {
    if (!options.categories) throw notConfigured();
    return options.categories;
  };

  /** The caller's membership, once the feature is on for their organization. */
  const member = async (userId: string): Promise<Membership> => {
    const membership = await workspace().findMembership(userId);
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
    await features.require(membership.orgId, FLAG);
    return membership;
  };
  /**
   * The caller's membership, when they may change the lists: past the second factor while it
   * is on (FR-GOV-04).
   */
  const manager = async (identity: Identity): Promise<Membership> => {
    const membership = await member(identity.userId);
    if (!MANAGER_ROLES.has(membership.role)) {
      throw new ProblemError(403, 'forbidden', 'Only an owner or finance admin can do this', {
        code: 'forbidden_role',
      });
    }
    await requireAdminSecondFactor(features, membership.orgId, identity);
    return membership;
  };
  const notFound = (what: string) =>
    new ProblemError(404, 'not-found', `No such ${what}`, { code: 'not_found' });
  const invalid = (problem: string, field: string) =>
    new ProblemError(422, 'invalid-value', 'A value is not valid', {
      code: problem,
      detail: PROBLEM_TEXT[problem],
      field,
    });
  /** The record a write saved, or the problem it ran into. */
  const saved = <T extends { id: string }>(result: CatalogWrite<T>, what: string): T => {
    if (result.status === 'missing') throw notFound(what);
    if (result.status === 'invalid') throw invalid(result.problem, result.field);
    return result.record;
  };
  const deleted = (outcome: CatalogDeletion, what: string) => {
    if (outcome === 'missing') throw notFound(what);
    if (outcome === 'in_use') {
      throw new ProblemError(409, 'in-use', `An expense has this ${what}`, {
        code: 'in_use',
        detail: 'Retire it instead: it is no longer offered, and old claims keep it.',
      });
    }
    if (outcome === 'has_children') {
      throw new ProblemError(409, 'has-children', `Another ${what} sits under this one`, {
        code: 'has_children',
        detail: 'Move or delete what sits under it first, or retire it.',
      });
    }
  };
  const actorOf = (who: Membership, userId: string) => ({ memberId: who.memberId, userId });

  app.openapi(getCatalogRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const catalog = await store().catalog(who.orgId);
    return c.json(catalogView(catalog, MANAGER_ROLES.has(who.role)), 200);
  });

  app.openapi(createCategoryRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await manager(c.var.identity);
    const result = await store().saveCategory(
      who.orgId,
      null,
      c.req.valid('json'),
      actorOf(who, userId),
    );
    const record = saved(result, 'category');
    return c.json(categoryView(await store().catalog(who.orgId), record.id)!, 201);
  });

  app.openapi(updateCategoryRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await manager(c.var.identity);
    const { categoryId } = c.req.valid('param');
    const result = await store().saveCategory(
      who.orgId,
      categoryId,
      c.req.valid('json'),
      actorOf(who, userId),
    );
    const record = saved(result, 'category');
    return c.json(categoryView(await store().catalog(who.orgId), record.id)!, 200);
  });

  app.openapi(deleteCategoryRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await manager(c.var.identity);
    const { categoryId } = c.req.valid('param');
    deleted(await store().deleteCategory(who.orgId, categoryId, userId), 'category');
    return c.body(null, 204);
  });

  app.openapi(createTypeRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await manager(c.var.identity);
    const result = await store().saveType(
      who.orgId,
      null,
      c.req.valid('json'),
      actorOf(who, userId),
    );
    const record = saved(result, 'type');
    return c.json(typeView(await store().catalog(who.orgId), record.id)!, 201);
  });

  app.openapi(updateTypeRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await manager(c.var.identity);
    const { typeId } = c.req.valid('param');
    const result = await store().saveType(
      who.orgId,
      typeId,
      c.req.valid('json'),
      actorOf(who, userId),
    );
    const record = saved(result, 'type');
    return c.json(typeView(await store().catalog(who.orgId), record.id)!, 200);
  });

  app.openapi(deleteTypeRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await manager(c.var.identity);
    const { typeId } = c.req.valid('param');
    deleted(await store().deleteType(who.orgId, typeId, userId), 'type');
    return c.body(null, 204);
  });

  app.openapi(classifyExpenseRoute, async (c) => {
    const { userId } = c.var.identity;
    const who = await member(userId);
    const { expenseId } = c.req.valid('param');
    if (!options.expenses) throw notConfigured();
    const result = await store().classify(who.orgId, expenseId, c.req.valid('json'), userId);
    if (result.status === 'missing') throw notFound('expense');
    if (result.status === 'not_editable') {
      throw new ProblemError(409, 'not-editable', 'This expense can’t change now', {
        code: 'locked',
        detail: 'It is submitted or later, so it stays as it went in.',
      });
    }
    if (result.status === 'invalid') {
      const onCategory = ['no_such_category', 'category_retired'].includes(result.problem);
      throw invalid(result.problem, onCategory ? 'categoryId' : 'typeId');
    }
    const found = await options.expenses.get(who.orgId, expenseId);
    if (!found) throw notFound('expense');
    return c.json(
      {
        ...(await detailWithCategory(store(), who.orgId, found)),
        ...(await itemizedSections(options.itemized, features)(who.orgId, found)),
      },
      200,
    );
  });
}
