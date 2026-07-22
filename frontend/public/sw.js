// CryptoFlip Service Worker — conservative version.
// P3-7 / P3-7-fix bugfix: never cache Next.js dynamic chunks, to prevent
// "stale build" 404s when a new deploy ships different chunk hashes.
// API + WebSocket + admin never go through this SW; they need live data.

const CACHE = 'cryptoflip-shell-v2';
const SHELL = ['/', '/game', '/verifier', '/bonus', '/manifest.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Bumping CACHE to v2 + delete any older caches from prior versions.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Never cache API, socket.io, admin, or anything cross-origin
  if (url.pathname.startsWith('/api')) return;
  if (url.pathname.startsWith('/socket.io')) return;
  if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/sysop-')) return;
  if (url.origin !== self.location.origin) return;

  // CRITICAL: never cache Next.js build chunks. The browser's HTTP cache
  // already handles content-hashed filenames correctly (each new build has
  // a different hash, so the browser will fetch the new file). Caching
  // them in the SW would let old builds serve 404 when chunk hashes roll.
  if (url.pathname.startsWith('/_next/')) return;

  // Network-first for HTML pages (so updates land), cache-first for static
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((m) => m || caches.match('/')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
