// PALmonitor PWA 서비스워커 — 앱 셸만 가볍게 캐시(네트워크 우선).
// 화면 스트림/로그인은 항상 네트워크로 가야 하므로 /ws 와 외부 요청은 건드리지 않음.
const CACHE = "pal-shell-v3";
const SHELL = [
  "./", "./index.html", "./style.css", "./app.js",
  "./manifest.webmanifest", "./icon.svg", "./icon-192.png", "./icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // WebSocket/교차출처/비GET 은 그대로 통과
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname === "/ws") return;
  // 앱 셸: 네트워크 우선, 실패하면 캐시
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request).then((m) => m || caches.match("./index.html")))
  );
});
