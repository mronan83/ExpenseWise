import { CONVERSION_FLAG, type CommittedEvent, type ReimbursementCurrency } from '@expensewise/db';
import { hasReferenceRate, SUPPORTED_CURRENCIES } from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';
import type { ReimbursementStore } from './reimbursement.ts';
import {
  getReimbursementCurrencyRoute,
  setReimbursementCurrencyRoute,
} from './routes/reimbursement.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface ReimbursementRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly reimbursement?: ReimbursementStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
  /** Hands the request to convert to the workflow runner at once; the relay catches a miss. */
  readonly dispatch?: (events: readonly CommittedEvent[]) => Promise<void>;
}

/** Every supported currency, and whether the rate source publishes it (ADR-0034). */
const CURRENCIES = SUPPORTED_CURRENCIES.map((code) => ({
  code,
  converts: hasReferenceRate(code),
}));

const view = (c: ReimbursementCurrency) => ({ ...c, currencies: CURRENCIES });

/** The person's reimbursement currency, in Settings › Currency (FR-EXP-13, Q23). */
export function registerReimbursementRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: ReimbursementRouteOptions,
) {
  const features = options.features ?? featureGate(options);
  // One path serves both operations.
  app.use(getReimbursementCurrencyRoute.getRoutingPath(), requireIdentity(options.verifyToken));

  const stores = () => {
    if (!options.workspace || !options.reimbursement) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, reimbursement: options.reimbursement };
  };
  const noOrganization = () =>
    new ProblemError(403, 'no-organization', 'You are not a member of an organization yet', {
      code: 'no_organization',
      detail: 'Call POST /v1/me/organization after signing in.',
    });
  /** The caller's membership, once the feature is known to be on for their organization. */
  const member = async (userId: string) => {
    const membership = await stores().workspace.findMembership(userId);
    if (!membership) throw noOrganization();
    await features.require(membership.orgId, CONVERSION_FLAG);
    return membership;
  };

  app.openapi(getReimbursementCurrencyRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const found = await stores().reimbursement.get(who.orgId, who.memberId);
    if (!found) throw noOrganization();
    return c.json(view(found), 200);
  });

  app.openapi(setReimbursementCurrencyRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { currency } = c.req.valid('json');
    const result = await stores().reimbursement.set(
      who.orgId,
      who.memberId,
      currency,
      caller.userId,
    );
    if (result.status === 'missing') throw noOrganization();
    if (result.status === 'set' && result.event && options.dispatch) {
      try {
        await options.dispatch([result.event]);
      } catch (error) {
        // The request is committed in the outbox; the relay's sweep sends it later.
        console.warn('Handing a conversion request to the workflow runner failed', error);
      }
    }
    return c.json(view(result.currency), 200);
  });
}
