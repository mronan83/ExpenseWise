import type { Membership } from '@expensewise/db';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import type { CategoryStore } from './categories.ts';
import { featureGate, type FeatureGate } from './features.ts';
import type { HomeStore } from './home.ts';
import type { ModelSettingsStore } from './model-settings.ts';
import { homeView } from './home-views.ts';
import { askForCoding } from './needs-you-views.ts';
import { ProblemError } from './problem.ts';
import { showConverted } from './reimbursement.ts';
import { homeRoute } from './routes/home.ts';
import { unfiledEmailsAsked, type UnfiledEmailStore } from './unfiled-emails.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface HomeRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly home?: HomeStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
  /** Present where AI model settings can be on (FR-INT-16). */
  readonly modelSettings?: ModelSettingsStore;
  /** Present where categories can be on, so Needs you asks for them (FR-EXP-11, Q27). */
  readonly categories?: CategoryStore;
  /** Present where emails that filed nothing can be on, so Needs you lists them (#59). */
  readonly emails?: UnfiledEmailStore;
  readonly now?: () => Date;
}

/** Needs you shows its newest few; the inbox counts them all, up to this many. */
const NEEDS_LIMIT = 100;
const NEEDS_SHOWN = 3;

export function registerHomeRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: HomeRouteOptions,
) {
  app.use(homeRoute.getRoutingPath(), requireIdentity(options.verifyToken));
  const features = options.features ?? featureGate(options);

  const stores = () => {
    if (!options.workspace || !options.home) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, home: options.home };
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

  app.openapi(homeRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const now = options.now?.() ?? new Date();
    const day = c.req.valid('query').day ?? now.toISOString().slice(0, 10);
    const data = await stores().home.snapshot(who.orgId, who.memberId, day, NEEDS_LIMIT, {
      uncoded: await askForCoding(options, features, who.orgId),
      unfiledSince: await unfiledEmailsAsked(options, features, who.orgId, now),
    });
    const settingsOn =
      options.modelSettings !== undefined &&
      (await features.isOn(who.orgId, 'receipts.model-settings'));
    const converting = await showConverted(features, who.orgId, data.reports.reports);
    // Asked only when there are drives to show: with none, Home reads as it always has.
    const mileage =
      (data.home.monthDrives?.length ?? 0) > 0 &&
      (await features.isOn(who.orgId, 'expenses.mileage'));
    return c.json(homeView(data, day, NEEDS_SHOWN, now, settingsOn, converting, mileage), 200);
  });
}
