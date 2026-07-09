/* ============================================================
   BlinPlay Service Worker - v3 (mídia offline de verdade)
   - Player/SDK (shell): REDE PRIMEIRO. Sempre pega a versão nova
     quando online; cai pro cache só se a rede falhar (offline).
   - Mídia (imagens/vídeos do Storage): cacheia o ARQUIVO INTEIRO
     (fetch CORS, resposta 200 completa) e serve offline. Quando o
     player pede um pedaço via Range (vídeo), fatiamos do cache e
     devolvemos 206 Partial Content. Isso conserta o vídeo que só
     tocava online e caía ao perder a rede.
   - Programação (RPC) e demais POSTs: rede direta, sem cache.

   Nota técnica: a Cache API NÃO aceita guardar resposta 206, e
   requisição de vídeo vem com header Range. Por isso baixamos o
   arquivo inteiro (sem repassar Range) e fatiamos nós mesmos.
   ============================================================ */
const VERSION     = 'blinplay-v3';
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
  if (e.data === 'clearMedia')  caches.delete(MEDIA_CACHE);
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

/* ---- download do arquivo inteiro, com dedupe de chamadas simultâneas ----
   O vídeo dispara VÁRIAS requisições Range em rajada. Sem dedupe, cada
   cache-miss começaria um download completo em paralelo. Guardamos a
   Promise em andamento por URL e reaproveitamos. */
const inflight = new Map();
function baixarInteiro(cache, url) {
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    try {
      // fetch por string = requisição CORS nova, SEM Range -> 200 completo
      const resp = await fetch(url);
      if (resp && resp.status === 200) {
        await cache.put(url, resp.clone());
        return resp;
      }
      return null;
    } catch (err) {
      return null;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

/* ---- fatia o arquivo inteiro cacheado e devolve 206 Partial Content ---- */
async function fatiar(full, range) {
  const buf   = await full.clone().arrayBuffer();
  const total = buf.byteLength;

  let start, end;
  const m = /bytes=(\d*)-(\d*)/.exec(range || '');
  if (m) {
    const a = m[1], b = m[2];
    if (a === '' && b !== '') {           // sufixo: últimos N bytes
      const n = parseInt(b, 10);
      start = Math.max(0, total - (isNaN(n) ? total : n));
      end   = total - 1;
    } else {
      start = a === '' ? 0            : parseInt(a, 10);
      end   = b === '' ? total - 1    : parseInt(b, 10);
    }
  } else {
    start = 0; end = total - 1;
  }
  if (isNaN(start)) start = 0;
  if (isNaN(end) || end >= total) end = total - 1;

  if (start > end || start < 0 || start >= total) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + total }
    });
  }

  const chunk = buf.slice(start, end + 1);
  const headers = new Headers();
  headers.set('Content-Type',   full.headers.get('Content-Type') || 'video/mp4');
  headers.set('Content-Range',  'bytes ' + start + '-' + end + '/' + total);
  headers.set('Accept-Ranges',  'bytes');
  headers.set('Content-Length', String(chunk.byteLength));
  return new Response(chunk, { status: 206, statusText: 'Partial Content', headers });
}

async function serveMedia(req) {
  const cache = await caches.open(MEDIA_CACHE);
  const range = req.headers.get('range');
  const url   = req.url;

  let full = await cache.match(url);

  if (!full) {
    // ainda não temos o arquivo. Começa (ou reaproveita) o download inteiro
    // pra encher o cache e funcionar offline nas próximas voltas.
    const baixando = baixarInteiro(cache, url);

    if (range) {
      // ONLINE: atende ESTA requisição já pela rede (repassa o Range),
      // sem travar a primeira exibição enquanto o arquivo inteiro baixa.
      try {
        return await fetch(req);
      } catch (e) {
        // OFFLINE e sem cache: última tentativa é esperar o download.
        full = await baixando;
        if (!full) return new Response('', { status: 504 });
        // se por acaso baixou, cai pro fatiamento abaixo
      }
    } else {
      // requisição sem Range (imagem ou pré-carregamento): espera cachear.
      full = await baixando;
      if (!full) {
        try { return await fetch(req); }
        catch (e) { return new Response('', { status: 504 }); }
      }
      return full.clone();
    }
  }

  // temos o arquivo inteiro cacheado
  if (!range) return full.clone();
  return await fatiar(full, range);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = req.url;

  if (req.method !== 'GET') return;   // POST/RPC: rede direta

  // ---- MÍDIA: cacheia inteiro + serve Range do cache (offline real) ----
  if (isMedia(url)) {
    e.respondWith(serveMedia(req));
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
