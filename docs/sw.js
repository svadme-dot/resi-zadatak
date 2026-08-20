const CACHE_NAME = "matematika-pwa-v7";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./app-v5/part-0.txt?v=6",
  "./app-v5/part-1.txt?v=6",
  "./app-v5/part-2.txt?v=6",
  "./app-v5/part-3.txt?v=6",
  "./app-v5/part-4.txt?v=6",
  "./app-v5/part-5a.txt?v=6",
  "./app-v5/part-5b.txt?v=6",
  "./app-v5/part-6.txt?v=6",
  "./app-v5/part-7.txt?v=6"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(key => key.startsWith("matematika-pwa-") && key !== CACHE_NAME)
        .map(key => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // OmniVoice has its own app shell and service worker under this subfolder.
  // The mathematics PWA must not intercept or delete its cached files.
  if (url.origin === self.location.origin && url.pathname.startsWith("/resi-zadatak/omnivoice/")) return;
  if (url.hostname.includes("googleapis.com") || url.hostname.includes("ai.google.dev")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response && response.ok && url.origin === self.location.origin) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
      }
      return response;
    }))
  );
});

