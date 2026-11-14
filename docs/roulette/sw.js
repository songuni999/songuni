const C='bbr-Ogs9f90f';
const FILES=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(FILES)));self.skipWaiting();});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))));self.clients.claim();});
// 네트워크 먼저(고친 게 바로 반영), 안 되면 저장해 둔 것(오프라인). 글꼴(Jua)도 한 번 받으면 저장
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
  e.respondWith(fetch(e.request).then(res=>{
    if(res.ok&&(e.request.url.startsWith(self.location.origin)||e.request.url.includes('fonts.g'))){const cp=res.clone();caches.open(C).then(c=>c.put(e.request,cp));}
    return res;}).catch(()=>caches.match(e.request).then(r=>r||caches.match('index.html'))));});
