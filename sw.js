/* 智能云端记账本 2.2 PWA: only install icons/offline help. NEVER cache bank/account/API responses. */
const CACHE='cloud-accounting-static-v2-2-1';
const PRECACHE=['./offline.html','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png','./icons/apple-touch-icon.png'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(Promise.all([
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('cloud-accounting-static-')&&k!==CACHE).map(k=>caches.delete(k)))),
    self.clients.claim()
  ]));
});
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET'||req.mode!=='navigate')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin||!url.pathname.startsWith('/wangye/'))return;
  // Network-only for live app navigation. On failure, show a safe offline message.
  event.respondWith(fetch(req).catch(()=>caches.match('./offline.html')));
});
