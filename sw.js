const CACHE_NAME = 'smash-signup-v12';

self.addEventListener('install', function () {
  // Do not skipWaiting(). The sign-up page used to reload on activate, so
  // taking over immediately would keep those cached pages refreshing.
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(names.filter(function (name) {
        return name !== CACHE_NAME;
      }).map(function (name) {
        return caches.delete(name);
      }));
    })
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (err) { return; }

  // Same-origin pages and assets only. Intercepting Google auth, the
  // worker script, or cross-origin APIs can strand a visit in a reload loop.
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js' || url.pathname.endsWith('/sw.js')) return;

  event.respondWith(
    fetch(request).then(function (response) {
      if (response && response.status === 200 && response.type === 'basic') {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          return cache.put(request, copy);
        }).catch(function () {});
      }
      return response;
    }).catch(function () {
      return caches.match(request).then(function (cached) {
        return cached || new Response('Offline - no cached version available', {
          status: 503,
          statusText: 'Service Unavailable'
        });
      });
    })
  );
});
