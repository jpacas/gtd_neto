const CACHE_NAME = 'gtd-neto-v2';
const STATIC_ASSETS = [
  '/',
  '/public/css/styles.css',
  '/public/js/toast.js',
  '/public/js/utils.js',
  '/public/js/theme.js',
  '/public/js/tags.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  if (!isSameOrigin) return;

  const isNavigation = event.request.mode === 'navigate' || event.request.destination === 'document';
  const isStaticAsset = url.pathname.startsWith('/public/');
  const isDataRoute = url.pathname.startsWith('/api/') || url.pathname === '/import';

  if (isNavigation || isDataRoute) {
    // Network-first for HTML/data to keep content fresh.
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  if (isStaticAsset) {
    // Stale-while-revalidate for static assets.
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const networkFetch = fetch(event.request)
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
            return response;
          })
          .catch(() => cached);

        return cached || networkFetch;
      })
    );
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});
