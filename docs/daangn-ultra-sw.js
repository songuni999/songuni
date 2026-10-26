// 갤럭시 울트라 앱: 항상 인터넷에서 최신 목록을 먼저 받고, 안 되면(지하철 등) 마지막으로 본 목록을 보여준다.
var CACHE = 'daangn-ultra-v1';
var PAGES = ['daangn-ultra.html'];   // 울트라 창만

self.addEventListener('install', function (e) { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  var page = url.pathname.split('/').pop();
  if (e.request.method !== 'GET' || url.origin !== location.origin || PAGES.indexOf(page) < 0) return;
  e.respondWith(
    fetch(e.request, {cache: 'no-store'}).then(function (res) {
      var copy = res.clone();
      caches.open(CACHE).then(function (c) { c.put(page, copy); });
      return res;
    }).catch(function () {
      return caches.match(page);
    })
  );
});
