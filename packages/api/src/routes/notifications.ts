import { createRoute } from '@hono/zod-openapi';
import {
  NotificationKindParamSchema,
  NotificationSettingsSchema,
  PushDeviceAddedSchema,
  PushSubscriptionSchema,
  RemovePushSubscriptionSchema,
  SetNotificationKindSchema,
  TestNotificationSchema,
} from '../notification-schemas.ts';
import { ProblemSchema } from '../schemas.ts';

const problem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ProblemSchema } },
});

const secured = { security: [{ bearerAuth: [] }] };

const common = {
  401: problem('Sign in required.'),
  403: problem('The caller has no organization yet: call POST /v1/me/organization first.'),
  404: problem('Notifications are not switched on (`feature_off`).'),
  503: problem('Sign-in or the database is not configured on this server.'),
};

const settings = {
  description: 'The caller’s notification settings.',
  content: { 'application/json': { schema: NotificationSettingsSchema } },
};

export const getNotificationsRoute = createRoute({
  method: 'get',
  path: '/v1/me/notifications',
  tags: ['Notifications'],
  summary: 'The caller’s notification settings',
  description:
    'Each kind they switch, how many of their devices are allowed, and the key a browser ' +
    'subscribes with (FR-PLT-12). A kind no one switched is on.',
  ...secured,
  responses: { 200: settings, ...common },
});

export const setNotificationKindRoute = createRoute({
  method: 'put',
  path: '/v1/me/notifications/{kind}',
  tags: ['Notifications'],
  summary: 'Switch one kind of notification on or off for the caller',
  description: 'A kind switched off is never sent to them; audited.',
  ...secured,
  request: {
    params: NotificationKindParamSchema,
    body: { content: { 'application/json': { schema: SetNotificationKindSchema } } },
  },
  responses: { 200: settings, 400: problem('Not a kind a person switches.'), ...common },
});

export const addPushSubscriptionRoute = createRoute({
  method: 'post',
  path: '/v1/me/push-subscriptions',
  tags: ['Notifications'],
  summary: 'Allow notifications on one of the caller’s devices',
  description:
    'Keeps the browser’s push subscription, or renews its keys (ADR-0053). Up to ten devices ' +
    'a person; past that, the oldest goes. The audit trail names the push service, never the ' +
    'address.',
  ...secured,
  request: { body: { content: { 'application/json': { schema: PushSubscriptionSchema } } } },
  responses: {
    200: {
      description: 'The device was allowed already; its keys are renewed.',
      content: { 'application/json': { schema: PushDeviceAddedSchema } },
    },
    201: {
      description: 'The device is allowed.',
      content: { 'application/json': { schema: PushDeviceAddedSchema } },
    },
    400: problem(
      'Not at a push service (`not_a_push_service`), or keys of the wrong length (`bad_push_keys`).',
    ),
    ...common,
  },
});

export const removePushSubscriptionRoute = createRoute({
  method: 'post',
  path: '/v1/me/push-subscriptions/remove',
  tags: ['Notifications'],
  summary: 'Stop notifications on one of the caller’s devices',
  description: 'Removes its subscription; audited. Nothing to remove still answers 204.',
  ...secured,
  request: {
    body: { content: { 'application/json': { schema: RemovePushSubscriptionSchema } } },
  },
  responses: { 204: { description: 'It gets no more notifications.' }, ...common },
});

export const testNotificationRoute = createRoute({
  method: 'post',
  path: '/v1/me/notifications/test',
  tags: ['Notifications'],
  summary: 'Send the caller a test notification',
  description:
    'Sent by the workflow to each of their devices within seconds, never from this request.',
  ...secured,
  responses: {
    202: {
      description: 'It is on its way.',
      content: { 'application/json': { schema: TestNotificationSchema } },
    },
    409: problem('None of the caller’s devices is allowed yet (`no_devices`).'),
    ...common,
  },
});
