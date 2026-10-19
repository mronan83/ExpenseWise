import { CHOSEN_KINDS, NOTIFICATION_KIND_LABELS } from '@expensewise/domain';
import { z } from '@hono/zod-openapi';

/*
 * Push notifications (FR-PLT-12, ADR-0053), behind `notifications.push`: the kinds a person
 * switches, the devices they allow, and a test.
 */

const kinds = CHOSEN_KINDS as unknown as [string, ...string[]];

export const NotificationSettingsSchema = z
  .object({
    publicKey: z
      .string()
      .nullable()
      .openapi({
        description:
          'The server’s VAPID public key (base64url), which a browser subscribes with; null when ' +
          'this server can’t send pushes.',
      }),
    devices: z.number().int().openapi({
      example: 1,
      description: 'How many of the caller’s devices are allowed to get notifications.',
    }),
    kinds: z
      .array(
        z.object({
          kind: z.enum(kinds).openapi({ example: 'receipts' }),
          label: z.string().openapi({ example: NOTIFICATION_KIND_LABELS.receipts }),
          on: z.boolean(),
        }),
      )
      .openapi({ description: 'Each kind the caller switches, in the order Settings shows them.' }),
  })
  .openapi('NotificationSettings');

export const NotificationKindParamSchema = z.object({
  kind: z.enum(kinds).openapi({ param: { name: 'kind', in: 'path' }, example: 'receipts' }),
});

export const SetNotificationKindSchema = z
  .object({ on: z.boolean().openapi({ example: false }) })
  .strict()
  .openapi('SetNotificationKind');

export const PushSubscriptionSchema = z
  .object({
    endpoint: z
      .string()
      .max(1024)
      .openapi({
        example: 'https://web.push.apple.com/QGuQ2sp',
        description:
          'The browser’s push address, at Apple’s push service or another browser’s: any other ' +
          'address is refused, as the server sends to it.',
      }),
    keys: z
      .object({
        p256dh: z.string().max(100).openapi({ description: 'P-256 public key, base64url.' }),
        auth: z.string().max(40).openapi({ description: 'Authentication secret, base64url.' }),
      })
      .strict(),
    timeZone: z.string().max(64).nullish().openapi({
      example: 'America/Chicago',
      description: 'The device’s time zone, for the morning reminder of a report to submit.',
    }),
  })
  .strict()
  .openapi('PushSubscription');

export const RemovePushSubscriptionSchema = z
  .object({ endpoint: z.string().max(1024) })
  .strict()
  .openapi('RemovePushSubscription');

export const PushDeviceAddedSchema = z
  .object({
    status: z.enum(['added', 'renewed']),
    devices: z.number().int(),
  })
  .openapi('PushDeviceAdded');

export const TestNotificationSchema = z
  .object({ status: z.literal('requested') })
  .openapi('TestNotification');
