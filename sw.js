/* Pokémon Splendor — service worker (offline app shell + runtime card-image cache) */
const VER = 'ps-cache-v2';
const SHELL = [
  './', './index.html', './css/style.css',
  './js/cards.js', './js/megas.js', './js/engine.js', './js/ai.js', './js/azai.js', './js/ui.js',
  './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VER).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VER).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Strategy: the app shell (html/css/js/json) is NETWORK-FIRST so code updates reach
// players immediately when online, falling back to cache offline. Card images and other
// assets are CACHE-FIRST (immutable) and cached on first view for full offline play.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== location.origin) return;
  const isShell = req.mode === 'navigate' || /\.(html|css|js|json)$/.test(url.pathname);
  if (isShell) {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(VER).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => caches.match(req).then((hit) => hit || caches.match('./index.html')))
    );
  } else {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VER).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
