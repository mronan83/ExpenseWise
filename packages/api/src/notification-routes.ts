import type { CommittedEvent, NotificationSettings } from '@expensewise/db';
import { checkPushSubscription, NOTIFICATION_KIND_LABELS } from '@expensewise/domain';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { requireIdentity, type AuthVariables, type TokenVerifier } from './auth.ts';
import { featureGate, type FeatureGate } from './features.ts';
import type { NotificationStore } from './notifications.ts';
import { ProblemError } from './problem.ts';
import {
  addPushSubscriptionRoute,
  getNotificationsRoute,
  removePushSubscriptionRoute,
  setNotificationKindRoute,
  testNotificationRoute,
} from './routes/notifications.ts';
import type { WorkspaceStore } from './workspace.ts';

export const NOTIFICATIONS_FLAG = 'notifications.push';

export interface NotificationRouteOptions {
  readonly verifyToken?: TokenVerifier;
  readonly workspace?: WorkspaceStore;
  readonly notifications?: NotificationStore;
  /** The server's VAPID public key; without it, no device can be allowed (503). */
  readonly pushPublicKey?: string;
  /** Which features are on. Built from `workspace` when not given. */
  readonly features?: FeatureGate;
  /** Hands a test to the workflow runner at once; the relay catches a miss. */
  readonly dispatch?: (events: readonly CommittedEvent[]) => Promise<void>;
}

/** Settings › Notifications (FR-PLT-12, ADR-0053): kinds, devices and a test. */
export function registerNotificationRoutes(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  options: NotificationRouteOptions,
) {
  const features = options.features ?? featureGate(options);
  for (const route of [
    getNotificationsRoute,
    setNotificationKindRoute,
    addPushSubscriptionRoute,
    removePushSubscriptionRoute,
    testNotificationRoute,
  ]) {
    app.use(route.getRoutingPath(), requireIdentity(options.verifyToken));
  }

  const stores = () => {
    if (!options.workspace || !options.notifications) {
      throw new ProblemError(
        503,
        'database-not-configured',
        'The database is not configured on this server',
        { code: 'database_not_configured' },
      );
    }
    return { workspace: options.workspace, notifications: options.notifications };
  };
  /** The caller's membership, once notifications are known to be on for their organization. */
  const member = async (userId: string) => {
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
    await features.require(membership.orgId, NOTIFICATIONS_FLAG);
    return membership;
  };
  const view = (s: NotificationSettings) => ({
    publicKey: options.pushPublicKey ?? null,
    devices: s.devices,
    kinds: s.kinds.map((k) => ({ ...k, label: NOTIFICATION_KIND_LABELS[k.kind] })),
  });

  app.openapi(getNotificationsRoute, async (c) => {
    const who = await member(c.var.identity.userId);
    return c.json(view(await stores().notifications.settings(who.orgId, who.memberId)), 200);
  });

  app.openapi(setNotificationKindRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { kind } = c.req.valid('param');
    const { on } = c.req.valid('json');
    const settings = await stores().notifications.setKind(
      who.orgId,
      who.memberId,
      kind as Parameters<NotificationStore['setKind']>[2],
      on,
      caller.userId,
    );
    return c.json(view(settings), 200);
  });

  app.openapi(addPushSubscriptionRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    if (!options.pushPublicKey) {
      throw new ProblemError(503, 'push-not-configured', 'This server can’t send notifications', {
        code: 'push_not_configured',
      });
    }
    const checked = checkPushSubscription(c.req.valid('json'));
    if (!checked.ok) {
      throw checked.problem === 'endpoint'
        ? new ProblemError(400, 'not-a-push-service', 'Not a push service’s address', {
            code: 'not_a_push_service',
            detail: 'Notifications are sent only through Apple’s push service and the browsers’.',
          })
        : new ProblemError(400, 'bad-push-keys', 'The subscription’s keys are not usable', {
            code: 'bad_push_keys',
          });
    }
    const store = stores().notifications;
    const status = await store.addDevice(who.orgId, who.memberId, checked.value, caller.userId);
    const { devices } = await store.settings(who.orgId, who.memberId);
    return c.json({ status, devices }, status === 'added' ? 201 : 200);
  });

  app.openapi(removePushSubscriptionRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const { endpoint } = c.req.valid('json');
    await stores().notifications.removeDevice(who.orgId, who.memberId, endpoint, caller.userId);
    return c.body(null, 204);
  });

  app.openapi(testNotificationRoute, async (c) => {
    const caller = c.var.identity;
    const who = await member(caller.userId);
    const result = await stores().notifications.test(who.orgId, who.memberId, caller.userId);
    if (result.status === 'no_devices') {
      throw new ProblemError(409, 'no-devices', 'No device of yours is allowed yet', {
        code: 'no_devices',
        detail: 'Allow notifications on this device first.',
      });
    }
    if (options.dispatch) {
      try {
        await options.dispatch([result.event]);
      } catch (error) {
        // The request is committed in the outbox; the relay's sweep sends it later.
        console.warn('Handing a test notification to the workflow runner failed', error);
      }
    }
    return c.json({ status: 'requested' as const }, 202);
  });
}
