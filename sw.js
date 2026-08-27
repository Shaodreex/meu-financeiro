const CACHE = 'meu-financeiro-v21-pwa-iosfix';
const VERSION = '282';
const CORE = [
  './',
  './index.html',
  `./styles.css?v=${VERSION}`,
  `./app.js?v=${VERSION}`,
  `./supabase-config.js?v=${VERSION}`,
  `./manifest.webmanifest?v=${VERSION}`,
  './assets/icon.svg',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (_) {}
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);

  // Nunca intercepte CDN/Supabase/outros domínios. No iPhone isso evita que
  // bibliotecas e chamadas externas fiquem presas em caches antigos do PWA.
  if (url.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const preload = await event.preloadResponse;
        const response = preload || await fetch(event.request, { cache: 'no-store' });
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          cache.put('./index.html', response.clone()).catch(() => {});
        }
        return response;
      } catch (_) {
        return (await caches.match('./index.html')) || Response.error();
      }
    })());
    return;
  }

  const isCore = /\/(index\.html|app\.js|supabase-config\.js|styles\.css|manifest\.webmanifest)$/.test(url.pathname);
  if (isCore) {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { cache: 'no-store' });
        if (response && response.ok) {
          const cache = await caches.open(CACHE);
          cache.put(event.request, response.clone()).catch(() => {});
        }
        return response;
      } catch (_) {
        return (await caches.match(event.request)) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response && response.ok) {
        const cache = await caches.open(CACHE);
        cache.put(event.request, response.clone()).catch(() => {});
      }
      return response;
    } catch (_) {
      return Response.error();
    }
  })());
});
