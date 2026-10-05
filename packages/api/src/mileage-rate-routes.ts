import type { Membership } from '@expensewise/db';
import {
  IRS_BUSINESS_RATES_THROUGH,
  rateDecimal,
  rateOn,
  type MemberRole,
} from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import type { MileageRateSettings, MileageRateStore } from './mileage-rates.ts';
import { rateView } from './mileage-views.ts';
import { ProblemError } from './problem.ts';
import { requireAdminSecondFactor } from './second-factor.ts';
import { getMileageRatesRoute, setMileageRateRoute } from './routes/mileage-rates.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface MileageRateRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  /** The organization's rate a mile (Q28). Without it, these routes answer 503. */
  readonly mileageRates?: MileageRateStore;
  /** Which features are on. Built from `workspace` and the overrides when not given. */
  readonly features?: FeatureGate;
  readonly flagOverrides?: string;
  readonly now?: () => Date;
}

const FLAG = 'expenses.mileage';

/** Who sets what drives are paid at: what the organization reimburses is finance's call. */
const RATE_ROLES: ReadonlySet<MemberRole> = new Set(['owner', 'finance_admin']);

/** The rate in force today, where it comes from, and every change, as Settings shows them. */
export function mileageRatesView(settings: MileageRateSettings, today: string, who: Membership) {
  const inForce = rateOn(today, settings.policy);
  return {
    today,
    inForce: inForce.ok
      ? { rate: rateView(inForce.value), problem: null }
      : { rate: null, problem: inForce.error.message },
    changes: settings.changes.map((c) => ({
      effectiveFrom: c.effectiveFrom,
      source: c.rate ? ('organization' as const) : ('irs-business' as const),
      perMile: c.rate ? rateDecimal(c.rate) : null,
      currency: c.rate?.currency ?? null,
      setBy: c.setBy,
      setAt: c.setAt.toISOString(),
    })),
    homeCurrency: settings.homeCurrency,
    irsThrough: IRS_BUSINESS_RATES_THROUGH,
    canChange: RATE_ROLES.has(who.role),
  };
}

/**
 * The organization's rate a mile (Q28, #77), behind the mileage flag: every member reads it;
 * owners and finance admins set their own from a day, or go back to the IRS rate.
 */
export function registerMileageRateRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: MileageRateRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  const features = options.features ?? featureGate(options);
  for (const route of [getMileageRatesRoute, setMileageRateRoute]) {
    app.use(route.getRoutingPath(), auth);
  }

  const stores = () => {
    if (!options.workspace || !options.mileageRates) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, rates: options.mileageRates };
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
  const shown = async (who: Membership) => {
    const settings = await stores().rates.settings(who.orgId);
    if (!settings) {
      throw new ProblemError(404, 'not-found', 'No such organization', { code: 'not_found' });
    }
    return mileageRatesView(settings, today(), who);
  };

  app.openapi(getMileageRatesRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    return c.json(await shown(who), 200);
  });

  app.openapi(setMileageRateRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    if (!RATE_ROLES.has(who.role)) {
      throw new ProblemError(403, 'forbidden', 'Only an owner or finance admin can do this', {
        code: 'forbidden_role',
        detail: 'What drives are paid at is set by an owner or a finance admin.',
      });
    }
    await requireAdminSecondFactor(features, who.orgId, caller);
    const { effectiveFrom } = c.req.valid('param');
    const { perMile } = c.req.valid('json');
    const result = await stores().rates.set(
      who.orgId,
      { effectiveFrom, perMile },
      { userId: caller.userId, memberId: who.memberId },
    );
    if (result.status === 'invalid') {
      throw new ProblemError(422, 'invalid-value', 'A value is not valid', {
        code: 'invalid_value',
        detail: result.problem.message,
        field: result.problem.field,
      });
    }
    if (result.status === 'missing') {
      throw new ProblemError(404, 'not-found', 'No such organization', { code: 'not_found' });
    }
    return c.json(await shown(who), 200);
  });
}
