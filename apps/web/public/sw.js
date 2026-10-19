/*
 * The app's service worker (FR-PLT-12, ADR-0053): it shows each push notification and opens
 * what it is about when tapped. It caches nothing, so every screen still comes fresh from the
 * server. A push says what and where, never an amount; whatever it carries, it opens only a
 * path in the app.
 */

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/** A path in the app, or Home: never another site. */
const inApp = (url) =>
  typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';

self.addEventListener('push', (event) => {
  let message = {};
  try {
    message = event.data ? event.data.json() : {};
  } catch {
    message = {};
  }
  const title =
    typeof message.title === 'string' && message.title !== '' ? message.title : 'ExpenseWise';
  // Every push shows a notification: Safari stops sending to one that doesn't.
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof message.body === 'string' ? message.body : '',
      tag: typeof message.tag === 'string' ? message.tag : 'expensewise',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: inApp(message.url) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(inApp(event.notification.data?.url), self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open) {
        await open.focus();
        return open.navigate(url);
      }
      return self.clients.openWindow(url);
    })(),
  );
});
