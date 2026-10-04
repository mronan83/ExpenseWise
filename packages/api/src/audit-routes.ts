import type { AuditActorName, AuditFilter, Membership } from '@expensewise/db';
import { canReadAuditTrail, type ChainedAuditEvent } from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { AUDIT_PAGE_MAX, AUDIT_PAGE_SIZE, type AuditStore } from './audit.ts';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import { ProblemError } from './problem.ts';
import { listAuditEventsRoute, verifyAuditChainRoute } from './routes/audit.ts';
import type { WorkspaceStore } from './workspace.ts';

export interface AuditRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly audit?: AuditStore;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
  readonly now?: () => Date;
}

const FLAG = 'governance.audit-trail';

function eventView(event: ChainedAuditEvent, names: ReadonlyMap<string, AuditActorName>) {
  const person = event.actor.type === 'user' && event.actor.id ? names.get(event.actor.id) : null;
  return {
    sequence: event.sequence,
    occurredAt: event.occurredAt,
    actor: {
      type: event.actor.type,
      id: event.actor.id,
      name: person?.name ?? null,
      email: person?.email ?? null,
    },
    entityType: event.entityType,
    entityId: event.entityId,
    action: event.action,
    payload: event.payload as Record<string, unknown>,
    hash: event.hash,
    prevHash: event.prevHash,
  };
}

const invalid = (detail: string) =>
  new ProblemError(400, 'invalid-request', 'The request is not valid', {
    code: 'invalid_request',
    detail,
  });

/**
 * The audit trail (FR-GOV-06, F-20): every record's history for owners, finance admins and
 * auditors, and the hash chain recomputed on request. Behind `governance.audit-trail`.
 */
export function registerAuditRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: AuditRouteOptions,
) {
  const now = options.now ?? (() => new Date());
  const features = options.features ?? featureGate(options);
  const auth = requireIdentity(options.verifyToken);
  for (const route of [listAuditEventsRoute, verifyAuditChainRoute]) {
    app.use(route.getRoutingPath(), auth);
  }

  const stores = () => {
    if (!options.workspace || !options.audit) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, audit: options.audit };
  };

  /** The caller's membership, once the trail is on and their role may read it. */
  const reader = async (userId: string): Promise<Membership> => {
    const who = await stores().workspace.findMembership(userId);
    if (!who) {
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
    await features.require(who.orgId, FLAG);
    if (!canReadAuditTrail(who.role)) {
      throw new ProblemError(
        403,
        'forbidden',
        'Only an owner, finance admin or auditor can read the audit trail',
        { code: 'forbidden_role' },
      );
    }
    return who;
  };

  app.openapi(listAuditEventsRoute, async (c) => {
    const who = await reader(c.var.identity.userId);
    const query = c.req.valid('query');
    const limit = query.limit === undefined ? AUDIT_PAGE_SIZE : Number(query.limit);
    if (limit < 1 || limit > AUDIT_PAGE_MAX) {
      throw invalid(`limit: A number from 1 to ${AUDIT_PAGE_MAX}.`);
    }
    const filter: AuditFilter = {
      ...(query.entityType === undefined ? {} : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...(query.actorId === undefined ? {} : { actorId: query.actorId }),
      ...(query.cursor === undefined ? {} : { before: Number(query.cursor) }),
    };
    // One more than the page, to know whether another follows.
    const { events, actors } = await stores().audit.page(who.orgId, filter, limit + 1);
    const shown = events.slice(0, limit);
    const names = new Map(actors.map((a) => [a.userId, a]));
    const last = shown.at(-1);
    return c.json(
      {
        events: shown.map((e) => eventView(e, names)),
        nextCursor: events.length > limit && last ? String(last.sequence) : null,
      },
      200,
    );
  });

  app.openapi(verifyAuditChainRoute, async (c) => {
    const who = await reader(c.var.identity.userId);
    const result = await stores().audit.verify(who.orgId);
    c.header('Cache-Control', 'no-store');
    const broken = result.brokenAt;
    return c.json(
      {
        intact: result.intact,
        checked: result.checked,
        total: result.total,
        brokenAt: broken
          ? {
              sequence: broken.sequence,
              occurredAt: broken.occurredAt,
              entityType: broken.entityType,
              entityId: broken.entityId,
              action: broken.action,
            }
          : null,
        checkedAt: now().toISOString(),
      },
      200,
    );
  });
}
