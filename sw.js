/* Breathe Arabic service worker: keeps the app working offline. */
const VERSION = "arvocab-v30";
const FONT_CACHE = "arvocab-fonts";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./config.js",
  "./app.js",
  "./speech.js",
  "./read.html",
  "./read.js",
  "./fsrs.js",
  "./vendor/supabase-js-2.117.2.js",
  "./privacy.html",
  "./terms.html",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-64.png",
  "./icons/logo-mark-160.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("arvocab-v") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req));
    return;
  }
  if (url.origin === self.location.origin) {
    // App code and settings: use the network when it answers quickly, so updates arrive straight away.
    if (/\/(app|config|fsrs|read|speech)\.js$|\/admin\.html$/.test(url.pathname)) { event.respondWith(networkFirstAsset(req)); return; }
    event.respondWith(cacheFirst(req));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    event.respondWith(staleWhileRevalidate(req, FONT_CACHE));
  }
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))
    ]);
    // Store each page under its own address (the start page also as index.html).
    if (res && res.ok) {
      const path = new URL(req.url).pathname;
      const isStart = path.endsWith("/") || path.endsWith("/index.html");
      cache.put(isStart ? "./index.html" : path, res.clone());
    }
    return res;
  } catch (err) {
    const path = new URL(req.url).pathname;
    const isStart = path.endsWith("/") || path.endsWith("/index.html");
    if (!isStart) {
      const page = (await cache.match(path, { ignoreSearch: true })) || (await cache.match(req, { ignoreSearch: true })) ||
        (!path.endsWith(".html") ? await cache.match(path + ".html", { ignoreSearch: true }) : null);
      if (page) return page;
    }
    return (await cache.match("./index.html")) || (await cache.match("./")) || Response.error();
  }
}

async function networkFirstAsset(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))
    ]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    return (await cache.match(req, { ignoreSearch: true })) || Response.error();
  }
}

async function cacheFirst(req) {
  const hit = await caches.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && res.ok) {
    const cache = await caches.open(VERSION);
    cache.put(req, res.clone());
  }
  return res;
}

async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const network = fetch(req)
    .then((res) => {
      if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
      return res;
    })
    .catch(() => hit);
  return hit || network;
}
