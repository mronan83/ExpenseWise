import type { Membership } from '@expensewise/db';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';
import { dismissEmailRoute } from './routes/inbox.ts';
import { UNFILED_EMAILS_FLAG, type UnfiledEmailStore } from './unfiled-emails.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface UnfiledEmailRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly emails?: UnfiledEmailStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
  readonly flagOverrides?: string;
}

/** Dismissing an email that filed nothing from Needs you (#59), behind its flag. */
export function registerUnfiledEmailRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: UnfiledEmailRouteOptions,
) {
  app.use(dismissEmailRoute.getRoutingPath(), requireIdentity(options.verifyToken));
  const features = options.features ?? featureGate(options);

  const stores = () => {
    if (!options.workspace || !options.emails) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, emails: options.emails };
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

  app.openapi(dismissEmailRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    await features.require(who.orgId, UNFILED_EMAILS_FLAG);
    const { emailId } = c.req.valid('param');
    // Someone else's is refused by the database, and answers 403 not_yours (ADR-0035).
    const result = await stores().emails.dismiss(who.orgId, emailId, caller.userId);
    if (result === 'missing') {
      throw new ProblemError(404, 'not-found', 'No such email in Needs you', {
        code: 'not_found',
        detail: 'Only an email from your own address that filed nothing can be dismissed.',
      });
    }
    return c.body(null, 204);
  });
}
