/* ============================================================
   BlinPlay Service Worker - v4 (24/7 offline, memória constante)

   MUDANÇA CENTRAL EM RELAÇÃO AO v3
   --------------------------------
   O v3 servia Range fatiando um arrayBuffer() do arquivo INTEIRO.
   Cada requisição Range de vídeo carregava o arquivo todo na RAM.
   Como o <video> dispara muitas requisições Range por reprodução e
   recomeça a cada volta do rodízio, o consumo crescia sem limite até
   o Android matar o processo. Em regime 24/7 isso é fatal.

   O v4 fatia POR STREAMING: lê o corpo cacheado em pedaços, descarta
   o que está antes da janela pedida, emite só a janela e cancela o
   leitor. O pico de memória é o tamanho de um pedaço (dezenas de KB),
   independente do tamanho do vídeo. Crescimento zero por ciclo.

   Também removido: todo `resp.clone()` cujo segundo ramo nunca era
   lido. Clonar uma Response e não consumir um dos ramos faz o corpo
   inteiro ser bufferizado em memória — era uma segunda fonte de
   vazamento no v3.

   COMPORTAMENTO
   -------------
   - Mídia: CACHE PRIMEIRO, sempre. Online e offline percorrem o mesmo
     caminho. A rede só serve para ENCHER o cache (em segundo plano) e
     para atender a primeiríssima exibição de um arquivo ainda não
     baixado. Depois de cacheado, a rede não é mais tocada.
   - Revalidação: o player manda a lista de mídias a cada sync. O SW
     compara ETag/tamanho por HEAD e rebaixa só o que mudou no portal.
     É assim que "trocar a mídia no portal" se propaga sem reload.
   - Shell (player.html, sdk): rede primeiro, cache como rede de
     segurança — com ignoreSearch, para que um reload OFFLINE de
     player.html?code=NNNNNN encontre o shell cacheado.
   - Cota: falha de escrita é capturada, a entrada parcial é apagada e
     o download é reagendado. Nunca fica entrada meio-gravada.
   ============================================================ */
const VERSION     = 'blinplay-v10';
const APP_CACHE   = 'app-' + VERSION;
const MEDIA_CACHE = 'media-v1';      // preservado entre versões

/* B4/C3 — config.js e supabase.js passaram a ser arquivos próprios. Sem eles
   no cache, um boot offline não teria as credenciais nem a biblioteca, e o
   modo local do player (C4) nunca seria alcançado. */
const APP_ASSETS = [
  './player.html',
  './config.js',
  './supabase.js'
];

/* tamanho total por URL. Evita reler o arquivo para descobrir o total
   em cada Range. Memória: alguns bytes por mídia. */
const tamanhos = new Map();
/* downloads em andamento, para não baixar o mesmo arquivo em paralelo */
const inflight = new Map();
/* ETag por URL, para detectar mídia trocada no portal */
const etags = new Map();

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(APP_CACHE).then(c => c.addAll(APP_ASSETS).catch(()=>{})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => {
      if (k.startsWith('app-') && k !== APP_CACHE) return caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

/* Quando o APK tem armazenamento nativo, o SW SAI da frente da midia:
   quem serve os bytes e o Kotlin, a partir de arquivo do app. O SW
   continua cuidando apenas do shell (player.html, sdk). */
let NATIVO = false;

self.addEventListener('message', (e) => {
  const d = e.data;
  if (d === 'skipWaiting') { self.skipWaiting(); return; }
  if (d && d.tipo === 'nativo') { NATIVO = true; return; }
  if (d === 'clearMedia')  { caches.delete(MEDIA_CACHE); tamanhos.clear(); return; }
  if (d && d.tipo === 'revalidar' && Array.isArray(d.urls)) {
    e.waitUntil(revalidarLista(d.urls));
  }
});

/* Antes estas duas funções decidiam por substring na URL INTEIRA. Uma URL de
   outro domínio contendo o trecho procurado era aceita como nossa: o Service
   Worker buscava e guardava conteúdo de terceiro no nosso cache, e passava a
   servi-lo dentro da origem do player. Agora a origem é verificada primeiro. */
const ORIGEM_STORAGE = 'https://wjyaxmbkdjebulosdtds.supabase.co';
const ORIGEM_CDN     = 'https://cdn.jsdelivr.net';

function partes(url) {
  try { return new URL(url); } catch (e) { return null; }
}

function isMedia(url) {
  const u = partes(url);
  if (!u) return false;
  if (u.origin !== ORIGEM_STORAGE) return false;
  return u.pathname.startsWith('/storage/v1/object/public/blinplay-media/');
}

function isShell(url) {
  const u = partes(url);
  if (!u) return false;
  if (u.origin === self.location.origin) {
    return u.pathname.endsWith('/player.html')
        || u.pathname.endsWith('/config.js')
        || u.pathname.endsWith('/supabase.js');
  }
  // CDN de reserva do supabase-js, apenas na origem esperada
  return u.origin === ORIGEM_CDN && u.pathname.includes('supabase-js');
}

/* ---------- download do arquivo inteiro, sem clone e com cota tratada ---------- */
function baixarInteiro(cache, url) {
  if (inflight.has(url)) return inflight.get(url);
  const p = (async () => {
    try {
      // fetch por string = requisição nova SEM Range -> 200 completo e cacheável
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp || resp.status !== 200) return false;
      const cl  = resp.headers.get('Content-Length');
      const tag = resp.headers.get('ETag');
      try {
        // sem clone(): o corpo vai direto pro cache, nada é bufferizado
        await cache.put(url, resp);
      } catch (err) {
        // QuotaExceededError ou falha de escrita: não deixa entrada parcial
        try { await cache.delete(url); } catch (e) {}
        tamanhos.delete(url);
        return false;
      }
      if (cl && !isNaN(+cl) && +cl > 0) tamanhos.set(url, +cl);
      if (tag) etags.set(url, tag);
      return true;
    } catch (err) {
      return false;
    } finally {
      inflight.delete(url);
    }
  })();
  inflight.set(url, p);
  return p;
}

/* ---------- tamanho total, sem carregar o arquivo na memória ---------- */
async function tamanhoTotal(cache, url) {
  if (tamanhos.has(url)) return tamanhos.get(url);
  const r = await cache.match(url);
  if (!r) return null;
  const cl = r.headers.get('Content-Length');
  if (cl && !isNaN(+cl) && +cl > 0) { tamanhos.set(url, +cl); return +cl; }
  // sem Content-Length: conta por streaming (memória constante, só I/O)
  try {
    let n = 0;
    const rd = r.body.getReader();
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      n += value.byteLength;
    }
    if (n > 0) { tamanhos.set(url, n); return n; }
  } catch (e) {}
  return null;
}

/* ---------- fatiamento por STREAMING: o coração da correção ----------
   Lê o corpo cacheado em pedaços. Pula o que está antes de `start`,
   emite [start..end] e cancela o leitor. Pico de memória = 1 pedaço. */
function fatiarStream(body, start, end) {
  const reader = body.getReader();
  let pos = 0;
  let encerrado = false;
  const fim = () => {
    if (encerrado) return;
    encerrado = true;
    reader.cancel().catch(()=>{});
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { controller.close(); return; }
          const len = value.byteLength;
          const ini = pos, ult = pos + len - 1;
          pos += len;

          if (ult < start) continue;                 // pedaço ainda antes da janela
          if (ini > end) { fim(); controller.close(); return; }

          const de  = Math.max(0, start - ini);
          const ate = Math.min(len, end - ini + 1);
          controller.enqueue(value.subarray(de, ate));

          if (ult >= end) { fim(); controller.close(); return; }
          return;   // devolve o controle; o próximo pull continua de onde parou
        }
      } catch (err) {
        fim();
        controller.error(err);
      }
    },
    cancel() { fim(); }
  });
}

function lerRange(range, total) {
  let start, end;
  const m = /bytes=(\d*)-(\d*)/.exec(range || '');
  if (m) {
    const a = m[1], b = m[2];
    if (a === '' && b !== '') {                 // sufixo: últimos N bytes
      const n = parseInt(b, 10);
      start = Math.max(0, total - (isNaN(n) ? total : n));
      end   = total - 1;
    } else {
      start = a === '' ? 0         : parseInt(a, 10);
      end   = b === '' ? total - 1 : parseInt(b, 10);
    }
  } else {
    start = 0; end = total - 1;
  }
  if (isNaN(start)) start = 0;
  if (isNaN(end) || end >= total) end = total - 1;
  return { start, end };
}

async function serveMedia(req) {
  const cache = await caches.open(MEDIA_CACHE);
  const url   = req.url;
  const range = req.headers.get('range');

  let hit = await cache.match(url);

  /* ---- ainda não temos o arquivo ---- */
  if (!hit) {
    const baixando = baixarInteiro(cache, url);

    if (range) {
      // ONLINE: atende esta requisição pela rede (streaming, sem buffer),
      // enquanto o arquivo inteiro é baixado para o cache em paralelo.
      try { return await fetch(req); }
      catch (e) {
        // OFFLINE e sem cache: única saída é esperar o download (que vai falhar)
        const ok = await baixando;
        if (!ok) return new Response('', { status: 504 });
        hit = await cache.match(url);
        if (!hit) return new Response('', { status: 504 });
      }
    } else {
      const ok = await baixando;
      if (!ok) {
        try { return await fetch(req); }
        catch (e) { return new Response('', { status: 504 }); }
      }
      hit = await cache.match(url);
      if (!hit) return new Response('', { status: 504 });
      return hit;                      // sem clone
    }
  }

  /* ---- servindo do cache ---- */
  if (!range) return hit;

  const total = await tamanhoTotal(cache, url);
  if (!total) {
    // entrada inutilizável: descarta para ser rebaixada quando houver rede
    try { await cache.delete(url); } catch (e) {}
    tamanhos.delete(url);
    return new Response('', { status: 504 });
  }

  const { start, end } = lerRange(range, total);
  if (start > end || start < 0 || start >= total) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + total }
    });
  }

  const fresco = await cache.match(url);     // corpo novo, não consumido
  if (!fresco || !fresco.body) return new Response('', { status: 504 });

  const headers = new Headers();
  headers.set('Content-Type',   fresco.headers.get('Content-Type') || 'video/mp4');
  headers.set('Content-Range',  'bytes ' + start + '-' + end + '/' + total);
  headers.set('Accept-Ranges',  'bytes');
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Cache-Control',  'no-store');

  return new Response(fatiarStream(fresco.body, start, end), {
    status: 206, statusText: 'Partial Content', headers
  });
}

/* ---------- revalidação: mídia trocada no portal ----------
   HEAD barato por arquivo. Se ETag ou tamanho mudou, apaga e rebaixa.
   Se não há rede, falha em silêncio e o cache atual continua tocando. */
async function revalidarLista(urls) {
  const cache = await caches.open(MEDIA_CACHE);
  for (const url of urls) {
    try {
      const tem = await cache.match(url);
      if (!tem) { await baixarInteiro(cache, url); continue; }

      const h = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!h || !h.ok) continue;

      const tagNovo = h.headers.get('ETag');
      const clNovo  = h.headers.get('Content-Length');
      const tagVelho = etags.get(url) || tem.headers.get('ETag');
      const clVelho  = tamanhos.get(url) || tem.headers.get('Content-Length');

      const mudouTag = tagNovo && tagVelho && tagNovo !== tagVelho;
      const mudouCl  = clNovo && clVelho && String(clNovo) !== String(clVelho);

      if (mudouTag || mudouCl) {
        await cache.delete(url);
        tamanhos.delete(url);
        etags.delete(url);
        await baixarInteiro(cache, url);
      }
    } catch (e) { /* sem rede: mantém o cache */ }
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = req.url;

  if (req.method !== 'GET') return;           // POST/RPC: rede direta

  // midia nativa: nao intercepta, deixa a WebView entregar do disco do app
  if (isMedia(url) && NATIVO) return;
  if (isMedia(url)) { e.respondWith(serveMedia(req)); return; }

  if (isShell(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const resp = await fetch(req, { cache: 'no-store' });
        if (resp && resp.ok) { try { await cache.put(req, resp.clone()); } catch (e) {} }
        return resp;
      } catch (err) {
        // OFFLINE: tenta a URL exata e, se não houver, ignora a query string.
        // Sem isso, um reload offline de player.html?code=NNNNNN dá tela branca.
        let hit = await cache.match(req);
        if (!hit) hit = await cache.match(req, { ignoreSearch: true });
        if (!hit) hit = await cache.match('./player.html', { ignoreSearch: true });
        return hit || new Response('', { status: 504 });
      }
    })());
    return;
  }
});
