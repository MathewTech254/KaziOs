const CACHE_NAME = "kazios-v2";
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>KaziOS · Offline</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        background: #07152d;
        color: #e8eefc;
        padding: 1.5rem;
        text-align: center;
      }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { margin: 0; opacity: 0.7; font-size: 0.9rem; }
    </style>
  </head>
  <body>
    <div>
      <h1>You are offline</h1>
      <p>KaziOS cannot reach the server. Reconnect and reload.</p>
    </div>
  </body>
</html>`;

/**
 * Precache only paths that exist as real files. Every other route is an SPA fallback
 * served by the host, so it is not a separate asset and must not be precached.
 */
const PRECACHE = ["/", "/manifest.json", "/logo.png", "/logo2.png"];

/**
 * install
 *
 * Each asset is added on its own and a failure is tolerated. `cache.addAll` is
 * all-or-nothing: one 404 rejects the whole install, the SW never activates, and the
 * cache stays empty, which is how a broken worker survives a deploy.
 */
self.addEventListener("install", event => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(cache => Promise.allSettled(PRECACHE.map(url => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

// activate: drop every older cache so a fixed worker replaces the broken one.
self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(names =>
        Promise.all(names.filter(name => name !== CACHE_NAME).map(name => caches.delete(name)))
      )
      .then(() => self.clients.claim())
  );
});

/**
 * Offline page for a navigation. Always resolves to a Response, never undefined.
 */
function offlinePage() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

/**
 * Navigate: network first, then a cached copy of this URL, then the cached shell, then
 * the offline page.
 *
 * `caches.match` resolves to `undefined` when nothing matches, so each step falls
 * through explicitly. Returning `undefined` from `respondWith` is what produced
 * "Failed to convert value to 'Response'".
 */
function handleNavigation(request) {
  return fetch(request)
    .catch(() => caches.match(request))
    .then(response => response || caches.match("/"))
    .then(response => response || offlinePage());
}

/**
 * Asset: cache first, then network, caching a clean copy for next time.
 */
function handleAsset(request) {
  return caches.match(request).then(cached => {
    if (cached) return cached;

    return fetch(request)
      .then(response => {
        if (response && response.ok && response.status === 200 && response.type !== "opaque") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => Response.error());
  });
}

/**
 * API: network only.
 *
 * Authenticated JSON is never written to the cache, so a signed-in till cannot read
 * another user's data out of a shared device's Cache Storage. When the network is
 * down the caller gets a real 503 it can act on, rather than `undefined`.
 */
function handleApi(request) {
  return fetch(request).catch(() =>
    new Response(JSON.stringify({ error: "API unavailable" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    })
  );
}

self.addEventListener("fetch", event => {
  const request = event.request;

  // Only GET is intercepted. A POST has no cache entry to match, and `cache.put` on a
  // non-GET request rejects, which would surface as an unhandled rejection here.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // The API is a separate deployment, so match the path rather than the origin.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(handleApi(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  event.respondWith(handleAsset(request));
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});