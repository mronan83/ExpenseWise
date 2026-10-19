'use client';

import { api } from './api';

/*
 * Push notifications in the browser (FR-PLT-12, ADR-0053): the service worker that shows them
 * (public/sw.js) and this device's subscription, which the server sends to through the push
 * service. On an iPhone, only the app opened from the Home Screen can get them (iOS 16.4 on).
 */

/** The kinds a person switches, as the API answers them. */
export interface NotificationKindSetting {
  kind: string;
  label: string;
  on: boolean;
}

export interface NotificationSettings {
  /** The server's VAPID key; null when it can't send. */
  publicKey: string | null;
  devices: number;
  kinds: NotificationKindSetting[];
}

/** Whether this browser can get notifications, or what it takes. */
export type PushAvailability = 'ready' | 'add_to_home_screen' | 'unsupported';

export function pushAvailability(): PushAvailability {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
    return 'ready';
  }
  // Safari on an iPhone or iPad offers push only to the app added to the Home Screen.
  const apple =
    /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return apple ? 'add_to_home_screen' : 'unsupported';
}

const keyBytes = (base64url: string) => {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Whether a subscription was made with this server key, so pushes signed with it arrive. */
function madeWith(subscription: PushSubscription, publicKey: string): boolean {
  const key = subscription.options.applicationServerKey;
  if (!key) return true;
  const ours = keyBytes(publicKey);
  const theirs = new Uint8Array(key);
  return theirs.length === ours.length && theirs.every((b, i) => b === ours[i]);
}

/** What the API keeps of a subscription, with this device's time zone for the reminder. */
function bodyOf(subscription: PushSubscription) {
  const json = subscription.toJSON();
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

/**
 * This device's subscription with the server's key, renewed with the server so it knows the
 * device's keys and time zone. One made with an older key, as after the server's secret
 * changes, is replaced. Null when notifications aren't allowed here.
 */
export async function renewThisDevice(publicKey: string): Promise<PushSubscription | null> {
  if (Notification.permission !== 'granted') return null;
  const found = await (
    await navigator.serviceWorker.getRegistration('/')
  )?.pushManager
    .getSubscription()
    .catch(() => null);
  if (!found) return null;
  let subscription = found;
  if (!madeWith(found, publicKey)) {
    await found.unsubscribe();
    subscription = await (
      await registration()
    ).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  }
  await api('/v1/me/push-subscriptions', {
    method: 'POST',
    body: JSON.stringify(bodyOf(subscription)),
  });
  return subscription;
}

/**
 * Asks to allow notifications on this device and subscribes it. Called straight from a tap:
 * Safari asks only then. 'denied' when the person said no, now or before.
 */
export async function allowOnThisDevice(publicKey: string): Promise<'allowed' | 'denied'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const worker = await registration();
  const existing = await worker.pushManager.getSubscription();
  if (existing && !madeWith(existing, publicKey)) await existing.unsubscribe();
  const subscription =
    existing && madeWith(existing, publicKey)
      ? existing
      : await worker.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: keyBytes(publicKey),
        });
  await api('/v1/me/push-subscriptions', {
    method: 'POST',
    body: JSON.stringify(bodyOf(subscription)),
  });
  return 'allowed';
}

/** Stops notifications on this device, here and on the server. */
export async function stopOnThisDevice(): Promise<void> {
  const subscription = await (
    await navigator.serviceWorker.getRegistration('/')
  )?.pushManager.getSubscription();
  if (!subscription) return;
  await api('/v1/me/push-subscriptions/remove', {
    method: 'POST',
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
}
