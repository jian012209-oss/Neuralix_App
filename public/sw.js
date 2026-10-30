// Neuralix app service worker.
// Neuralix needs the internet for every answer, so nothing is cached for offline use and /api is never touched.
// Its one job: when a page can't load because the phone is offline, show a branded "You're offline" screen
// instead of the browser's error page.
const VERSION = "neuralix-app-1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || req.mode !== "navigate") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(fetch(req).catch(() => offlinePage()));
});

function offlinePage() {
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#07040F"><title>Neuralix AI · Offline</title>
<style>
  :root{color-scheme:dark}
  html,body{height:100%;margin:0}
  body{display:grid;place-items:center;padding:24px;box-sizing:border-box;text-align:center;color:#F4F0FF;
    font:400 15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;
    background:radial-gradient(70% 55% at 50% 0%,rgba(109,40,217,.4),transparent 70%),#07040F}
  .orb{width:84px;height:84px;margin:0 auto 22px;border-radius:50%;
    background:radial-gradient(circle at 34% 28%,#F5F3FF 0,#C4B5FD 13%,#8B5CF6 38%,#5B21B6 63%,#1A0A33 100%);
    box-shadow:0 0 60px rgba(139,92,246,.55),0 0 120px rgba(217,70,239,.25);filter:saturate(.55) brightness(.85)}
  h1{margin:0 0 8px;font:600 26px/1.2 system-ui,sans-serif;letter-spacing:-.02em}
  p{margin:0 auto 22px;max-width:34ch;color:#BDB2DE}
  a{display:inline-block;padding:12px 26px;border-radius:999px;color:#fff;text-decoration:none;font-weight:600;
    background:linear-gradient(90deg,#6D28D9,#8B5CF6 55%,#A855F7);box-shadow:0 10px 30px -10px rgba(139,92,246,.9)}
</style></head>
<body><main>
  <div class="orb" aria-hidden="true"></div>
  <h1>You're offline</h1>
  <p>Neuralix needs the internet to answer you. Check your Wi-Fi or mobile data, then try again.</p>
  <a href="/">Try again</a>
</main>
<script>addEventListener("online", () => location.reload());</script>
</body></html>`;
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}
