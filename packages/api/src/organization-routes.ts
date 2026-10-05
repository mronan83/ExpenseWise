import type { Membership, OrganizationRecord } from '@expensewise/db';
import { DUPLICATE_TIME_WINDOW_MINUTES, DUPLICATE_WINDOW_MAX_MINUTES } from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type Identity, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import type { OrganizationStore } from './organization.ts';
import { ProblemError } from './problem.ts';
import { requireAdminSecondFactor } from './second-factor.ts';
import {
  editOrganizationRoute,
  getDuplicateWindowRoute,
  getOrganizationRoute,
  setDuplicateWindowRoute,
} from './routes/organization.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface OrganizationRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  /** The organization's own settings. Without it, these routes answer 503. */
  readonly organization?: OrganizationStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
}

const settingsOf = (org: OrganizationRecord, who: Membership) => ({
  organization: {
    id: org.id,
    name: org.name,
    homeCurrency: org.homeCurrency,
    country: org.country,
    locale: org.locale,
    timeZone: org.timeZone,
    address: org.address,
    industry: org.industry,
    size: org.size,
  },
  role: who.role,
  canEdit: who.role === 'owner',
});

const windowOf = (minutes: number | null, who: Membership) => ({
  minutes: minutes ?? DUPLICATE_TIME_WINDOW_MINUTES,
  defaultMinutes: DUPLICATE_TIME_WINDOW_MINUTES,
  maxMinutes: DUPLICATE_WINDOW_MAX_MINUTES,
  canEdit: who.role === 'owner',
});

/**
 * Settings › Organization (FR-PLT-11, FR-INT-19): the organization's details and its duplicate
 * time window, each behind its own flag. Every member reads them; only the owner changes them.
 */
export function registerOrganizationRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: OrganizationRouteOptions,
) {
  const features = options.features ?? featureGate(options);
  const auth = requireIdentity(options.verifyToken);
  const paths = new Set(
    [
      getOrganizationRoute,
      editOrganizationRoute,
      getDuplicateWindowRoute,
      setDuplicateWindowRoute,
    ].map((r) => r.getRoutingPath()),
  );
  for (const path of paths) app.use(path, auth);

  const stores = () => {
    if (!options.workspace || !options.organization) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, organization: options.organization };
  };
  const member = async (userId: string): Promise<Membership> => {
    const membership = await stores().workspace.findMembership(userId);
    if (!membership) {
      throw new ProblemError(
        403,
        'no-organization',
        'You are not a member of an organization yet',
        { code: 'no_organization', detail: 'Call POST /v1/me/organization after signing in.' },
      );
    }
    return membership;
  };
  /** The owner alone changes these, past the second factor while it is on (FR-GOV-04). */
  const ownerOnly = async (who: Membership, identity: Identity, what: string) => {
    if (who.role !== 'owner') {
      throw new ProblemError(403, 'forbidden', `Only the owner can change ${what}`, {
        code: 'forbidden_role',
      });
    }
    await requireAdminSecondFactor(features, who.orgId, identity);
  };
  const organizationOf = async (orgId: string) => {
    const org = await stores().organization.get(orgId);
    if (!org) throw new Error('The organization is not visible to its member');
    return org;
  };

  app.openapi(getOrganizationRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    await features.require(who.orgId, 'settings.organization');
    return c.json(settingsOf(await organizationOf(who.orgId), who), 200);
  });

  app.openapi(editOrganizationRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    await features.require(who.orgId, 'settings.organization');
    await ownerOnly(who, c.var.identity, 'the organization’s details');
    const result = await stores().organization.update(
      who.orgId,
      c.req.valid('json'),
      c.var.identity.userId,
    );
    switch (result.status) {
      case 'updated':
      case 'unchanged':
        return c.json(settingsOf(result.organization, who), 200);
      case 'invalid':
        throw new ProblemError(422, 'invalid-value', 'A value is not valid', {
          code: 'invalid_value',
          detail: result.problem.message,
          field: result.problem.field,
        });
      case 'missing':
        throw new Error('The organization is not visible to its member');
    }
  });

  app.openapi(getDuplicateWindowRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    await features.require(who.orgId, 'settings.duplicate-window');
    const org = await organizationOf(who.orgId);
    return c.json(windowOf(org.duplicateWindowMinutes, who), 200);
  });

  app.openapi(setDuplicateWindowRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    await features.require(who.orgId, 'settings.duplicate-window');
    await ownerOnly(who, c.var.identity, 'the duplicate time window');
    const { minutes } = c.req.valid('json');
    const result = await stores().organization.setDuplicateWindow(
      who.orgId,
      minutes,
      c.var.identity.userId,
    );
    // The schema already kept it to 0 to 120 whole minutes.
    if (result.status === 'invalid' || result.status === 'missing') {
      throw new Error(`Setting the duplicate window answered ${result.status}`);
    }
    return c.json(windowOf(minutes, who), 200);
  });
}
