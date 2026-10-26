// Offline support. Pages: network first, then cache. Data and fonts: cache first.
const VERSION = 'ql-v1';
const SCOPE = self.registration.scope;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll([SCOPE, SCOPE + 'data/meta.json'])).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isData = url.href.startsWith(SCOPE + 'data/') || url.host.endsWith('fonts.gstatic.com') || url.host.endsWith('fonts.googleapis.com');
  if (url.host.endsWith('everyayah.com')) return; // audio streams straight from the CDN
  if (isData) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') caches.open(VERSION).then((c) => c.put(req, res.clone()));
      return res;
    })));
  } else if (url.href.startsWith(SCOPE)) {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((hit) => hit || caches.match(SCOPE))));
  }
});
