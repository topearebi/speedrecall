/**
 * sw.js - SpeedRecall Service Worker
 * Strategy: Cache-first for App Shell, Network-first for Data files
 */

const CACHE_NAME = 'speedrecall-shell-v2.1';
const DATA_CACHE_NAME = 'speedrecall-data-v2.1';

const APP_SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/tokens.css',
  './css/base.css',
  './css/drawer.css',
  './css/stage.css',
  './js/app.js',
  './js/engine.js',
  './js/state.js',
  './js/normalizer.js',
  './js/importer.js',
  './js/tv-nav.js',
  './js/github-sync.js'
];

// Install: Pre-cache App Shell and bypass waiting state
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: Prune outdated caches and take immediate control of clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== DATA_CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

// Fetch: Differentiated routing based on request target
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Data endpoints: Network-First with Cache Fallback
  // Allows new deck additions and edits to reflect dynamically while keeping offline capability
  if (url.pathname.includes('/data/')) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(DATA_CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request);
        })
    );
    return;
  }

  // 2. App Shell and Static Assets: Cache-First with Network Fallback
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(event.request).then((networkResponse) => {
        if (
          !networkResponse ||
          networkResponse.status !== 200 ||
          networkResponse.type !== 'basic'
        ) {
          return networkResponse;
        }

        const clone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, clone);
        });
        return networkResponse;
      });
    })
  );
});
