import type { Membership } from '@expensewise/db';
import { quoteMileage, type MileageProblem } from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import type { MileageStore } from './mileage.ts';
import { mileageEntry, mileageQuote } from './mileage-views.ts';
import { ProblemError } from './problem.ts';
import {
  editMileageRoute,
  getMileageRoute,
  logMileageRoute,
  quoteMileageRoute,
} from './routes/mileage.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface MileageRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly mileage?: MileageStore;
  /** Which features are on. Built from `workspace` and the overrides when not given. */
  readonly features?: FeatureGate;
  readonly flagOverrides?: string;
  readonly now?: () => Date;
}

const FLAG = 'expenses.mileage';

/** Mileage by hand (FR-CAP-03, ADR-0038), behind its flag: off, every route answers 404. */
export function registerMileageRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: MileageRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  const features = options.features ?? featureGate(options);
  // The quote first: its path would otherwise read as a drive's id.
  const routes = [quoteMileageRoute, logMileageRoute, getMileageRoute, editMileageRoute];
  for (const path of new Set(routes.map((r) => r.getRoutingPath()))) app.use(path, auth);

  const stores = () => {
    if (!options.workspace || !options.mileage) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, mileage: options.mileage };
  };
  /** The caller's membership, once mileage is known to be on for their organization. */
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
    await features.require(membership.orgId, FLAG);
    return membership;
  };
  const today = () => (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const notFound = () => new ProblemError(404, 'not-found', 'No such drive', { code: 'not_found' });
  const invalid = (problem: MileageProblem) =>
    new ProblemError(422, 'invalid-value', 'A value is not valid', {
      code: 'invalid_value',
      detail: problem.message,
      field: problem.field,
    });
  const shown = async (who: Membership, expenseId: string) => {
    const found = await stores().mileage.get(who.orgId, who.memberId, expenseId);
    if (!found) throw notFound();
    return mileageEntry(found);
  };

  app.openapi(quoteMileageRoute, async (c) => {
    await member(c.var.identity.userId);
    const { date, miles } = c.req.valid('query');
    const quote = quoteMileage({ date, miles }, today());
    if (!quote.ok) throw invalid(quote.error);
    return c.json(mileageQuote(date.trim(), quote.value), 200);
  });

  app.openapi(logMileageRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const result = await stores().mileage.log(
      who.orgId,
      who.memberId,
      c.req.valid('json'),
      caller.userId,
      today(),
    );
    if (result.status === 'invalid') throw invalid(result.problem);
    return c.json(await shown(who, result.expenseId), 201);
  });

  app.openapi(getMileageRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    return c.json(await shown(who, c.req.valid('param').expenseId), 200);
  });

  app.openapi(editMileageRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { expenseId } = c.req.valid('param');
    const result = await stores().mileage.edit(
      who.orgId,
      who.memberId,
      expenseId,
      c.req.valid('json'),
      caller.userId,
      today(),
    );
    if (result.status === 'missing') throw notFound();
    if (result.status === 'invalid') throw invalid(result.problem);
    if (result.status === 'not_editable') {
      throw new ProblemError(409, 'not-editable', 'This drive can’t be changed now', {
        code: 'locked',
        detail: 'It is submitted or approved. An approved drive is corrected by a reversal.',
      });
    }
    if (result.status === 'route') {
      throw new ProblemError(409, 'route-drive', 'This drive is changed by its route', {
        code: 'route',
        detail: 'Change its stops, or claim other miles with a reason (ADR-0039).',
      });
    }
    return c.json(await shown(who, expenseId), 200);
  });
}
