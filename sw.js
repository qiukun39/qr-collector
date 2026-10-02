/* 离线缓存：stale-while-revalidate，改版只需 bump VER */
const VER = 'pk-v5';
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon.svg',
               './vendor/qrcode.js', './vendor/zxing.min.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VER).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const url = new URL(r.url);
  if (url.origin !== location.origin) return;           // CDN 走网络，不缓存
  e.respondWith(
    caches.open(VER).then(async cache => {
      const hit = await cache.match(r, { ignoreSearch: true });
      const net = fetch(r).then(res => { if (res && res.ok) cache.put(r, res.clone()); return res; })
                          .catch(() => hit);
      return hit || net;
    })
  );
});
