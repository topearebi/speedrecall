/**
 * sw.js - Dynamic Deck-Aware Service Worker
 * 
 * Strategy:
 *  - Shell Assets: Cache-First (instant launch, minimal I/O)
 *  - Data Endpoints (/data/*): Stale-While-Revalidate (instant offline load + dynamic background caching)
 *  - GitHub REST API: Network-Only (bypasses SW cache completely)
 */

const SHELL_CACHE = "speedrecall-shell-v2";
const DATA_CACHE = "speedrecall-data-v1";

// Core static assets required for the PWA application shell
const APP_SHELL = [
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
  "./assets/icons/icon-192.png",
  "./assets/icons/icon-512.png"
];

// Install Event: Precaches the immutable application shell
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// Activate Event: Purges obsolete shell caches while preserving dynamic data cache
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => {
        return Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== DATA_CACHE)
            .map((key) => caches.delete(key))
        );
      })
      .then(() => self.clients.claim())
  );
});

// Fetch Event: Dispatches requests according to target resource type
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 1. Direct Network Bypass for GitHub REST API requests
  if (url.hostname === "api.github.com") {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. Stale-While-Revalidate for Deck Data & Manifest
  // Automatically caches new JSON files on demand without touching this worker
  if (url.pathname.includes("/data/")) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cachedResponse = await cache.match(event.request);

        const networkFetch = fetch(event.request)
          .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => cachedResponse);

        // Serve cached version immediately if available; fallback to network
        return cachedResponse || networkFetch;
      })
    );
    return;
  }

  // 3. Cache-First with Network Fallback for Application Shell
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        // Cache same-origin GET successes dynamically
        if (
          networkResponse &&
          networkResponse.status === 200 &&
          event.request.method === "GET" &&
          url.origin === self.location.origin
        ) {
          const responseToCache = networkResponse.clone();
          caches.open(SHELL_CACHE).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      });
    })
  );
});
