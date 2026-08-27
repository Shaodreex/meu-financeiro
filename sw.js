// Meu Financeiro v2.8.3 — Service Worker pass-through
// Mantém a capacidade de instalação da PWA, mas não intercepta nem cacheia
// HTML, CSS, JavaScript ou chamadas de rede. Isso evita cache inconsistente no Safari/iOS.

self.addEventListener('install', event => {
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.filter(k => k.startsWith('meu-financeiro-')).map(k => caches.delete(k)));
    } catch (_) {}
    try { await self.clients.claim(); } catch (_) {}
  })());
});

// Deliberadamente sem listener de fetch.
// O navegador acessa a rede diretamente.
