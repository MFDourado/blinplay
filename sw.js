/* ============================================================
   BlinPlay Service Worker — v2 (network-first no shell)
   - Player/SDK (shell): REDE PRIMEIRO. Sempre pega a versão nova
     quando online; cai pro cache só se a rede falhar (offline).
   - Mídia (imagens/vídeos do Storage): cache-first, persiste.
   - Programação (RPC) e demais POSTs: rede direta, sem cache.
   Esta estratégia garante que atualizações de código cheguem
   sozinhas nos boxes, sem limpar cache na mão.
   ============================================================ */

const VERSION     = 'blinplay-v2';
const APP_CACHE   = 'app-' + VERSION;   // shell (html, sdk)
const MEDIA_CACHE = 'media-v1';         // mídias (persiste entre versões)

const APP_ASSETS = [
  './player.html',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (e) => {
  // assume o controle imediatamente, sem esperar abas antigas fecharem
  self.skipWaiting();
  e.waitUntil(
    caches.open(APP_CACHE).then(c => c.addAll(APP_ASSETS).catch(()=>{}))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // remove caches de app antigos (mantém o de mídia)
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k.startsWith('app-') && k !== APP_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'clearMedia') caches.delete(MEDIA_CACHE);
});

function isMedia(url) {
  return url.includes('/storage/v1/object/public/blinplay-media/');
}

function isShell(url) {
  if (url.endsWith('player.html')) return true;
  if (url.indexOf('player.html?') !== -1) return true;
  if (url.indexOf('supabase-js') !== -1) return true;
  return false;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = req.url;

  if (req.method !== 'GET') return;   // POST/RPC: rede direta

  // ---- MÍDIA: cache-first (toca offline, baixa 1x) ----
  if (isMedia(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(MEDIA_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      } catch (err) {
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // ---- SHELL (player.html, sdk): NETWORK-FIRST ----
  // tenta a rede; se vier, usa e atualiza o cache. Só usa cache se offline.
  if (isShell(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const resp = await fetch(req, { cache: 'no-store' });
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      } catch (err) {
        const hit = await cache.match(req);
        return hit || new Response('', { status: 504 });
      }
    })());
    return;
  }

  // demais: rede normal
});
