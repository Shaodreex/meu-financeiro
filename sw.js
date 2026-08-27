// Meu Financeiro v2.8.4 — Service Worker desativado intencionalmente.
// A aplicação não registra mais Service Worker para priorizar estabilidade no Safari/iOS.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    try {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (key) { return caches.delete(key); }));
    } catch (_) {}
    try { await self.registration.unregister(); } catch (_) {}
  })());
});
