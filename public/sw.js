const CACHE_NAME_PREFIX = "pesowise-";
const CACHE_VERSION = "pesowise-v13";
// The web app manifest is deliberately NOT precached. It is host-specific (apex vs
// tenant branding, id and start_url), so a cached copy could describe the wrong app.
// It is fetched from the network on every request instead — see the fetch handler.
const APP_SHELL = [
  "/index.html",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/icon-maskable-512.png",
];

const OFFLINE_HTML =
  "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>PesoWise</title></head>" +
  "<body><p>You are offline. Reconnect and refresh to continue.</p></body></html>";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        cache.addAll(APP_SHELL).catch((err) => {
          console.warn("SW precache partial failure:", err);
        }),
      ),
    // skipWaiting() removed: taking over mid-session serves a different asset
    // set than the page loaded with (stale dynamic-import chunks → forced reload).
    // The updated SW takes over on the next natural full load instead.
  );
});

self.addEventListener("activate", (event) => {
  // Purge old caches, but do NOT clients.claim(): claiming takes control of already-open tabs
  // mid-session, which can serve a different asset set than the page was loaded with (stale
  // dynamic-import chunks → navigation that needs a manual refresh). The new SW takes over on
  // the next full load instead, keeping the current session's chunks consistent.
  // Only PesoWise-owned cache names are removed; anything else on this origin is
  // left untouched.
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith(CACHE_NAME_PREFIX) && k !== CACHE_VERSION)
            .map((k) => caches.delete(k)),
        ),
      ),
  );
});

function isNavigationRequest(request) {
  return (
    request.mode === "navigate" ||
    request.destination === "document" ||
    (request.method === "GET" && request.headers.get("accept")?.includes("text/html"))
  );
}

function shouldBypassCache(url) {
  const path = url.pathname;
  return (
    path.startsWith("/api/") ||
    path.startsWith("/assets/") ||
    path.includes("/rest/") ||
    path.includes("supabase")
  );
}

/** Vite SPA routes (no file extension) — network-first with guaranteed Response fallback. */
function isSpaClientRoute(pathname) {
  if (!pathname || pathname === "/") return false;
  const last = pathname.split("/").filter(Boolean).pop() || "";
  return !last.includes(".");
}

function offlineDocumentResponse() {
  return caches.match("/index.html").then((cached) => {
    if (cached) return cached;
    return new Response(OFFLINE_HTML, {
      status: 503,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  });
}

/** Always returns a valid Response — never undefined. */
function networkFirstDocument(request) {
  return fetch(request)
    .then((response) => {
      if (response.ok && response.headers.get("content-type")?.includes("text/html")) {
        const copy = response.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put("/index.html", copy));
      }
      return response;
    })
    .catch(() => offlineDocumentResponse());
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const reqUrl = new URL(request.url);
  if (reqUrl.origin !== self.location.origin) return;
  if (shouldBypassCache(reqUrl)) return;

  // Web app manifest: always straight to the network, never cached and never
  // substituted. The response differs per host (apex vs each tenant) and serving a
  // stored copy could give this origin another host's app identity, name and
  // start_url. Not calling respondWith lets the browser handle it natively.
  if (reqUrl.pathname.endsWith(".webmanifest") || reqUrl.pathname.includes("/api/manifest")) {
    return;
  }

  if (isNavigationRequest(request) || isSpaClientRoute(reqUrl.pathname)) {
    event.respondWith(networkFirstDocument(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (!response.ok) return response;
          const type = response.headers.get("content-type") || "";
          if (type.includes("text/html") && reqUrl.pathname.endsWith(".js")) {
            return response;
          }
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          new Response("", {
            status: 504,
            statusText: "Gateway Timeout",
          }),
        );
    }),
  );
});
