// Minimal service worker: lets the app be installed and keeps the app shell for a flaky connection.
// Data (/api) and printable pages are never cached, so numbers are always live.
const CACHE = 'kanz-shell-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/js/lib.js', '/js/pages.js', '/js/pos.js', '/vendor/chart.umd.js', '/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api') || /^\/(invoice|creditnote|statement)\//.test(u.pathname)) return;
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; })
    .catch(() => caches.match(e.request).then((m) => m || (e.request.mode === 'navigate' ? caches.match('/') : Response.error()))));
});
