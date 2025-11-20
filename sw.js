const CACHE_NAME = 'smash-signup-v6'; // Increment version on each deployment

// Install event - activate immediately
self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing v6 with network-first strategy');
  self.skipWaiting(); // Activate immediately
});

// Fetch event - NETWORK FIRST, cache as fallback only
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Clone the response
        const responseToCache = response.clone();
        
        // Only cache successful responses
        if (response.status === 200) {
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        
        return response;
      })
      .catch(() => {
        // Network failed - try cache as fallback (offline support)
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            console.log('Service Worker: Serving from cache (offline):', event.request.url);
            return cachedResponse;
          }
          // No cache available either
          return new Response('Offline - no cached version available', {
            status: 503,
            statusText: 'Service Unavailable'
          });
        });
      })
  );
});

// Activate event - clean up old caches and take control immediately
self.addEventListener('activate', (event) => {
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('Service Worker: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      console.log('Service Worker: Activated v6, taking control of all pages');
      return self.clients.claim(); // Take control of all pages immediately
    })
  );
});
