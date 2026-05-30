/* ============================================================
   BlinPlay Service Worker — cache offline para signage
   - Mídia (imagens/vídeos do Storage): cache-first, persistente
   - Página do player + libs: stale-while-revalidate
   - Programação (RPC): sempre rede; o player guarda o último
     resultado bom por conta própria (não cacheamos POST aqui)
   ============================================================ */

const VERSION    = 'blinplay-v1';
const APP_CACHE  = 'app-' + VERSION;     // shell do player (html, sdk)
const MEDIA_CACHE = 'media-v1';          // mídias (persiste entre versões)

// arquivos do "shell" que valem a pena pré-cachear
const APP_ASSETS = [
  './player.html',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (e) => {
  // ativa a versão nova imediatamente
  self.skipWaiting();
  e.waitUntil(
    caches.open(APP_CACHE).then(c => c.addAll(APP_ASSETS).catch(()=>{}))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    // limpa caches de app antigos (mantém o de mídia)
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k.startsWith('app-') && k !== APP_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

// mensagem pra forçar atualização / limpar (escape hatch)
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') self.skipWaiting();
  if (e.data === 'clearMedia') caches.delete(MEDIA_CACHE);
});

function isMedia(url) {
  return url.includes('/storage/v1/object/public/blinplay-media/');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = req.url;

  // só lidamos com GET
  if (req.method !== 'GET') return;

  // ---- MÍDIA: cache-first (toca offline, baixa 1x) ----
  if (isMedia(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(MEDIA_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;                  // já temos: serve do disco
      try {
        const resp = await fetch(req);
        // só cacheia respostas boas
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      } catch (err) {
        // sem rede e sem cache: devolve erro (o player pula o item)
        return new Response('', { status: 504 });
      }
    })());
    return;
  }

  // ---- SHELL (player.html, sdk): stale-while-revalidate ----
  if (APP_ASSETS.some(a => url.indexOf(a.replace('./','')) !== -1) || url.endsWith('player.html')) {
    e.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      const hit = await cache.match(req);
      const net = fetch(req).then(resp => {
        if (resp && resp.ok) cache.put(req, resp.clone());
        return resp;
      }).catch(() => null);
      return hit || (await net) || new Response('', { status: 504 });
    })());
    return;
  }

  // demais requisições: rede normal (RPC, etc.)
});
