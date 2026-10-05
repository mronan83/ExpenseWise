import { ROUTE_MILEAGE_FLAG, type CommittedEvent, type Membership } from '@expensewise/db';
import type { MemberRole, MileageProblem, RouteProblem } from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { isPlausibleKey, normalizeProviderKey } from './ai-providers.ts';
import { requireIdentity, type AuthVariables, type Identity, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';
import { requireAdminSecondFactor } from './second-factor.ts';
import {
  routeSealContext,
  type RouteKeyStore,
  type RouteKeyVerdict,
  type RouteKeyVerifier,
  type RouteMileageStore,
} from './route-mileage.ts';
import { placeView, routeDriveView, routeKeyStatus } from './route-mileage-views.ts';
import {
  addPlaceRoute,
  changePlaceRoute,
  changeRouteDriveRoute,
  claimRouteMilesRoute,
  deleteRouteKeyRoute,
  getRouteDriveRoute,
  getRouteKeyRoute,
  listPlacesRoute,
  logRouteDriveRoute,
  removePlaceRoute,
  setRouteKeyRoute,
} from './routes/route-mileage.ts';
import { keyHint, type SecretBox } from './secret-box.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface RouteMileageRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly routeMileage?: RouteMileageStore;
  readonly routeKeys?: RouteKeyStore;
  /** Encrypts the route key at rest, as it does AI keys (ADR-0015). */
  readonly secrets?: SecretBox;
  /** Checks a key with one short route on OpenRouteService, as it is saved (Q31). */
  readonly verifyRouteKey?: RouteKeyVerifier;
  /** Hands a request to measure to the workflow runner at once; the relay catches a miss. */
  readonly dispatch?: (events: readonly CommittedEvent[]) => Promise<void>;
  /** Which features are on. Built from `workspace` and the overrides when not given. */
  readonly features?: FeatureGate;
  readonly flagOverrides?: string;
  readonly now?: () => Date;
}

/** Who keeps the organization's key: it is the organization's OpenRouteService account. */
const MANAGER_ROLES: ReadonlySet<MemberRole> = new Set(['owner', 'finance_admin']);

/** "OpenRouteService answered 403: …", or why there was no answer. */
const answered = (verdict: Extract<RouteKeyVerdict, { ok: false }>) =>
  `${verdict.detail ?? 'OpenRouteService gave no answer'}. Nothing was stored.`;

/**
 * Route-based mileage (FR-CAP-04, ADR-0039) behind `expenses.route-mileage`: off, every route
 * answers 404. A drive by its stops, measured after the answer through the outbox; saved
 * places; the miles claimed with a reason (Q33); and the organization's OpenRouteService key,
 * checked with one short route as it is saved and stored encrypted (Q31).
 */
export function registerRouteMileageRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: RouteMileageRouteOptions,
) {
  const auth = requireIdentity(options.verifyToken);
  const features = options.features ?? featureGate(options);
  const routes = [
    logRouteDriveRoute,
    getRouteDriveRoute,
    changeRouteDriveRoute,
    claimRouteMilesRoute,
    listPlacesRoute,
    addPlaceRoute,
    changePlaceRoute,
    removePlaceRoute,
    getRouteKeyRoute,
    setRouteKeyRoute,
    deleteRouteKeyRoute,
  ];
  for (const path of new Set(routes.map((r) => r.getRoutingPath()))) app.use(path, auth);

  const unconfigured = () =>
    new ProblemError(
      503,
      'database-not-configured',
      'The database is not configured on this server',
      {
        code: 'database_not_configured',
      },
    );
  const workspace = () => {
    if (!options.workspace) throw unconfigured();
    return options.workspace;
  };
  const drives = () => {
    if (!options.routeMileage) throw unconfigured();
    return options.routeMileage;
  };
  const keys = () => {
    if (!options.routeKeys) throw unconfigured();
    return options.routeKeys;
  };
  /** The caller's membership, once route mileage is known to be on for their organization. */
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
    await features.require(membership.orgId, ROUTE_MILEAGE_FLAG);
    return membership;
  };
  const manager = async (userId: string): Promise<Membership> => {
    const membership = await member(userId);
    if (!MANAGER_ROLES.has(membership.role)) {
      throw new ProblemError(403, 'forbidden', 'Only an owner or finance admin can do this', {
        code: 'forbidden_role',
      });
    }
    return membership;
  };
  /** A manager changing the key, past the second factor while it is on (FR-GOV-04). */
  const admin = async (identity: Identity): Promise<Membership> => {
    const membership = await manager(identity.userId);
    await requireAdminSecondFactor(features, membership.orgId, identity);
    return membership;
  };
  const today = () => (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  const notFound = () =>
    new ProblemError(404, 'not-found', 'No such route drive', { code: 'not_found' });
  const invalid = (problem: RouteProblem | MileageProblem) =>
    new ProblemError(422, 'invalid-value', 'A value is not valid', {
      code: 'invalid_value',
      detail: problem.message,
      field: problem.field,
      ...('stop' in problem && problem.stop !== undefined ? { stop: problem.stop } : {}),
    });
  const locked = () =>
    new ProblemError(409, 'not-editable', 'This drive can’t be changed now', {
      code: 'locked',
      detail: 'It is submitted or approved. An approved drive is corrected by a reversal.',
    });
  const shown = async (who: Membership, expenseId: string) => {
    const found = await drives().get(who.orgId, who.memberId, expenseId);
    if (!found) throw notFound();
    return routeDriveView(found);
  };
  const handOn = async (event: CommittedEvent | null) => {
    if (!event || !options.dispatch) return;
    try {
      await options.dispatch([event]);
    } catch (error) {
      // The request is committed in the outbox; the relay's sweep sends it later.
      console.warn('Handing a route to measure to the workflow runner failed', error);
    }
  };

  app.openapi(logRouteDriveRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const result = await drives().log(
      who.orgId,
      who.memberId,
      c.req.valid('json'),
      caller.userId,
      today(),
    );
    if (result.status === 'invalid') throw invalid(result.problem);
    await handOn(result.event);
    return c.json(await shown(who, result.expenseId), 201);
  });

  app.openapi(getRouteDriveRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    return c.json(await shown(who, c.req.valid('param').expenseId), 200);
  });

  app.openapi(changeRouteDriveRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { expenseId } = c.req.valid('param');
    const result = await drives().change(
      who.orgId,
      who.memberId,
      expenseId,
      c.req.valid('json'),
      caller.userId,
      today(),
    );
    if (result.status === 'missing' || result.status === 'not_route') throw notFound();
    if (result.status === 'invalid') throw invalid(result.problem);
    if (result.status === 'not_editable') throw locked();
    if (result.status === 'changed') await handOn(result.event);
    return c.json(await shown(who, expenseId), 200);
  });

  app.openapi(claimRouteMilesRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { expenseId } = c.req.valid('param');
    const result = await drives().claim(
      who.orgId,
      who.memberId,
      expenseId,
      c.req.valid('json'),
      caller.userId,
      today(),
    );
    if (result.status === 'missing' || result.status === 'not_route') throw notFound();
    if (result.status === 'invalid') throw invalid(result.problem);
    if (result.status === 'not_editable') throw locked();
    if (result.status === 'measuring') {
      throw new ProblemError(409, 'measuring', 'This drive is still being measured', {
        code: 'measuring',
        detail: 'Its miles can be changed once it is measured.',
      });
    }
    return c.json(await shown(who, expenseId), 200);
  });

  const nameTaken = () =>
    new ProblemError(409, 'name-taken', 'You keep a place by that name already', {
      code: 'name_taken',
    });
  const noPlace = () => new ProblemError(404, 'not-found', 'No such place', { code: 'not_found' });

  app.openapi(listPlacesRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    const places = await drives().places(who.orgId, who.memberId);
    return c.json({ places: places.map(placeView) }, 200);
  });

  app.openapi(addPlaceRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const result = await drives().savePlace(
      who.orgId,
      who.memberId,
      null,
      c.req.valid('json'),
      caller.userId,
    );
    if (result.status === 'invalid') throw invalid(result.problem);
    if (result.status === 'taken') throw nameTaken();
    if (result.status === 'missing') throw noPlace();
    return c.json(placeView(result.place), 201);
  });

  app.openapi(changePlaceRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const result = await drives().savePlace(
      who.orgId,
      who.memberId,
      c.req.valid('param').placeId,
      c.req.valid('json'),
      caller.userId,
    );
    if (result.status === 'invalid') throw invalid(result.problem);
    if (result.status === 'taken') throw nameTaken();
    if (result.status === 'missing') throw noPlace();
    return c.json(placeView(result.place), 200);
  });

  app.openapi(removePlaceRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const removed = await drives().removePlace(
      who.orgId,
      who.memberId,
      c.req.valid('param').placeId,
      caller.userId,
    );
    if (!removed) throw noPlace();
    return c.body(null, 204);
  });

  app.openapi(getRouteKeyRoute, async (c) => {
    const who = await manager(c.var.identity.userId);
    return c.json(routeKeyStatus(await keys().get(who.orgId)), 200);
  });

  app.openapi(setRouteKeyRoute, async (c) => {
    const caller = c.var.identity;
    const who = await admin(caller);
    if (!options.secrets || !options.verifyRouteKey) {
      throw new ProblemError(
        503,
        'encryption-not-configured',
        'Key storage is not configured on this server',
        {
          code: 'encryption_not_configured',
        },
      );
    }
    const apiKey = normalizeProviderKey(c.req.valid('json').apiKey);
    if (!isPlausibleKey(apiKey)) {
      throw new ProblemError(
        422,
        'key-malformed',
        'That doesn’t look like an OpenRouteService key',
        {
          code: 'key_malformed',
          detail:
            'It is too short or has characters keys never contain. Copy it again from your ' +
            'OpenRouteService dashboard and paste only the key. Nothing was stored.',
        },
      );
    }
    // Inline, as AI keys are checked (ADR-0015): one short route, before anything is stored.
    const verdict = await options.verifyRouteKey(apiKey);
    if (!verdict.ok) {
      // Never the key: OpenRouteService's status and words, for diagnosing from the logs.
      console.warn(`Checking an OpenRouteService key: ${verdict.reason}`, verdict.status ?? '');
      if (verdict.reason === 'rejected' || verdict.reason === 'refused') {
        throw new ProblemError(
          422,
          verdict.reason === 'rejected' ? 'key-rejected' : 'key-refused',
          verdict.reason === 'rejected'
            ? 'OpenRouteService rejected this key'
            : 'OpenRouteService refused the check',
          { code: `key_${verdict.reason}`, detail: answered(verdict) },
        );
      }
      throw new ProblemError(
        502,
        'provider-unreachable',
        verdict.reason === 'limited'
          ? 'OpenRouteService says this key’s allowance is used up for now'
          : 'OpenRouteService could not be reached',
        { code: 'provider_unreachable', detail: `${answered(verdict)} Try again later.` },
      );
    }
    const saved = await keys().save(
      who.orgId,
      {
        provider: 'openrouteservice',
        ciphertext: options.secrets.seal(apiKey, routeSealContext(who.orgId, 'openrouteservice')),
        keyHint: keyHint(apiKey),
        verifiedAt: options.now?.() ?? new Date(),
        memberId: who.memberId,
      },
      caller.userId,
    );
    return c.json(routeKeyStatus(saved), 200);
  });

  app.openapi(deleteRouteKeyRoute, async (c) => {
    const caller = c.var.identity;
    const who = await admin(caller);
    if (!(await keys().remove(who.orgId, caller.userId))) {
      throw new ProblemError(404, 'not-found', 'No OpenRouteService key is stored', {
        code: 'not_configured',
      });
    }
    return c.body(null, 204);
  });
}
