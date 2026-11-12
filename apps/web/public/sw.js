const CACHE_NAME = "kazios-v1";
const STATIC_ASSETS = [
  "/",
  "/pos",
  "/dashboard",
  "/closing",
  "/stocktake",
  "/stock/receive",
  "/inventory",
  "/products",
  "/customers",
  "/expenses",
  "/settings",
  "/manifest.json",
  "/logo.png",
  "/logo2.png",
];

// Install event: cache static assets
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate event: clean up old caches
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames.filter(name => name !== CACHE_NAME).map(name => caches.delete(name))
      )
    )
  );
  self.clients.claim();
});

// Fetch event: serve from cache, fallback to network
self.addEventListener("fetch", event => {
  const request = event.request;

  // For API calls, try network first, then cache
  if (request.url.includes("/api/")) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // For navigation requests, serve cached page or offline fallback
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(() => caches.match(request)).catch(() => caches.match("/"))
    );
    return;
  }

  // For all other assets, cache first then network
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, responseClone));
        return response;
      }).catch(() => {
        // Offline fallback for images
        if (request.destination === "image") {
          return new Response("", { status: 204 });
        }
      });
    })
  );
});

// Listen for messages from the client (e.g., online status)
self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
