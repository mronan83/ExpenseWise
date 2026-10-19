import {
  addPushSubscription,
  notificationSettings,
  removePushSubscription,
  requestTestNotification,
  setNotificationKind,
  type CommittedEvent,
  type Database,
  type NotificationSettings,
} from '@expensewise/db';
import type { NotificationKind, PushSubscriptionInput } from '@expensewise/domain';
import { asCaller } from './caller.ts';

/**
 * What the API needs from the database for push notifications (FR-PLT-12, ADR-0053): a
 * member's kinds and devices, and a test. Every change is audited in its own transaction.
 * Tests use a fake.
 */
export interface NotificationStore {
  settings(orgId: string, memberId: string): Promise<NotificationSettings>;
  setKind(
    orgId: string,
    memberId: string,
    kind: Exclude<NotificationKind, 'test'>,
    on: boolean,
    actorUserId: string,
  ): Promise<NotificationSettings>;
  /** Keeps a device's subscription, checked by checkPushSubscription(). */
  addDevice(
    orgId: string,
    memberId: string,
    subscription: PushSubscriptionInput & { readonly timeZone: string | null },
    actorUserId: string,
  ): Promise<'added' | 'renewed'>;
  removeDevice(
    orgId: string,
    memberId: string,
    endpoint: string,
    actorUserId: string,
  ): Promise<boolean>;
  test(
    orgId: string,
    memberId: string,
    actorUserId: string,
  ): Promise<{ status: 'requested'; event: CommittedEvent } | { status: 'no_devices' }>;
}

/** Notifications on Postgres, as expensewise_app and as the caller, who sees only their own. */
export function dbNotificationStore(db: Database): NotificationStore {
  const inOrg = asCaller(db);
  return {
    settings: (orgId, memberId) => inOrg(orgId, (tx) => notificationSettings(tx, memberId)),
    setKind: (orgId, memberId, kind, on, actorUserId) =>
      inOrg(orgId, async (tx) => {
        await setNotificationKind(tx, orgId, memberId, kind, on, actorUserId);
        return notificationSettings(tx, memberId);
      }),
    addDevice: (orgId, memberId, subscription, actorUserId) =>
      inOrg(orgId, (tx) => addPushSubscription(tx, orgId, memberId, subscription, actorUserId)),
    removeDevice: (orgId, memberId, endpoint, actorUserId) =>
      inOrg(orgId, (tx) => removePushSubscription(tx, orgId, memberId, endpoint, actorUserId)),
    test: (orgId, memberId, actorUserId) =>
      inOrg(orgId, (tx) => requestTestNotification(tx, orgId, memberId, actorUserId)),
  };
}
