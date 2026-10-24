// 당근 득템 앱: 항상 인터넷에서 최신 목록을 먼저 받고, 안 되면(지하철 등) 마지막으로 본 목록을 보여준다.
var CACHE = 'daangn-v1';

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || !url.pathname.endsWith('/daangn.html')) return;
  e.respondWith(
    fetch(e.request, {cache: 'no-store'}).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put('daangn.html', copy); });
      return res;
    }).catch(function () {
      return caches.match('daangn.html');
    })
  );
});
