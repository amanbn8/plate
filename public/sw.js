const CACHE = "plate-shell-v4";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// Never cache API calls — the app's data and AI results always need the live server.
// Everything else of Plate's own is served from the device copy straight away (so the app opens
// instantly, even on a poor connection) while a fresh copy is fetched behind it for next time.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  e.respondWith(caches.open(CACHE).then(async (cache) => {
    const cached = await cache.match(e.request);
    const fresh = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone()).catch(() => {}); // only good copies, never an error page
      return res;
    }).catch(() => null);
    if (cached){ e.waitUntil(fresh); return cached; }
    return (await fresh) || (await cache.match("/")) || Response.error();
  }));
});
