// Bump this number whenever you want to force every device to drop its old cached files.
const cacheName = 'nota-rohya-cache-v3';
// Relative paths (not "/...") so this works whether the site lives at the top of an address
// (nota-rohya.github.io) or under a folder (username.github.io/nota-rohya/).
const assetsToCache = [
  './',
  './index.html',
  './styles-main.css',
  './script.js',
  './pray-logo.png'
];

self.addEventListener('install', event => {
  self.skipWaiting(); // activate the new worker right away instead of waiting for all tabs to close
  event.waitUntil(
    caches.open(cacheName).then(cache => cache.addAll(assetsToCache))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      // delete every cache from older versions (e.g. nota-rohya-cache-v1)
      .then(keys => Promise.all(keys.filter(k => k !== cacheName).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, cache as the offline fallback.
// The old version answered from the cache first and never refreshed it, so after you edited
// the CSS/JS, phones that had visited before kept showing the old files.
self.addEventListener('fetch', event => {
  const req = event.request;
  // Only handle same-site GET requests; let Firebase, Google Fonts, etc. go straight to the network.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(cacheName).then(cache => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
