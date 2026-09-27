/**
 * sw.js - SpeedRecall Service Worker
 * Strategy: Cache-first for local static app assets, Network-first for GitHub REST APIs.
 */

const CACHE_NAME = "speedrecall-v3";

// Static application assets required for full offline function
const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/tokens.css",
  "./css/base.css",
  "./css/stage.css",
  "./css/drawer.css",
  "./js/app.js",
  "./js/state.js",
  "./js/engine.js",
  "./js/normalizer.js",
  "./js/importer.js",
  "./js/tv-nav.js",
  "./js/github-sync.js",
  "./data/manifest.json",
  "./data/zh-hsk1.json",
  "./data/fr-verbs.json"
];

// Install Event: Precaches application shell and default datasets
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Activate Event: Purges outdated cache versions (e.g., speedrecall-v1)
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((name) => {
            if (name !== CACHE_NAME) {
              return caches.delete(name);
            }
          })
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch Event: Cache-first for local static files; bypass cache for GitHub API sync requests
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Always route GitHub REST API requests directly to the network
  if (url.hostname === "api.github.com") {
    event.respondWith(fetch(event.request));
    return;
  }

  // Cache-first, network fallback for app assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        // Cache valid same-origin GET responses
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          event.request.method === "GET" &&
          url.origin === self.location.origin
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});
