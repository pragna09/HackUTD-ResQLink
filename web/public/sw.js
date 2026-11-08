// Minimal service worker. Android Chrome only shows notifications through a service worker
// (registration.showNotification); tapping one brings the phone app page to the front.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/app';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      const open = list.find(c => new URL(c.url).pathname === url);
      return open ? open.focus() : self.clients.openWindow(url);
    })
  );
});
